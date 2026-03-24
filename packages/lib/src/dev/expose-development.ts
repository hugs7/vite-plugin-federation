// *****************************************************************************
// Copyright (C) 2022 Origin.js and others.
//
// This program and the accompanying materials are licensed under Mulan PSL v2.
// You can use this software according to the terms and conditions of the Mulan PSL v2.
// You may obtain a copy of Mulan PSL v2 at:
//          http://license.coscl.org.cn/MulanPSL2
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
// EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
// MERCHANTABILITY OR FIT FOR A PARTICULAR PURPOSE.
// See the Mulan PSL v2 for more details.
//
// SPDX-License-Identifier: MulanPSL-2.0
// *****************************************************************************

import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { createRequire } from 'module';
import { join, resolve } from 'path';
import type { VitePluginFederationOptions } from 'types';
import type { UserConfig } from 'vite';

import type { PluginHooks } from '../../types/pluginHooks';
import { parsedOptions } from '../public';
import {
  FEDERATION_DEBUG_SNIPPET_ESM,
  FEDERATION_IMPORT_SNIPPET
} from '../runtime-snippets';
import {
  NAME_CHAR_REG,
  parseExposeOptions,
  removeNonRegLetter
} from '../utils';

/**
 * Detect whether a resolved module file is CJS (uses require/module.exports).
 * CJS modules must stay pre-bundled so the dep optimizer converts them to ESM.
 */
const isCjsFile = (filePath: string): boolean => {
  if (filePath.endsWith('.mjs')) return false;
  if (filePath.endsWith('.cjs')) return true;

  // Infer module type via presence of cjs syntax
  try {
    const head = readFileSync(filePath, 'utf-8').slice(0, 2000);
    return /\brequire\s*\(/.test(head) || /\bmodule\.exports\b/.test(head);
  } catch {
    return false;
  }
};

/**
 * Statically extract ESM export names from a file using es-module-lexer,
 * run in a subprocess so the async `init()` can complete before `parse()`.
 * This doesn't execute the module, so it works even when the module
 * references browser-only globals like `window` at the top level.
 */
const getExportNamesStatically = (resolvedPath: string): string[] => {
  try {
    const script = [
      "const{init,parse}=require('es-module-lexer');",
      "const fs=require('fs');",
      'init.then(()=>{',
      "const code=fs.readFileSync(process.argv[1],'utf-8');",
      'const[,exp]=parse(code);',
      "const names=exp.map(e=>typeof e==='string'?e:e.n).filter(Boolean);",
      'console.log(JSON.stringify(names));',
      '});'
    ].join('');

    const result = execSync(`node -e "${script}" -- "${resolvedPath}"`, {
      encoding: 'utf-8',
      timeout: 10000,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    return JSON.parse(result.trim());
  } catch {
    return [];
  }
};

const getModuleExportNames = (name: string, root: string): string[] => {
  try {
    const result = execSync(
      `node --input-type=module -e "import('${name}').then(m => console.log(JSON.stringify(Object.keys(m))))"`,
      {
        cwd: root,
        encoding: 'utf-8',
        timeout: 10000,
        stdio: ['pipe', 'pipe', 'pipe']
      }
    );

    return JSON.parse(result.trim());
  } catch {
    // Dynamic import failed — fall back to static analysis
  }

  try {
    const nodeRequire = createRequire(join(root, 'package.json'));
    const resolvedPath = nodeRequire.resolve(name);
    return getExportNamesStatically(resolvedPath);
  } catch {
    return [];
  }
};

/** Metadata for a shared virtual module */
interface SharedModuleMeta {
  /** Vite-serveable URL for the real local module (/@fs/... or root-relative) */
  localUrl: string;
  /** Enumerated export names */
  exports: string[];
  /** Whether this module's entry point is CJS */
  isCjs?: boolean;
  /** Pre-bundled dep URL (e.g. /node_modules/.vite/deps/react.js) for CJS fallback */
  depUrl?: string;
}

/**
 * Build ESM wrapper code for a shared virtual module.
 * At runtime, checks globalThis.__federation_shared_modules__ first (set by
 * the host's init()), falling back to a dynamic import of the local package.
 */
const buildSharedWrapperCode = (
  name: string,
  meta: SharedModuleMeta,
  originUrl?: string
): string => {
  const named = meta.exports.filter((e) => e !== 'default');
  const hasDefault = meta.exports.includes('default');

  // CJS modules use the pre-bundled dep URL (browsers can't load raw CJS).
  // ESM modules use localUrl with ?__fed_raw to bypass our URL interception middleware.
  const baseUrl =
    meta.isCjs && meta.depUrl ? meta.depUrl : meta.localUrl + '?__fed_raw';
  // When originUrl is provided, prefix the import URL so the browser
  // fetches from this dev server, not the host page's origin.
  const importUrl = originUrl ? `${originUrl}${baseUrl}` : baseUrl;

  let code = '';
  code += `const __shared = globalThis.__federation_shared_modules__?.[${JSON.stringify(name)}];\n`;
  code += `const __mod = __shared ?? await import(/* @vite-ignore */ ${JSON.stringify(importUrl)});\n`;

  if (hasDefault) {
    code += `export default (__mod.default ?? __mod);\n`;
  }
  for (const e of named) {
    if (VALID_JS_IDENTIFIER.test(e)) {
      code += `export const ${e} = __mod[${JSON.stringify(e)}];\n`;
    }
  }

  return code;
};

/** Map of shared specifier -> metadata, populated in config() */
const sharedModuleMeta = new Map<string, SharedModuleMeta>();

// Convert an absolute filesystem path to a URL that Vite's dev server
// can serve.  If the path is inside the project root, return a root-
// relative path; otherwise use /@fs/ prefix.
const toViteUrl = (filePath: string, root: string): string => {
  const normalized = filePath.replace(/\\/g, '/');
  const normalizedRoot = root.replace(/\\/g, '/').replace(/\/$/, '');
  if (normalized.startsWith(normalizedRoot + '/')) {
    return normalized.slice(normalizedRoot.length);
  }
  return `/@fs${normalized}`;
};

/** Regex matching valid JavaScript identifiers */
const VALID_JS_IDENTIFIER = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/;

/** Convert a bare specifier to its pre-bundled dep URL under .vite/deps/ */
const toPrebundledDepUrl = (specifier: string): string =>
  `/node_modules/.vite/deps/${specifier.replace(/\//g, '_')}.js`;

/** Extract the base package name from a bare specifier (handles scoped packages) */
const getBasePackageName = (specifier: string): string => {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
};

/** Get the origin URL for the dev server from resolved config */
const getServerOrigin = (server: {
  config: { server: { port?: number; https?: any; host?: string | boolean } };
}): string => {
  const { port = 5173, https, host } = server.config.server;
  const protocol = https ? 'https' : 'http';
  const hostname =
    typeof host === 'string' && host !== '0.0.0.0' && host !== '::'
      ? host
      : 'localhost';
  return `${protocol}://${hostname}:${port}`;
};

/** Strip query string from a URL */
const stripQuery = (url: string): string => url.split('?')[0];

/**
 * Resolve a shared module specifier and build its metadata.
 * Returns null if the specifier cannot be resolved.
 */
const createSharedMeta = (
  specifier: string,
  nodeRequire: NodeRequire,
  root: string,
  requireExports = false
): SharedModuleMeta | null => {
  try {
    const realPath = nodeRequire.resolve(specifier);
    const localUrl = toViteUrl(realPath, root);
    const exports = getModuleExportNames(specifier, root);
    if (requireExports && exports.length === 0) return null;
    const cjs = isCjsFile(realPath);
    const meta: SharedModuleMeta = { localUrl, exports, isCjs: cjs };
    if (cjs) {
      meta.depUrl = toPrebundledDepUrl(specifier);
    }
    return meta;
  } catch {
    return null;
  }
};

export const devExposePlugin = (
  options: VitePluginFederationOptions
): PluginHooks => {
  parsedOptions.devExpose = parseExposeOptions(options);

  // Build list of shared module names for init code generation
  const sharedList: string[] = [];
  // Modules actually excluded from dep optimization (only these get
  // wrapper/patch treatment in middleware and transform)
  const excludedShared = new Set<string>();
  // CJS sub-deps of excluded modules that need force-inclusion
  const cjsSubDeps = new Set<string>();
  let resolvedRoot = process.cwd();

  const exposeEntries = parsedOptions.devExpose.map((item) => {
    const sanitized = removeNonRegLetter(item[0], NAME_CHAR_REG);
    return `${JSON.stringify(item[0])}: './__federation_expose_${sanitized}.js'`;
  });

  return {
    name: 'hugs7:expose-development',
    virtualFile: {
      [`__remoteEntryHelper__${options.filename}`]: `
${FEDERATION_DEBUG_SNIPPET_ESM}
const _logInit = __fed_debug('federation:init');
const _logGet = __fed_debug('federation:get');
${FEDERATION_IMPORT_SNIPPET}
const exportSet = new Set(['Module', '__esModule', 'default', '_export_sfc']);

const __federation_expose_loader = (url) => () =>
  __federation_import(url).then(module =>
    Object.keys(module).every(k => exportSet.has(k)) ? () => module.default : () => module
  );

const moduleMap = Object.fromEntries(
  Object.entries({${exposeEntries.join(',')}}).map(([key, url]) => [key, __federation_expose_loader(url)])
);

let __federation_shared_resolving;
let __federation_dev_client_loaded;
export const init = (shareScope) => {
  globalThis.__federation_shared__= globalThis.__federation_shared__ || {};
  Object.entries(shareScope).forEach(([key, value]) => {
    for (const [versionKey, versionValue] of Object.entries(value)) {
      const scope = versionValue.scope || 'default';
      if (!globalThis.__federation_shared__[scope]) {
        globalThis.__federation_shared__[scope] = {};
      }

      const shared = globalThis.__federation_shared__[scope];
      (shared[key] = shared[key] || {})[versionKey] = versionValue;
    }
  });

  // Kick off async resolution of shared modules. The get() function
  // awaits this before loading exposed modules, so the bridge shims
  // can synchronously read from the global when they evaluate.
  if (!globalThis.__federation_shared_modules__) {
    globalThis.__federation_shared_modules__ = {};
  }
  _logInit('Resolving shared modules:', Object.keys(shareScope));
  __federation_shared_resolving = Promise.all(Object.keys(shareScope).map(async (key) => {
    try {
      const versions = shareScope[key];
      const ver = Object.keys(versions)[0];
      if (ver) {
        const factory = await versions[ver].get();
        const mod = await factory();
        globalThis.__federation_shared_modules__[key] = mod;
        _logInit('Resolved:', key, Object.keys(mod).slice(0,5));
      }
    } catch(e) {
      _logInit('Failed to pre-resolve shared module:', key, e);
    }
  }));

  // Load the remote's @vite/client so HMR updates from the remote
  // dev server are received by this browser tab.  The @vite/client
  // on the remote is patched (by our middleware) to use absolute URLs
  // so HMR module re-imports resolve to the remote origin.
  const remoteOrigin = new URL(import.meta.url).origin;
  if (!globalThis.__federation_dev_clients__) {
    globalThis.__federation_dev_clients__ = new Set();
  }
  if (!globalThis.__federation_dev_clients__.has(remoteOrigin)) {
    globalThis.__federation_dev_clients__.add(remoteOrigin);
    __federation_dev_client_loaded = import(/* @vite-ignore */ remoteOrigin + '/@vite/client');
  }
};

export const get = async (module) => {
  if (__federation_shared_resolving) await __federation_shared_resolving;
  if (__federation_dev_client_loaded) await __federation_dev_client_loaded;
  _logGet(module, 'shared modules populated:', Object.keys(globalThis.__federation_shared_modules__ || {}));
  if(!moduleMap[module]) throw new Error('Can not find remote module ' + module)
  return moduleMap[module]();
};`
    },
    config(config: UserConfig) {
      resolvedRoot = config.root ? resolve(config.root) : process.cwd();

      // Only set up shared wrappers when this is a remote with shared modules
      if (!parsedOptions.devExpose.length || !parsedOptions.devShared.length) {
        return;
      }

      const root = resolvedRoot;
      const nodeRequire = createRequire(join(root, 'package.json'));

      // Populate sharedList and discover exports for each shared module
      for (const item of parsedOptions.devShared) {
        const name = item[0];
        sharedList.push(name);

        const meta = createSharedMeta(name, nodeRequire, root);
        if (meta) {
          sharedModuleMeta.set(name, meta);
        }
      }

      // Discover sub-paths of shared modules (e.g. react/jsx-runtime).
      // These are known CJS entry points that need named re-export patching.
      const knownSubPaths = ['/jsx-runtime', '/jsx-dev-runtime', '/client'];
      for (const baseName of sharedList) {
        for (const sub of knownSubPaths) {
          const specifier = baseName + sub;
          if (sharedModuleMeta.has(specifier)) continue;
          const subMeta = createSharedMeta(specifier, nodeRequire, root, true);
          if (subMeta) {
            sharedModuleMeta.set(specifier, subMeta);
          }
        }
      }

      // Determine which shared modules should be excluded from dep
      // optimization.  All non-CJS shared modules are excluded so Vite
      // emits bare-specifier imports that our URL interception middleware
      // can replace with shared wrappers.
      //
      // CJS modules (react, react-dom, react-redux, zustand) MUST stay
      // pre-bundled — browsers can't load raw CJS.  Their `t` factory
      // export is patched by the .vite/deps/ middleware instead.
      for (const name of sharedList) {
        const meta = sharedModuleMeta.get(name);
        if (!meta || meta.isCjs) continue;

        // Exclude this non-CJS module from dep optimization.
        // For modules with relative imports to internal chunks (e.g.
        // react-router → ./chunk-XXX.mjs), the chunks may import CJS
        // packages (cookie, set-cookie-parser).  We force-include those
        // CJS deps via optimizeDeps.include so Vite pre-bundles them
        // before the browser needs them.
        excludedShared.add(name);

        // Scan for CJS sub-deps that need force-inclusion
        try {
          const realPath = nodeRequire.resolve(name);
          const entryDir = realPath.substring(0, realPath.lastIndexOf('/'));
          const src = readFileSync(realPath, 'utf-8');
          // Find relative chunk imports
          const relImports = [...src.matchAll(/from\s+['"](\.\/.+?)['"]/g)].map(
            (m) => m[1]
          );
          // Scan each chunk for bare-specifier imports to non-shared packages.
          // Resolve from the module's own directory (not project root) to
          // find nested deps like react-router/node_modules/cookie/.
          for (const rel of relImports) {
            try {
              const chunkSrc = readFileSync(join(entryDir, rel), 'utf-8');
              const bareDeps = [
                ...chunkSrc.matchAll(/from\s+['"]([^'"./][^'"]*)['"]/g)
              ].map((m) => m[1]);
              for (const dep of bareDeps) {
                const pkg = getBasePackageName(dep);
                if (sharedList.includes(pkg)) continue;
                // Any non-shared bare import from an excluded module's
                // internal chunk must be force-included for pre-bundling.
                // Without this, Vite serves the raw CJS file which
                // browsers can't parse.
                cjsSubDeps.add(pkg);
              }
            } catch {
              /* can't read chunk */
            }
          }
        } catch {
          /* can't read module */
        }
      }

      if (excludedShared.size > 0) {
        config.optimizeDeps ??= {};
        config.optimizeDeps.exclude = [
          ...(config.optimizeDeps.exclude ?? []),
          ...excludedShared
        ];
        // Force-include CJS sub-deps of excluded modules so they're
        // pre-bundled before the browser encounters them.
        if (cjsSubDeps.size > 0) {
          config.optimizeDeps.include = [
            ...(config.optimizeDeps.include ?? []),
            ...cjsSubDeps
          ];
        }
      }
    },

    configureServer(server) {
      // Intercept requests for pre-bundled shared modules in .vite/deps/.
      // CJS shared modules (react, react-dom, react-redux, zustand) are
      // kept pre-bundled.  Their pre-bundled output has:
      //   export default require_xxx();
      //   export { require_xxx as t };
      // We patch these to check globalThis.__federation_shared_modules__
      // first, and re-export the `t` factory to return the shared instance.
      // This ensures other pre-bundled deps importing `{ t }` from react.js
      // also get the host's shared instance.
      if (sharedModuleMeta.size > 0) {
        server.middlewares.use(async (req, res, next) => {
          const url = req.url;
          if (!url || !url.includes('.vite/deps/')) {
            next();
            return;
          }

          const urlPath = stripQuery(url);
          const depsMatch = urlPath.match(
            /\/node_modules\/\.vite\/deps\/(.+)\.js$/
          );
          if (!depsMatch) {
            next();
            return;
          }
          const fileName = depsMatch[1];

          // Match against all shared modules (not just excluded ones).
          // Pre-bundled CJS modules need patching here.
          let matchedName: string | undefined;
          let matchedMeta: SharedModuleMeta | undefined;
          for (const [name, meta] of sharedModuleMeta) {
            if (name.replace(/\//g, '_') === fileName) {
              matchedName = name;
              matchedMeta = meta;
              break;
            }
          }

          if (!matchedName || !matchedMeta) {
            next();
            return;
          }

          const matchedBase = getBasePackageName(matchedName);

          // Intercept the response: let Vite serve the file normally
          // (with proper import rewriting), then patch the output.
          const origEnd = res.end.bind(res);
          const chunks: Buffer[] = [];

          const ensureBuffer = (chunk: any) =>
            Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);

          res.write = function (chunk: any) {
            chunks.push(ensureBuffer(chunk));
            return true;
          } as any;

          res.end = function (chunk?: any) {
            if (chunk) chunks.push(ensureBuffer(chunks));
            let fileCode = Buffer.concat(chunks).toString('utf-8');

            const exportNames = matchedMeta!.exports.filter(
              (e) =>
                e !== 'default' &&
                e !== 'module.exports' &&
                VALID_JS_IDENTIFIER.test(e)
            );
            const isTopLevel = matchedName === matchedBase;
            const hasDefault = /export default .+;/.test(fileCode);

            if (isTopLevel) {
              // For top-level shared module facades, replace the ENTIRE
              // file with a shared wrapper.  This handles both CJS modules
              // (which have `export default` + `t` factory) and ESM modules
              // (which may only have named re-exports from internal chunks).
              //
              // The wrapper checks __federation_shared_modules__ first.
              // If found, all named exports come from the shared instance.
              // Otherwise, fall back to the original module code.
              //
              // For CJS modules with a `t` factory, we also patch the factory
              // so other pre-bundled deps that import `{ t }` from this module
              // also get the shared instance.
              const sharedName = JSON.stringify(matchedName!);
              const hasFactory = /export \{ .+ as t \};/.test(fileCode);

              if (hasDefault) {
                // CJS pattern: export default require_xxx(); export { require_xxx as t };
                fileCode = fileCode.replace(
                  /export default (.+);/,
                  `const __federation_default = globalThis.__federation_shared_modules__?.[${sharedName}] ?? $1;\nexport default __federation_default;\n` +
                    exportNames
                      .map(
                        (e) =>
                          `export const ${e} = __federation_default[${JSON.stringify(e)}];`
                      )
                      .join('\n')
                );

                if (hasFactory) {
                  fileCode = fileCode.replace(
                    /export \{ .+ as t \};/,
                    `const __federation_t = () => __federation_default;\nexport { __federation_t as t };`
                  );
                }
              } else if (exportNames.length > 0) {
                // ESM pattern: only named re-exports from chunk (e.g. react-router).
                // The facade has: import { a as X, b as Y } from "./chunk.js";
                //                 export { X, Y, Foo as Bar, ... };
                //
                // Strategy: keep the original import (so standalone works),
                // then rewrite the export {} block.  For each export specifier,
                // check the shared module first, falling back to the local binding.
                //
                // Parse the export statement to extract local→exported mappings,
                // because renamed exports like `Action as NavigationType` mean the
                // local variable is `Action`, not `NavigationType`.
                const exportMatch = fileCode.match(/export \{([^}]+)\};/);
                if (exportMatch) {
                  const specifiers = exportMatch[1]
                    .split(',')
                    .map((s) => s.trim())
                    .filter(Boolean);
                  // Parse each specifier: "Foo" or "Foo as Bar"
                  const mappings = specifiers.map((s) => {
                    const parts = s.split(/\s+as\s+/);
                    const local = parts[0].trim();
                    const exported = (parts[1] || parts[0]).trim();
                    return { local, exported };
                  });

                  // Remove original export block
                  fileCode = fileCode.replace(/export \{[^}]+\};/, '');

                  // Append shared-aware re-exports
                  fileCode +=
                    `\nconst __federation_shared = globalThis.__federation_shared_modules__?.[${sharedName}];\n` +
                    mappings
                      .map(({ local, exported }) => {
                        const safeId = `__fed_${exported.replace(/[^a-zA-Z0-9_$]/g, '_')}`;
                        return `const ${safeId} = __federation_shared ? __federation_shared[${JSON.stringify(exported)}] : ${local};\nexport { ${safeId} as ${exported} };`;
                      })
                      .join('\n') +
                    '\n';
                }
              }
            } else if (exportNames.length > 0 && hasDefault) {
              // Sub-path module (e.g. react/jsx-runtime) — patch default only
              const reExports = exportNames
                .map(
                  (e) =>
                    `export const ${e} = __federation_default[${JSON.stringify(e)}];`
                )
                .join('\n');
              fileCode = fileCode.replace(
                /export default (.+);/,
                `const __federation_default = $1;\nexport default __federation_default;\n${reExports}`
              );
            }

            // Remove content-length since we changed the body
            res.removeHeader('content-length');
            res.setHeader('Access-Control-Allow-Origin', '*');
            origEnd(fileCode);
          } as any;

          next();
        });
      }

      // Intercept CJS sub-deps of excluded shared modules.
      // When the fallback path loads an excluded module's chunks from
      // node_modules, those chunks may import CJS packages (e.g. cookie).
      // Browsers can't parse CJS, so we redirect these imports to the
      // pre-bundled ESM versions in .vite/deps/.
      // Match by /node_modules/<pkg>/ in the URL to handle nested deps
      // (e.g. react-router/node_modules/cookie/).
      if (cjsSubDeps.size > 0) {
        server.middlewares.use((req, res, next) => {
          const url = req.url;
          if (!url || !url.includes('/node_modules/')) {
            next();
            return;
          }

          const urlPath = stripQuery(url);
          for (const dep of cjsSubDeps) {
            if (urlPath.includes(`/node_modules/${dep}/`)) {
              const preBundledUrl = toPrebundledDepUrl(dep);
              res.writeHead(302, { Location: preBundledUrl });
              res.end();
              return;
            }
          }
          next();
        });
      }

      // Intercept requests for excluded shared modules served from
      // node_modules (e.g. /@fs/.../sso/build/index.es.js).
      // Vite resolves bare specifiers to file URLs, and we intercept
      // those URLs here — serving a shared wrapper that checks the
      // host's globalThis.__federation_shared_modules__ first.
      if (excludedShared.size > 0) {
        // Build a map: URL path (without query) → shared module name
        const excludedUrlMap = new Map<string, string>();
        for (const name of excludedShared) {
          const meta = sharedModuleMeta.get(name);
          if (meta) {
            excludedUrlMap.set(meta.localUrl, name);
          }
        }
        server.middlewares.use((req, res, next) => {
          const url = req.url;
          if (!url) {
            next();
            return;
          }

          // Skip the fallback URL — __fed_raw is the escape hatch so
          // the wrapper's fallback import loads the REAL module file.
          if (url.includes('__fed_raw')) {
            next();
            return;
          }

          const urlPath = stripQuery(url);
          const matchedName = excludedUrlMap.get(urlPath);
          if (!matchedName) {
            next();
            return;
          }

          const meta = sharedModuleMeta.get(matchedName);
          if (!meta) {
            next();
            return;
          }

          const originUrl = getServerOrigin(server);
          const code = buildSharedWrapperCode(matchedName, meta, originUrl);
          res.setHeader('Content-Type', 'application/javascript');
          res.setHeader('Access-Control-Allow-Origin', '*');
          res.end(code);
        });
      }

      // Add CORS headers to ALL responses so the HOST browser can load
      // source files, @vite/client, dep-optimized chunks, etc. from
      // this remote dev server.
      server.middlewares.use((req, res, next) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', '*');
        res.setHeader('Access-Control-Allow-Headers', '*');
        if (req.method === 'OPTIONS') {
          res.statusCode = 204;
          res.end();
          return;
        }
        next();
      });

      server.middlewares.use(async (req, res, next) => {
        const url = req.url;

        // Serve remoteEntry.js
        if (url === `/${options.filename}`) {
          try {
            const moduleId = `__remoteEntryHelper__${options.filename}`;
            const result = await server.transformRequest(moduleId);
            if (result) {
              res.setHeader('Content-Type', 'application/javascript');
              res.end(result.code);
            } else {
              res.statusCode = 404;
              res.end('Module not found');
            }
          } catch (error) {
            res.statusCode = 500;
            res.end('Internal server error');
          }
          return;
        }

        // Patch @vite/client so HMR module re-imports use the
        // absolute remote origin.  The stock client uses base = "/"
        // which resolves to the HOST page origin in cross-origin
        // federation.  Using an absolute origin works for both
        // standalone and federated modes.
        //
        // Also patch the page-reload debounce to trigger a reload
        // when React Fast Refresh can't handle an update across the
        // federation boundary.  The HMR accept callback in
        // @vitejs/plugin-react calls import.meta.hot.invalidate()
        // when fast refresh fails, which propagates up to a full
        // reload — the patched base ensures the reload check works.
        if (url === '/@vite/client' || url?.startsWith('/@vite/client?')) {
          try {
            const clientResult = await server.transformRequest('/@vite/client');
            if (!clientResult) {
              next();
              return;
            }
            const remoteOrigin = getServerOrigin(server);
            let code = clientResult.code;
            code = code.replace(
              /const base = "\/"\s*\|\|\s*"\/";/,
              `const base = "${remoteOrigin}/";`
            );
            code = code.replace(
              /const base\$1 = "\/"\s*\|\|\s*"\/";/,
              `const base$1 = "${remoteOrigin}/";`
            );
            res.setHeader('Content-Type', 'application/javascript');
            res.end(code);
          } catch (error) {
            next();
          }
          return;
        }

        // Patch /@react-refresh so the MFE re-uses the HOST's
        // refresh runtime singleton (stored on window by the
        // HOST's patched /@react-refresh).  Without this, the
        // MFE has its own allFamiliesByID / mountedRoots maps
        // and performReactRefresh() doesn't trigger re-renders
        // for roots mounted by the HOST's React renderer.
        //
        // In standalone mode (no HOST runtime on window), the
        // MFE's own runtime is loaded and stored globally instead.
        // Patch /@react-refresh: if the HOST already stored its
        // refresh runtime globally, re-export that singleton so
        // all component families and mounted roots are shared.
        // In standalone mode, import the real runtime and store it.
        if (url === '/@react-refresh' || url?.startsWith('/@react-refresh?')) {
          const code = `
import * as _localRuntime from '/@react-refresh-runtime';
// In federation mode the HOST has already stored its runtime
// singleton on window.  Re-use it so all component families
// and mounted roots are tracked in one place.
// In standalone mode, store this runtime for potential future use.
var _rt = (typeof window !== 'undefined' && window.__vite_react_refresh_runtime__) || _localRuntime;
if (typeof window !== 'undefined' && !window.__vite_react_refresh_runtime__) {
  window.__vite_react_refresh_runtime__ = _localRuntime;
}
export var injectIntoGlobalHook = _rt.injectIntoGlobalHook;
export var register = _rt.register;
export var createSignatureFunctionForTransform = _rt.createSignatureFunctionForTransform;
export var isLikelyComponentType = _rt.isLikelyComponentType;
export var getFamilyByType = _rt.getFamilyByType;
export var performReactRefresh = _rt.performReactRefresh;
export var setSignature = _rt.setSignature;
export var collectCustomHooksForSignature = _rt.collectCustomHooksForSignature;
export var validateRefreshBoundaryAndEnqueueUpdate = _rt.validateRefreshBoundaryAndEnqueueUpdate;
export var registerExportsForReactRefresh = _rt.registerExportsForReactRefresh;
export var __hmr_import = _rt.__hmr_import;
export default { injectIntoGlobalHook: _rt.injectIntoGlobalHook };
`;
          res.setHeader('Content-Type', 'application/javascript');
          res.end(code);
          return;
        }

        // Serve the real react-refresh runtime under an alternate
        // URL so the /@react-refresh wrapper can import it.
        if (
          url === '/@react-refresh-runtime' ||
          url?.startsWith('/@react-refresh-runtime?')
        ) {
          try {
            const result = await server.transformRequest('/@react-refresh');
            if (result) {
              res.setHeader('Content-Type', 'application/javascript');
              res.end(result.code);
              return;
            }
          } catch {
            /* fall through */
          }
          next();
          return;
        }

        // Serve exposed modules as re-export stubs that redirect the
        // browser to import the real source file.  Vite then tracks
        // the real file in its module graph and sends HMR updates for it.
        if (url?.includes('__federation_expose_')) {
          try {
            const match = url.match(/__federation_expose_(.+?)\.js/);
            if (match) {
              const exposeName = match[1];
              const exposeItem = parsedOptions.devExpose.find((item) => {
                const itemName = removeNonRegLetter(item[0], NAME_CHAR_REG);
                return itemName === exposeName;
              });
              if (exposeItem && exposeItem[1] && exposeItem[1].import) {
                const modulePath = exposeItem[1].import;
                // Serve a thin re-export stub.  The browser follows
                // the import to the real source file, which Vite serves
                // with HMR metadata.
                const viteUrl = toViteUrl(modulePath, resolvedRoot);
                const code = `export { default } from '${viteUrl}';\nexport * from '${viteUrl}';`;
                res.setHeader('Content-Type', 'application/javascript');
                res.end(code);
              } else {
                res.statusCode = 404;
                res.end(`Expose module not found: ${exposeName}`);
              }
            } else {
              res.statusCode = 400;
              res.end('Invalid expose module URL');
            }
          } catch (error) {
            console.error('Error loading expose module:', error);
            res.statusCode = 500;
            res.end('Internal server error');
          }
          return;
        }

        next();
      });
    }
  };
};
