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

import { existsSync, mkdirSync } from 'fs'
import { createRequire } from 'module'
import { join, resolve } from 'path'
import type { VitePluginFederationOptions } from 'types'
import type { UserConfig, ViteDevServer } from 'vite'
import type { IncomingMessage, ServerResponse } from 'http'
import type { PluginHooks } from '../../types/pluginHooks'
import { parsedOptions, PLUGIN_PREFIX } from '../public'
import { NAME_CHAR_REG, parseExposeOptions, removeNonRegLetter } from '../utils'

import {
  type SharedModuleMeta,
  buildSharedWrapperCode,
  getPreBundleExports
} from './export-discovery'
import { REACT_REFRESH_WRAPPER_CODE, patchViteClientCode } from './hmr'
import { buildRemoteEntryCode } from './remote-entry-template'

const SHARED_VIRTUAL_PREFIX = 'virtual:__federation_shared__:'
const RESOLVED_SHARED_PREFIX = '\0' + SHARED_VIRTUAL_PREFIX

const FEDERATION_DEPS_DIR = '.federation-deps'

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
  name: [PLUGIN_PREFIX, 'federation-shared-resolve'].join(':'),
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

// ---------------------------------------------------------------------------
// Middleware handlers — each handles a single URL pattern.
// ---------------------------------------------------------------------------

/** Serve remoteEntry.js via Vite's transform pipeline. */
const handleRemoteEntry = async (
  server: ViteDevServer,
  filename: string,
  res: ServerResponse
): Promise<boolean> => {
  try {
    const moduleId = `__remoteEntryHelper__${filename}`
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
  return true
}

/**
 * Patch @vite/client so HMR module re-imports use the absolute remote
 * origin instead of the HOST page origin.
 */
const handleViteClient = async (
  server: ViteDevServer,
  res: ServerResponse,
  next: () => void
): Promise<boolean> => {
  try {
    const clientResult = await server.transformRequest('/@vite/client')
    if (!clientResult) {
      next()
      return true
    }
    const port = server.config.server.port ?? 5173
    const remoteOrigin = `http://localhost:${port}`
    const code = patchViteClientCode(clientResult.code, remoteOrigin)
    res.setHeader('Content-Type', 'application/javascript')
    res.end(code)
  } catch (error) {
    next()
  }
  return true
}

/**
 * Serve the react-refresh wrapper that re-uses the HOST's refresh
 * runtime singleton for cross-origin component registration.
 */
const handleReactRefresh = (res: ServerResponse): boolean => {
  res.setHeader('Content-Type', 'application/javascript')
  res.end(REACT_REFRESH_WRAPPER_CODE)
  return true
}

/**
 * Serve the real react-refresh runtime under an alternate URL
 * so the wrapper can import it without recursion.
 */
const handleReactRefreshRuntime = async (
  server: ViteDevServer,
  res: ServerResponse,
  next: () => void
): Promise<boolean> => {
  try {
    const result = await server.transformRequest('/@react-refresh')
    if (result) {
      res.setHeader('Content-Type', 'application/javascript')
      res.end(result.code)
      return true
    }
  } catch {
    /* fall through */
  }
  next()
  return true
}

/**
 * Serve exposed modules as re-export stubs that redirect the browser
 * to import the real source file for HMR tracking.
 */
const handleExposeModule = (
  url: string,
  resolvedRoot: string,
  res: ServerResponse
): boolean => {
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
  return true
}

// ---------------------------------------------------------------------------
// Pre-bundle build
// ---------------------------------------------------------------------------

/**
 * Build the federation pre-bundle using Rolldown: bundles ALL shared
 * modules in a single build with code splitting, then populates
 * sharedModuleMeta with discovered export names.
 */
const buildFederationPreBundle = async (root: string): Promise<void> => {
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

// ---------------------------------------------------------------------------
// CORS middleware
// ---------------------------------------------------------------------------

/** Add CORS headers so the HOST browser can load files from this remote. */
const corsMiddleware = (
  req: IncomingMessage,
  res: ServerResponse,
  next: () => void
): void => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', '*')
  res.setHeader('Access-Control-Allow-Headers', '*')
  if (req.method === 'OPTIONS') {
    res.statusCode = 204
    res.end()
    return
  }
  next()
}

// ---------------------------------------------------------------------------
// Main plugin
// ---------------------------------------------------------------------------

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
    name: [PLUGIN_PREFIX, 'expose-development'].join(':'),
    virtualFile: {
      [`__remoteEntryHelper__${options.filename}`]:
        buildRemoteEntryCode(moduleMap)
    },
    async config(config: UserConfig) {
      resolvedRoot = config.root ? resolve(config.root) : process.cwd()

      // Only set up shared wrappers when this is a remote with shared modules
      if (!parsedOptions.devExpose.length || !parsedOptions.devShared.length) {
        return
      }

      // Check if Rolldown is available (ships with Vite 8+).
      // Without it, we can't build the federation pre-bundle, so shared
      // module interception is disabled — the MFE works standalone but
      // not federated over a host in dev mode.
      try {
        await import('rolldown')
      } catch {
        console.warn(
          '[federation] Rolldown not available (requires Vite 8+). ' +
            'Dev-mode federation with shared modules is disabled. ' +
            'The MFE will work standalone but shared modules will not ' +
            'be intercepted when loaded via a host.'
        )
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
      if (sharedSet.size > 0) {
        await buildFederationPreBundle(resolvedRoot)
      }

      server.middlewares.use(corsMiddleware)

      server.middlewares.use(async (req, res, next) => {
        const url = req.url

        if (url === `/${options.filename}`) {
          await handleRemoteEntry(server, options.filename!, res)
          return
        }

        if (url === '/@vite/client' || url?.startsWith('/@vite/client?')) {
          await handleViteClient(server, res, next)
          return
        }

        if (url === '/@react-refresh' || url?.startsWith('/@react-refresh?')) {
          handleReactRefresh(res)
          return
        }

        if (
          url === '/@react-refresh-runtime' ||
          url?.startsWith('/@react-refresh-runtime?')
        ) {
          await handleReactRefreshRuntime(server, res, next)
          return
        }

        if (url?.includes('__federation_expose_')) {
          handleExposeModule(url, resolvedRoot, res)
          return
        }

        next()
      })
    }
  }
}
