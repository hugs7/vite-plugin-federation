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

import { execSync } from 'child_process'
import { readFileSync } from 'fs'
import { createRequire } from 'module'
import { join, resolve } from 'path'
import type { VitePluginFederationOptions } from 'types'
import type { UserConfig } from 'vite'
import type { PluginHooks } from '../../types/pluginHooks'
import { parsedOptions } from '../public'
import { NAME_CHAR_REG, parseExposeOptions, removeNonRegLetter } from '../utils'

import { FEDERATION_DEBUG_SNIPPET_ESM } from '../debug'

const SHARED_VIRTUAL_PREFIX = 'virtual:__federation_shared__:'
const RESOLVED_SHARED_PREFIX = '\0' + SHARED_VIRTUAL_PREFIX

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
    ].join('')
    const result = execSync(`node -e "${script}" -- "${resolvedPath}"`, {
      encoding: 'utf-8',
      timeout: 10000,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    return JSON.parse(result.trim())
  } catch {
    return []
  }
}

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
    )
    return JSON.parse(result.trim())
  } catch {
    // Dynamic import failed — fall back to static analysis
  }

  try {
    const nodeRequire = createRequire(join(root, 'package.json'))
    const resolvedPath = nodeRequire.resolve(name)
    return getExportNamesStatically(resolvedPath)
  } catch {
    return []
  }
}

/** Metadata for a shared virtual module */
interface SharedModuleMeta {
  /** Vite-serveable URL for the real local module (/@fs/... or root-relative) */
  localUrl: string
  /** Enumerated export names */
  exports: string[]
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
  const named = meta.exports.filter((e) => e !== 'default')
  const hasDefault = meta.exports.includes('default')

  // When originUrl is provided, prefix the import URL so the browser
  // fetches from this dev server, not the host page's origin.
  const importUrl = originUrl ? `${originUrl}${meta.localUrl}` : meta.localUrl

  let code = ''
  code += `const __shared = globalThis.__federation_shared_modules__?.[${JSON.stringify(name)}];\n`
  code += `const __mod = __shared ?? await import(/* @vite-ignore */ ${JSON.stringify(importUrl)});\n`

  if (hasDefault) {
    code += `export default (__mod.default ?? __mod);\n`
  }
  for (const e of named) {
    // Use safe identifier check — most exports are valid JS identifiers
    if (/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(e)) {
      code += `export const ${e} = __mod[${JSON.stringify(e)}];\n`
    }
  }

  return code
}

/** Map of shared specifier -> metadata, populated in config() */
const sharedModuleMeta = new Map<string, SharedModuleMeta>()

// Convert an absolute filesystem path to a URL that Vite's dev server
// can serve.  If the path is inside the project root, return a root-
// relative path; otherwise use /@fs/ prefix.
const toViteUrl = (filePath: string, root: string): string => {
  const normalized = filePath.replace(/\\/g, '/')
  const normalizedRoot = root.replace(/\\/g, '/').replace(/\/$/, '')
  if (normalized.startsWith(normalizedRoot + '/')) {
    return normalized.slice(normalizedRoot.length)
  }
  return `/@fs${normalized}`
}

export const devExposePlugin = (
  options: VitePluginFederationOptions
): PluginHooks => {
  parsedOptions.devExpose = parseExposeOptions(options)

  // Build list of shared module names for init code generation
  const sharedList: string[] = []
  // Modules actually excluded from dep optimization (only these get
  // wrapper/patch treatment in middleware and transform)
  const excludedShared = new Set<string>()
  let resolvedRoot = process.cwd()

  let moduleMap = ''
  for (const item of parsedOptions.devExpose) {
    const name = removeNonRegLetter(item[0], NAME_CHAR_REG)
    moduleMap += `"${item[0]}":()=>{
      return __federation_import('./__federation_expose_${name}.js').then(module => Object.keys(module).every(item => exportSet.has(item)) ? () => module.default : () => module)},`
  }

  return {
    name: 'hugs7:expose-development',
    virtualFile: {
      [`__remoteEntryHelper__${options.filename}`]: `
${FEDERATION_DEBUG_SNIPPET_ESM}
const _logInit = __fed_debug('federation:init');
const _logGet = __fed_debug('federation:get');
const currentImports = {}
const exportSet = new Set(['Module', '__esModule', 'default', '_export_sfc']);
let moduleMap = {${moduleMap}}
const seen = {}
async function __federation_import(name) {
  currentImports[name] ??= import(/* @vite-ignore */ name)
  return currentImports[name]
};

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
      resolvedRoot = config.root ? resolve(config.root) : process.cwd()

      // Only set up shared wrappers when this is a remote with shared modules
      if (!parsedOptions.devExpose.length || !parsedOptions.devShared.length) {
        return
      }

      const root = resolvedRoot
      const nodeRequire = createRequire(join(root, 'package.json'))

      // Populate sharedList and discover exports for each shared module
      for (const item of parsedOptions.devShared) {
        const name = item[0]
        sharedList.push(name)

        let realPath: string
        try {
          realPath = nodeRequire.resolve(name)
        } catch {
          continue
        }

        const localUrl = toViteUrl(realPath, root)
        const exports = getModuleExportNames(name, root)
        sharedModuleMeta.set(name, { localUrl, exports })
      }

      // Discover sub-paths of shared modules (e.g. react/jsx-runtime).
      // These are known CJS entry points that need named re-export patching.
      const knownSubPaths = ['/jsx-runtime', '/jsx-dev-runtime', '/client']
      for (const baseName of sharedList) {
        for (const sub of knownSubPaths) {
          const specifier = baseName + sub
          if (sharedModuleMeta.has(specifier)) continue
          try {
            const realPath = nodeRequire.resolve(specifier)
            const localUrl = toViteUrl(realPath, root)
            const exports = getModuleExportNames(specifier, root)
            if (exports.length > 0) {
              sharedModuleMeta.set(specifier, { localUrl, exports })
            }
          } catch {
            /* sub-path doesn't exist for this module */
          }
        }
      }

      // Mark shared singleton modules for middleware/transform interception.
      // These modules stay pre-bundled (for proper CJS→ESM conversion), but
      // the middleware replaces the served file with a shared wrapper that
      // checks globalThis.__federation_shared_modules__ first.
      for (const name of sharedList) {
        if (name === 'react' || name === 'react-dom') {
          excludedShared.add(name)
        }
      }

    },

    transform(code: string, id: string) {
      // Patch pre-bundled shared module files.  Base packages get
      // replaced with a shared wrapper; sub-paths get named
      // re-exports appended to fix Vite 8/rolldown CJS interop.
      if (!id.includes('.vite/deps/') || sharedModuleMeta.size === 0) {
        return null
      }

      const fileMatch = id.match(/\.vite\/deps\/(.+)\.js$/)
      if (!fileMatch) return null

      const fileName = fileMatch[1]
      for (const [name, meta] of sharedModuleMeta) {
        if (name.replace(/\//g, '_') !== fileName) continue

        // Only patch deps whose base module is excluded from optimization
        const basePkg = name.split('/').slice(0, name.startsWith('@') ? 2 : 1).join('/')
        if (!excludedShared.has(basePkg)) break

        // Patch export default with named re-exports + shared module check
        if (/export default .+;/.test(code)) {
          const exportNames = meta.exports.filter(
            (e) => e !== 'default' && e !== 'module.exports' && /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(e)
          )
          if (exportNames.length > 0) {
            const isTopLevel = name === basePkg
            const reExports = exportNames
              .map((e) => `export const ${e} = __federation_default[${JSON.stringify(e)}];`)
              .join('\n')
            const sharedCheck = isTopLevel
              ? `globalThis.__federation_shared_modules__?.[${JSON.stringify(name)}] ?? `
              : ''
            return {
              code: code.replace(
                /export default (.+);/,
                `const __federation_default = ${sharedCheck}$1;\nexport default __federation_default;\n${reExports}`
              )
            }
          }
        }
        break
      }

      return null
    },

    resolveId(id: string) {
      // Intercept bare shared specifiers so they resolve to virtual wrappers
      // instead of the real package.  This gives us a single entry point
      // that can switch between the host's shared module and the local one.
      // No-op: shared modules are pre-bundled and intercepted by the
      // middleware/transform hooks for .vite/deps/ files instead.
      void id

      return null
    },

    load(id: string) {
      if (!id.startsWith(RESOLVED_SHARED_PREFIX)) {
        return null
      }

      const specifier = id.slice(RESOLVED_SHARED_PREFIX.length)
      const meta = sharedModuleMeta.get(specifier)
      if (!meta) {
        return null
      }

      return {
        code: buildSharedWrapperCode(specifier, meta),
        moduleType: 'js' as const
      }
    },
    configureServer(server) {
      // Intercept requests for pre-bundled stubs of excluded shared
      // modules BEFORE Vite's static file serving.  When react/react-dom
      // are excluded from the dep optimizer, Vite creates CJS stubs in
      // .vite/deps/ with only a default export (no named exports like
      // Fragment, useState).  We replace them with the shared wrapper.
      // This must be the FIRST middleware to run before Vite serves the
      // stub from disk.
      if (sharedModuleMeta.size > 0) {
        console.log('[federation] Shared stub middleware registered for:', [
          ...sharedModuleMeta.keys()
        ])
        server.middlewares.use(async (req, res, next) => {
          const url = req.url
          if (!url || !url.includes('.vite/deps/')) {
            next()
            return
          }

          const urlPath = url.split('?')[0]
          const depsMatch = urlPath.match(
            /\/node_modules\/\.vite\/deps\/(.+)\.js$/
          )
          if (!depsMatch) {
            next()
            return
          }
          const port = server.config.server.port ?? 5173
          const originUrl = `http://localhost:${port}`
          const fileName = depsMatch[1]

          // Exact match against pre-computed sharedModuleMeta entries
          let matchedName: string | undefined
          let matchedMeta: SharedModuleMeta | undefined
          for (const [name, meta] of sharedModuleMeta) {
            if (name.replace(/\//g, '_') === fileName) {
              matchedName = name
              matchedMeta = meta
              break
            }
          }

          // Only intercept deps whose base module is in excludedShared
          const matchedBase = matchedName
            ?.split('/')
            .slice(0, matchedName.startsWith('@') ? 2 : 1)
            .join('/')

          if (matchedName && matchedMeta && matchedBase && excludedShared.has(matchedBase)) {
            // Intercept the response: let Vite serve the file normally
            // (with proper import rewriting), then patch the output.
            const origWrite = res.write.bind(res)
            const origEnd = res.end.bind(res)
            const chunks: Buffer[] = []

            res.write = function (chunk: any, ...args: any[]) {
              chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
              return true
            } as any

            res.end = function (chunk?: any, ...args: any[]) {
              if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
              let fileCode = Buffer.concat(chunks).toString('utf-8')

              const exportNames = matchedMeta!.exports.filter(
                (e) => e !== 'default' && e !== 'module.exports' && /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(e)
              )
              if (exportNames.length > 0 && /export default .+;/.test(fileCode)) {
                const isTopLevel = matchedName === matchedBase
                const reExports = exportNames
                  .map((e) => `export const ${e} = __federation_default[${JSON.stringify(e)}];`)
                  .join('\n')
                const sharedCheck = isTopLevel
                  ? `globalThis.__federation_shared_modules__?.[${JSON.stringify(matchedName)}] ?? `
                  : ''
                fileCode = fileCode.replace(
                  /export default (.+);/,
                  `const __federation_default = ${sharedCheck}$1;\nexport default __federation_default;\n${reExports}`
                )
              }

              // Remove content-length since we changed the body
              res.removeHeader('content-length')
              res.setHeader('Access-Control-Allow-Origin', '*')
              origEnd(fileCode)
            } as any

            next()
            return
          }
          next()
        })
      }

      // Add CORS headers to ALL responses so the HOST browser can load
      // source files, @vite/client, dep-optimized chunks, etc. from
      // this remote dev server.
      server.middlewares.use((req, res, next) => {
        res.setHeader('Access-Control-Allow-Origin', '*')
        res.setHeader('Access-Control-Allow-Methods', '*')
        res.setHeader('Access-Control-Allow-Headers', '*')
        if (req.method === 'OPTIONS') {
          res.statusCode = 204
          res.end()
          return
        }
        next()
      })

      server.middlewares.use(async (req, res, next) => {
        const url = req.url

        // Serve remoteEntry.js
        if (url === `/${options.filename}`) {
          try {
            const moduleId = `__remoteEntryHelper__${options.filename}`
            const result = await server.transformRequest(moduleId)
            if (result) {
              res.setHeader('Content-Type', 'application/javascript')
              res.end(result.code)
            } else {
              res.statusCode = 404
              res.end('Module not found')
            }
          } catch (error) {
            res.statusCode = 500
            res.end('Internal server error')
          }
          return
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
            const clientResult = await server.transformRequest('/@vite/client')
            if (!clientResult) {
              next()
              return
            }
            const port = server.config.server.port ?? 5173
            const remoteOrigin = `http://localhost:${port}`
            let code = clientResult.code
            code = code.replace(
              /const base = "\/"\s*\|\|\s*"\/";/,
              `const base = "${remoteOrigin}/";`
            )
            code = code.replace(
              /const base\$1 = "\/"\s*\|\|\s*"\/";/,
              `const base$1 = "${remoteOrigin}/";`
            )
            res.setHeader('Content-Type', 'application/javascript')
            res.end(code)
          } catch (error) {
            next()
          }
          return
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
`
          res.setHeader('Content-Type', 'application/javascript')
          res.end(code)
          return
        }

        // Serve the real react-refresh runtime under an alternate
        // URL so the /@react-refresh wrapper can import it.
        if (
          url === '/@react-refresh-runtime' ||
          url?.startsWith('/@react-refresh-runtime?')
        ) {
          try {
            const result = await server.transformRequest('/@react-refresh')
            if (result) {
              res.setHeader('Content-Type', 'application/javascript')
              res.end(result.code)
              return
            }
          } catch {
            /* fall through */
          }
          next()
          return
        }

        // Serve exposed modules as re-export stubs that redirect the
        // browser to import the real source file.  Vite then tracks
        // the real file in its module graph and sends HMR updates for it.
        if (url?.includes('__federation_expose_')) {
          try {
            const match = url.match(/__federation_expose_(.+?)\.js/)
            if (match) {
              const exposeName = match[1]
              const exposeItem = parsedOptions.devExpose.find((item) => {
                const itemName = removeNonRegLetter(item[0], NAME_CHAR_REG)
                return itemName === exposeName
              })
              if (exposeItem && exposeItem[1] && exposeItem[1].import) {
                const modulePath = exposeItem[1].import
                // Serve a thin re-export stub.  The browser follows
                // the import to the real source file, which Vite serves
                // with HMR metadata.
                const viteUrl = toViteUrl(modulePath, resolvedRoot)
                const code = `export { default } from '${viteUrl}';\nexport * from '${viteUrl}';`
                res.setHeader('Content-Type', 'application/javascript')
                res.end(code)
              } else {
                res.statusCode = 404
                res.end(`Expose module not found: ${exposeName}`)
              }
            } else {
              res.statusCode = 400
              res.end('Invalid expose module URL')
            }
          } catch (error) {
            console.error('Error loading expose module:', error)
            res.statusCode = 500
            res.end('Internal server error')
          }
          return
        }

        next()
      })
    }
  }
}
