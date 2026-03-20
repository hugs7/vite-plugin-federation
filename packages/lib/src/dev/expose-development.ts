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
import { mkdirSync, writeFileSync, existsSync } from 'fs'
import { join, resolve } from 'path'
import { createRequire } from 'module'
import type { UserConfig } from 'vite'

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
    // Resolve the real package entry point BEFORE aliasing
    let realPath: string
    try {
      realPath = nodeRequire.resolve(name)
    } catch {
      continue // skip if package can't be resolved
    }

    // Only shim packages that need singleton identity (react, react-dom).
    // Other shared packages (react-router, zustand, etc.) don't need shimming
    // because they just need to USE the same React, which they will via the
    // shimmed react dep. CJS shims can't replicate ESM named exports, so
    // shimming non-React packages breaks their export shapes.
    const SINGLETON_PACKAGES = new Set(['react', 'react-dom'])
    if (!SINGLETON_PACKAGES.has(name)) continue

    const safeName = name.replace(/[/@]/g, '_')
    const shimFile = join(shimDir, `${safeName}.cjs`)
    // CJS bridge: synchronously reads from globalThis.__federation_shared_modules__
    // which is populated by the remoteEntry's init() before any exposed
    // module evaluates.  When running standalone (no share scope), falls
    // back to requiring the real package via its absolute path.
    const shimCode = `
var mod;
try {
  mod = globalThis.__federation_shared_modules__ && globalThis.__federation_shared_modules__['${name}'];
} catch(e) {}
if (mod) {
  module.exports = mod;
} else {
  module.exports = require('${realPath.replace(/\\/g, '/')}');
}
`
    writeFileSync(shimFile, shimCode)
    aliases[name] = shimFile
  }

  return { shimDir, aliases }
}

export function devExposePlugin(
  options: VitePluginFederationOptions
): PluginHooks {
  parsedOptions.devExpose = parseExposeOptions(options)

  // Build list of shared module names for init code generation
  const sharedList: string[] = []

  let moduleMap = ''
  for (const item of parsedOptions.devExpose) {
    const name = removeNonRegLetter(item[0], NAME_CHAR_REG)
    moduleMap += `"${item[0]}":()=>{
      return __federation_import('./__federation_expose_${name}.js').then(module =>Object.keys(module).every(item => exportSet.has(item)) ? () => module.default : () => module)},`
  }

  return {
    name: 'originjs:expose-development',
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
export const get =(module) => {
  if(!moduleMap[module]) throw new Error('Can not find remote module ' + module)
  return moduleMap[module]();
};
export const init = async (shareScope) => {
  globalThis.__federation_shared__= globalThis.__federation_shared__ || {};
  Object.entries(shareScope).forEach(([key, value]) => {
    for (const [versionKey, versionValue] of Object.entries(value)) {
      const scope = versionValue.scope || 'default';
      globalThis.__federation_shared__[scope] = globalThis.__federation_shared__[scope] || {};
      const shared= globalThis.__federation_shared__[scope];
      (shared[key] = shared[key] || {})[versionKey] = versionValue;
    }
  });
  // Eagerly resolve all shared modules and store them in a sync-accessible
  // global so that pre-bundled deps (which use the bridge shims) can access
  // the host's shared modules synchronously.
  globalThis.__federation_shared_modules__ = globalThis.__federation_shared_modules__ || {};
  const sharedKeys = Object.keys(shareScope);
  await Promise.all(sharedKeys.map(async (key) => {
    try {
      const versions = shareScope[key];
      const ver = Object.keys(versions)[0];
      if (ver) {
        const factory = await versions[ver].get();
        const mod = await factory();
        globalThis.__federation_shared_modules__[key] = mod?.default ?? mod;
      }
    } catch(e) {
      console.warn('[federation-dev] Failed to pre-resolve shared module:', key, e);
    }
  }));
};`
    },
    config(config: UserConfig) {
      // Only set up shims when this is a remote (has exposes) with shared modules
      if (!parsedOptions.devExpose.length || !parsedOptions.devShared.length) {
        return
      }

      // Populate sharedList from parsed options
      for (const item of parsedOptions.devShared) {
        sharedList.push(item[0])
      }

      const root = config.root ? resolve(config.root) : process.cwd()
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
      server.middlewares.use(async (req, res, next) => {
        const url = req.url
        const setCorsHeaders = () => {
          res.setHeader('Access-Control-Allow-Origin', '*')
          res.setHeader('Access-Control-Allow-Methods', '*')
          res.setHeader('Access-Control-Allow-Headers', '*')
        }

        if (url === `/${options.filename}`) {
          if (req.method === 'OPTIONS') {
            setCorsHeaders()
            res.statusCode = 204
            res.end()
            return
          }
          setCorsHeaders()
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

        if (url?.includes('__federation_expose_')) {
          if (req.method === 'OPTIONS') {
            setCorsHeaders()
            res.statusCode = 204
            res.end()
            return
          }
          setCorsHeaders()
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
                const result = await server.transformRequest(modulePath)
                if (result) {
                  res.setHeader('Content-Type', 'application/javascript')
                  res.end(result.code)
                } else {
                  res.statusCode = 404
                  res.end(`Module not found: ${modulePath}`)
                }
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
