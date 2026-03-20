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

import {
  parseExposeOptions,
  removeNonRegLetter,
  NAME_CHAR_REG
} from '../utils'
import { parsedOptions } from '../public'
import type { VitePluginFederationOptions } from 'types'
import type { PluginHooks } from '../../types/pluginHooks'
import { mkdirSync, writeFileSync, existsSync, readFileSync as fsReadFileSync } from 'fs'
import { join, resolve } from 'path'
import { createRequire } from 'module'
import { execSync } from 'child_process'
import type { UserConfig } from 'vite'

function getModuleExportNames(name: string, root: string): string[] {
  try {
    const result = execSync(
      `node --input-type=module -e "import('${name}').then(m => console.log(JSON.stringify(Object.keys(m))))"`,
      { cwd: root, encoding: 'utf-8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] }
    )
    return JSON.parse(result.trim())
  } catch {
    return []
  }
}

// Generate bridge/shim files for shared modules so that Vite's dep
// optimizer bundles them instead of the real packages.  Every optimized
// dep (react-redux, etc.) that imports "react" will therefore go through
// the bridge, which reads from the federation share scope at runtime.
function generateShimDir(
  sharedNames: string[],
  root: string
): { shimDir: string; aliases: Record<string, string> } {
  const shimDir = join(root, 'node_modules', '.federation-shims')
  if (!existsSync(shimDir)) {
    mkdirSync(shimDir, { recursive: true })
  }

  const aliases: Record<string, string> = {}
  const nodeRequire = createRequire(join(root, 'package.json'))
  for (const name of sharedNames) {
    let realPath: string
    try {
      realPath = nodeRequire.resolve(name)
    } catch {
      continue
    }

    const safeName = name.replace(/[/@]/g, '_')
    const escapedPath = realPath.replace(/\\/g, '/')

    // Detect if the resolved entry is ESM
    const isEsm = realPath.endsWith('.mjs') || (() => {
      try {
        let dir = realPath
        while (dir !== join(dir, '..')) {
          dir = join(dir, '..')
          const pkgPath = join(dir, 'package.json')
          if (existsSync(pkgPath)) {
            return JSON.parse(fsReadFileSync(pkgPath, 'utf-8')).type === 'module'
          }
        }
      } catch {}
      return false
    })()

    // ALL shared modules use CJS shims so they go through the dep
    // optimizer normally (avoiding CJS transitive dep issues from
    // optimizeDeps.exclude).
    //
    // For CJS packages: require() the real entry directly.
    // For ESM packages: enumerate exports at build time and emit
    //   explicit `exports.X = mod.X` lines.  This avoids the dep
    //   optimizer trying to trace ESM re-export chains through a
    //   CJS require() wrapper (which causes "export not defined").
    const shimFile = join(shimDir, `${safeName}.cjs`)

    if (!isEsm) {
      const shimCode = `
var mod = globalThis.__federation_shared_modules__ && globalThis.__federation_shared_modules__['${name}'];
console.log('[federation-shim] ${name}:', mod ? 'SHARED' : 'LOCAL', new Error().stack.split('\\n').slice(0,4).join(' <- '));
if (mod) {
  module.exports = mod;
} else {
  module.exports = require('${escapedPath}');
}
`
      writeFileSync(shimFile, shimCode)
    } else {
      const exportNames = getModuleExportNames(name, root)

      if (!exportNames.length) {
        // Export enumeration failed (e.g. the module references browser
        // globals like `window` at the top level and can't be loaded in
        // Node).  Fall back to a CJS-style shim — the dep optimizer
        // will wrap consumers with __toESM() which is fine.
        const shimCode = `
var mod = globalThis.__federation_shared_modules__ && globalThis.__federation_shared_modules__['${name}'];
console.log('[federation-shim] ${name}:', mod ? 'SHARED' : 'LOCAL', new Error().stack.split('\\n').slice(0,4).join(' <- '));
if (mod) {
  module.exports = mod;
} else {
  module.exports = require('${escapedPath}');
}
`
        writeFileSync(shimFile, shimCode)
      } else {
        const namedExports = exportNames.filter((n) => n !== 'default')
        const hasDefault = exportNames.includes('default')

        let shimCode = `var _shared = globalThis.__federation_shared_modules__ && globalThis.__federation_shared_modules__['${name}'];\n`
        shimCode += `console.log('[federation-shim] ${name}:', _shared ? 'SHARED' : 'LOCAL', new Error().stack.split('\\n').slice(0,4).join(' <- '));\n`
        shimCode += `var _mod = _shared || require('${escapedPath}');\n`
        if (hasDefault) {
          shimCode += `Object.defineProperty(exports, 'default', { enumerable: true, get: function() { return _mod.default ?? _mod; } });\n`
        }
        for (const n of namedExports) {
          const escaped = n.replace(/'/g, "\\'")
          shimCode += `Object.defineProperty(exports, '${escaped}', { enumerable: true, get: function() { return _mod['${escaped}']; } });\n`
        }
        writeFileSync(shimFile, shimCode)
      }
    }
    aliases[name] = shimFile
  }

  return { shimDir, aliases }
}

// Convert an absolute filesystem path to a URL that Vite's dev server
// can serve.  If the path is inside the project root, return a root-
// relative path; otherwise use /@fs/ prefix.
function toViteUrl(filePath: string, root: string): string {
  const normalized = filePath.replace(/\\/g, '/')
  const normalizedRoot = root.replace(/\\/g, '/').replace(/\/$/, '')
  if (normalized.startsWith(normalizedRoot + '/')) {
    return normalized.slice(normalizedRoot.length)
  }
  return `/@fs${normalized}`
}

export function devExposePlugin(
  options: VitePluginFederationOptions
): PluginHooks {
  parsedOptions.devExpose = parseExposeOptions(options)

  // Build list of shared module names for init code generation
  const sharedList: string[] = []
  let resolvedRoot = process.cwd()

  let moduleMap = ''
  for (const item of parsedOptions.devExpose) {
    const name = removeNonRegLetter(item[0], NAME_CHAR_REG)
    moduleMap += `"${item[0]}":()=>{
      return __federation_import('./__federation_expose_${name}.js').then(module =>Object.keys(module).every(item => exportSet.has(item)) ? () => module.default : () => module)},`
  }

  return {
    name: 'hugs7:expose-development',
    virtualFile: {
      [`__remoteEntryHelper__${options.filename}`]: `
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
export const init =(shareScope) => {
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
  console.log('[federation-init] Resolving shared modules:', Object.keys(shareScope));
  __federation_shared_resolving = Promise.all(Object.keys(shareScope).map(async (key) => {
    try {
      const versions = shareScope[key];
      const ver = Object.keys(versions)[0];
      if (ver) {
        const factory = await versions[ver].get();
        const mod = await factory();
        globalThis.__federation_shared_modules__[key] = mod;
        console.log('[federation-init] Resolved:', key, Object.keys(mod).slice(0,5));
      }
    } catch(e) {
      console.warn('[federation-dev] Failed to pre-resolve shared module:', key, e);
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
  console.log('[federation-get]', module, 'shared modules populated:', Object.keys(globalThis.__federation_shared_modules__ || {}));
  if(!moduleMap[module]) throw new Error('Can not find remote module ' + module)
  return moduleMap[module]();
};`
    },
    config(config: UserConfig) {
      resolvedRoot = config.root ? resolve(config.root) : process.cwd()

      // Only set up shims when this is a remote (has exposes) with shared modules
      if (!parsedOptions.devExpose.length || !parsedOptions.devShared.length) {
        return
      }

      // Populate sharedList from parsed options
      for (const item of parsedOptions.devShared) {
        sharedList.push(item[0])
      }

      const root = resolvedRoot
      const { aliases } = generateShimDir(sharedList, root)

      // Set up resolve aliases so all imports of shared modules (including
      // from pre-bundled deps) go through the bridge shims
      if (!config.resolve) config.resolve = {}
      if (!config.resolve.alias) config.resolve.alias = {}

      // Use array-style aliases with regex for exact matching,
      // so 'react' doesn't also match 'react/jsx-runtime' or 'react-dom'
      if (!Array.isArray(config.resolve.alias)) {
        // Convert object-style to array-style
        const existing = config.resolve.alias as Record<string, string>
        config.resolve.alias = Object.entries(existing).map(
          ([find, replacement]) => ({ find, replacement })
        )
      }
      for (const [from, to] of Object.entries(aliases)) {
        // Exact match regex: ^react$ matches 'react' but not 'react/jsx-runtime'
        ;(config.resolve.alias as any[]).push({
          find: new RegExp(`^${from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`),
          replacement: to
        })
      }


    },
    configureServer(server) {
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
