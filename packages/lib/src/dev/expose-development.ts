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
 * Scan a file (and optionally its chunk imports) for CJS `exports.XXX = ...`
 * patterns.  With code splitting, CJS module bodies may live in chunk files
 * rather than the entry file itself.
 */
const scanCjsExports = (
  code: string,
  fileDir: string
): Set<string> => {
  const cjsExports = new Set<string>(['default'])

  // Scan this file for exports.XXX = ...
  for (const match of code.matchAll(
    /exports\.([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=/g
  )) {
    cjsExports.add(match[1])
  }

  // If we only found `default` in the entry, the CJS body may be in a chunk.
  // Follow relative imports and scan those too.
  if (cjsExports.size <= 1) {
    for (const imp of code.matchAll(/from\s+["'](\.[^"']+)["']/g)) {
      try {
        const chunkPath = join(fileDir, imp[1])
        const chunkCode = readFileSync(chunkPath, 'utf-8')
        for (const match of chunkCode.matchAll(
          /exports\.([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=/g
        )) {
          cjsExports.add(match[1])
        }
      } catch {
        /* chunk not found */
      }
    }
  }

  return cjsExports
}

/**
 * Discover export names from a federation pre-bundled file.
 *
 * Strategy (fastest to slowest, stops when exports found):
 * 1. es-module-lexer on the entry file (works for ESM modules)
 * 2. Scan entry + chunk files for `exports.XXX = ...` (works for CJS)
 * 3. Scan the ORIGINAL package source for `exports.XXX = ...` (fallback
 *    when code splitting moves CJS bodies into shared chunks that the
 *    entry doesn't directly import)
 */
const getPreBundleExports = async (
  filePath: string,
  moduleName: string,
  root: string
): Promise<string[]> => {
  try {
    const { init, parse } = await import('es-module-lexer')
    await init
    const code = readFileSync(filePath, 'utf-8')
    const [, exports] = parse(code)
    const names = exports
      .map((e) => (typeof e === 'string' ? e : e.n))
      .filter(Boolean)

    // ESM module with named exports — use them directly
    if (names.length > 1 || (names.length === 1 && names[0] !== 'default')) {
      return names
    }

    // CJS module — scan pre-bundle entry + chunks for exports.XXX patterns
    const fileDir = filePath.substring(0, filePath.lastIndexOf('/'))
    const cjsExports = scanCjsExports(code, fileDir)
    if (cjsExports.size > 1) {
      return [...cjsExports]
    }

    // Fallback: scan the ORIGINAL package source.  With code splitting,
    // CJS bodies can end up in shared chunks that the entry file doesn't
    // directly import (e.g. react/jsx-runtime shares a chunk with react).
    try {
      const nodeRequire = createRequire(join(root, 'package.json'))
      const origPath = nodeRequire.resolve(moduleName)
      const origCode = readFileSync(origPath, 'utf-8')
      const origExports = new Set<string>(['default'])

      // Scan the entry file
      for (const m of origCode.matchAll(
        /exports\.([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=/g
      )) {
        origExports.add(m[1])
      }

      // Follow require('./...') to find CJS sub-files
      if (origExports.size <= 1) {
        const origDir = origPath.substring(0, origPath.lastIndexOf('/'))
        for (const req of origCode.matchAll(
          /require\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g
        )) {
          try {
            const subPath = nodeRequire.resolve(join(origDir, req[1]))
            const subCode = readFileSync(subPath, 'utf-8')
            for (const m of subCode.matchAll(
              /exports\.([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=/g
            )) {
              origExports.add(m[1])
            }
          } catch {
            /* sub-file not found */
          }
        }
      }

      if (origExports.size > 1) {
        return [...origExports]
      }
    } catch {
      /* original source fallback failed */
    }

    return names.length ? names : ['default']
  } catch {
    return ['default']
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

  // For CJS modules (react, react-dom), the pre-bundle output only has
  // `export default require_xxx()`.  The actual exports (Fragment, useState,
  // etc.) are properties of the default export object.  We need to unwrap:
  //   __ns = __mod.default ?? __mod
  // Then re-export properties from __ns rather than __mod directly.
  // For ESM modules, __mod already has top-level named exports AND a default,
  // so __ns still works (we just read properties from __mod.default which is
  // the same namespace object).

  let code = ''
  code += `const __shared = globalThis.__federation_shared_modules__?.[${JSON.stringify(name)}];\n`
  code += `const __mod = __shared ?? await import(/* @vite-ignore */ ${JSON.stringify(importUrl)});\n`
  code += `const __ns = __mod.default ?? __mod;\n`

  if (hasDefault) {
    code += `export default __ns;\n`
  }
  for (const e of named) {
    if (/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(e)) {
      code += `export const ${e} = __ns[${JSON.stringify(e)}];\n`
    }
  }

  return code
}

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

// Shared state between the main plugin and the enforce:'pre' resolver plugin.
// Both reference these module-level variables.  They're populated when
// devExposePlugin() runs (called from config() hook) and used by the
// resolver plugin at request time.
const sharedSet = new Set<string>()
let sharedModuleMeta = new Map<string, SharedModuleMeta>()

/**
 * Separate enforce:'pre' plugin for shared module resolution.
 * Must run before Vite's internal resolver so that bare specifier imports
 * of shared modules (from both app source AND pre-bundled deps) are
 * intercepted before Vite resolves them to raw /@fs/ paths.
 *
 * Always registered — becomes a no-op when sharedSet is empty (production
 * builds, host-only configs, etc.).
 */
export const devSharedResolverPlugin: import('vite').Plugin = {
  name: 'hugs7:federation-shared-resolve',
  enforce: 'pre',

  resolveId(id: string) {
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
  }
}

export const devExposePlugin = (
  options: VitePluginFederationOptions
): PluginHooks => {
  parsedOptions.devExpose = parseExposeOptions(options)

  // Reset shared state for this plugin instance.
  // The module-level sharedSet/sharedModuleMeta are shared with
  // devSharedResolverPlugin (enforce:'pre').
  sharedSet.clear()
  sharedModuleMeta = new Map<string, SharedModuleMeta>()

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

      // Exclude ALL shared modules from Vite's dep optimizer.
      // When excluded, bare specifier imports of these modules in other
      // pre-bundled deps (e.g. react-dom importing react) are resolved
      // through the normal Vite plugin pipeline — which hits our resolveId
      // hook and serves the virtual shared wrapper.
      //
      // The old code couldn't exclude CJS modules because the fallback
      // served raw CJS (browsers can't load it). Now our fallback imports
      // from the federation pre-bundle (clean ESM built by Rolldown), so
      // CJS/ESM distinction is no longer needed.
      config.optimizeDeps ??= {}
      config.optimizeDeps.exclude = [
        ...(config.optimizeDeps.exclude ?? []),
        ...sharedSet
      ]
    },

    // Shared module resolution is handled by devSharedResolverPlugin
    // (enforce:'pre'), registered as a separate Vite plugin so it runs
    // BEFORE Vite's internal resolver.  The main federation plugin is
    // enforce:'post', which is too late to intercept bare specifiers
    // from pre-bundled deps.

    async configureServer(server) {
      // Build the federation pre-bundle: use Rolldown to bundle ALL shared
      // modules in a single build with code splitting.  This handles:
      // - CJS→ESM conversion (react, react-dom)
      // - export* resolution
      // - Deduplication via shared chunks (react becomes a chunk that
      //   zustand, react-dom, etc. all import — single instance)
      //
      // We CANNOT externalize shared modules from each other because CJS
      // modules use require() for their deps, and Rolldown leaves
      // require() calls to externals as-is — browsers don't have require.
      // A single build with code splitting solves this naturally.
      if (sharedSet.size > 0) {
        const root = resolvedRoot
        const outDir = join(root, 'node_modules', FEDERATION_DEPS_DIR)
        mkdirSync(outDir, { recursive: true })

        const { build } = await import('rolldown')
        const sharedNames = [...sharedSet]

        const entries: Record<string, string> = {}
        for (const name of sharedNames) {
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
              chunkFileNames: '_chunks/[name]-[hash].js'
            },
            logLevel: 'silent'
          })
        } catch (e) {
          console.error(
            '[federation] Failed to build federation pre-bundle:',
            e instanceof Error ? e.message : e
          )
        }

        // Populate sharedModuleMeta from the pre-bundled output.
        // Export names are discovered from the pre-bundle files:
        // - ESM modules: es-module-lexer finds named exports directly
        // - CJS modules: Rolldown only produces `export default`, so we
        //   also scan for `exports.XXX = ...` patterns in the CJS body
        for (const name of sharedNames) {
          const fileName = name.replace(/\//g, '_') + '.js'
          const filePath = join(outDir, fileName)
          if (!existsSync(filePath)) {
            console.warn(
              `[federation] Pre-bundle missing for ${name}, skipping`
            )
            continue
          }
          const exports = await getPreBundleExports(filePath, name, root)
          const preBundleUrl = `/node_modules/${FEDERATION_DEPS_DIR}/${fileName}`

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
