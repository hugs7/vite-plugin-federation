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

import { existsSync, mkdirSync, readFileSync } from 'fs'
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

const FEDERATION_DEPS_DIR = '.federation-deps'

/**
 * Read the export names from a federation pre-bundled file.
 * The pre-bundle output is clean ESM — es-module-lexer can parse it reliably
 * because Rolldown already resolved all CJS/ESM/export* into flat exports.
 */
const readPreBundledExports = async (
  filePath: string
): Promise<string[]> => {
  try {
    const { init, parse } = await import('es-module-lexer')
    await init
    const code = readFileSync(filePath, 'utf-8')
    const [, exports] = parse(code)
    return exports.map((e) => (typeof e === 'string' ? e : e.n)).filter(Boolean)
  } catch {
    return []
  }
}

/** Metadata for a shared virtual module */
interface SharedModuleMeta {
  /** URL to the federation pre-bundled file (served via /@fs/ or root-relative) */
  preBundleUrl: string
  /** Enumerated export names (discovered from pre-bundle output) */
  exports: string[]
}

/**
 * Build ESM wrapper code for a shared virtual module.
 * At runtime, checks globalThis.__federation_shared_modules__ first (set by
 * the host's init()), falling back to a dynamic import of the federation
 * pre-bundled version of the package.
 */
const buildSharedWrapperCode = (
  name: string,
  meta: SharedModuleMeta,
  originUrl?: string
): string => {
  const named = meta.exports.filter((e) => e !== 'default')
  const hasDefault = meta.exports.includes('default')

  const importUrl = originUrl
    ? `${originUrl}${meta.preBundleUrl}`
    : meta.preBundleUrl

  let code = ''
  code += `const __shared = globalThis.__federation_shared_modules__?.[${JSON.stringify(name)}];\n`
  code += `const __mod = __shared ?? await import(/* @vite-ignore */ ${JSON.stringify(importUrl)});\n`

  if (hasDefault) {
    code += `export default (__mod.default ?? __mod);\n`
  }
  for (const e of named) {
    if (/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(e)) {
      code += `export const ${e} = __mod[${JSON.stringify(e)}];\n`
    }
  }

  return code
}

/** Map of shared specifier -> metadata, populated in configureServer() */
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

  // The set of ALL shared module specifiers (populated in config())
  const sharedSet = new Set<string>()
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
    async config(config: UserConfig) {
      resolvedRoot = config.root ? resolve(config.root) : process.cwd()

      // Only set up shared wrappers when this is a remote with shared modules
      if (!parsedOptions.devExpose.length || !parsedOptions.devShared.length) {
        return
      }

      // Collect all shared module specifiers
      for (const item of parsedOptions.devShared) {
        sharedSet.add(item[0])
      }

      // Also add known sub-paths that are commonly imported.
      // Snapshot the base names first to avoid mutating the set while iterating.
      const knownSubPaths = ['/jsx-runtime', '/jsx-dev-runtime', '/client']
      const nodeRequire = createRequire(join(resolvedRoot, 'package.json'))
      const baseNames = [...sharedSet]
      for (const baseName of baseNames) {
        for (const sub of knownSubPaths) {
          const specifier = baseName + sub
          try {
            nodeRequire.resolve(specifier)
            sharedSet.add(specifier)
          } catch {
            /* sub-path doesn't exist */
          }
        }
      }

      console.log(
        '[federation:config] Shared modules (all externalized):',
        [...sharedSet]
      )

      // Inject a Rolldown plugin into the dep optimizer that marks ALL
      // shared modules as external.  This means when Rolldown pre-bundles
      // dependencies (e.g. react-dom, some-ui-lib), any import of a shared
      // module is left as a bare specifier in the .vite/deps/ output.
      // Our Vite-level resolveId then intercepts these bare specifiers
      // from the browser and serves the shared wrapper.
      //
      // This replaces ALL heuristic classification (CJS/ESM detection,
      // export* scanning, sub-dep discovery) with a single declarative rule.
      config.optimizeDeps ??= {}
      config.optimizeDeps.rolldownOptions ??= {}

      const sharedNames = [...sharedSet]
      const federationOptimizerPlugin = {
        name: 'federation-shared-external',
        resolveId(id: string) {
          // Mark shared modules as external in the dep optimizer.
          // This causes Rolldown to leave `import "react"` as-is in
          // pre-bundled output instead of inlining/chunking the module.
          if (sharedNames.includes(id)) {
            return { id, external: true }
          }
          return null
        }
      }

      const existingPlugins = config.optimizeDeps.rolldownOptions.plugins
      if (Array.isArray(existingPlugins)) {
        existingPlugins.push(federationOptimizerPlugin)
      } else {
        config.optimizeDeps.rolldownOptions.plugins = [
          federationOptimizerPlugin
        ]
      }
    },

    resolveId(id: string) {
      // Intercept ALL shared module imports.  Because shared modules are
      // externalized in the dep optimizer, bare specifiers for them appear
      // in .vite/deps/ output and in application source code.  We redirect
      // them all to our virtual shared wrapper.
      if (sharedSet.has(id)) {
        return RESOLVED_SHARED_PREFIX + id
      }
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

    async configureServer(server) {
      // Build the federation pre-bundle: use Rolldown to bundle each shared
      // module into a clean ESM file.  This handles CJS→ESM conversion,
      // export* resolution, and sub-dep inlining — all without heuristics.
      if (sharedSet.size > 0) {
        const root = resolvedRoot
        const outDir = join(root, 'node_modules', FEDERATION_DEPS_DIR)
        mkdirSync(outDir, { recursive: true })

        const { build } = await import('rolldown')

        // Build each shared module individually so we get one file per module
        // with its own clean export list.
        const entries: Record<string, string> = {}
        for (const name of sharedSet) {
          entries[name.replace(/\//g, '_')] = name
        }

        try {
          await build({
            input: entries,
            cwd: root,
            resolve: {
              conditionNames: ['import', 'module', 'browser', 'default']
            },
            platform: 'browser',
            output: {
              format: 'esm',
              dir: outDir,
              entryFileNames: '[name].js',
              chunkFileNames: '_shared_chunks/[name]-[hash].js'
            },
            // Silence warnings for circular deps in node_modules
            logLevel: 'silent'
          })
        } catch (e) {
          console.error('[federation] Failed to build federation pre-bundle:', e)
        }

        // Populate sharedModuleMeta from the pre-bundled output
        for (const name of sharedSet) {
          const fileName = name.replace(/\//g, '_') + '.js'
          const filePath = join(outDir, fileName)
          if (!existsSync(filePath)) {
            console.warn(
              `[federation] Pre-bundle missing for ${name}, skipping`
            )
            continue
          }
          const exports = await readPreBundledExports(filePath)
          const preBundleUrl = toViteUrl(filePath, root)

          sharedModuleMeta.set(name, { preBundleUrl, exports })
        }

        console.log(
          '[federation:configureServer] Pre-bundled shared modules:',
          [...sharedModuleMeta.keys()]
        )
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
        if (url === '/@react-refresh' || url?.startsWith('/@react-refresh?')) {
          const code = `
import * as _localRuntime from '/@react-refresh-runtime';
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
