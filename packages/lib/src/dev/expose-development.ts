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

import { existsSync, mkdirSync, readFileSync } from 'fs';
import { createRequire } from 'module';
import { join, resolve } from 'path';
import type { VitePluginFederationOptions } from 'types';
import type { UserConfig, ViteDevServer } from 'vite';
import type { IncomingMessage, ServerResponse } from 'http';
import type { PluginHooks } from '../../types/pluginHooks';
import {
  FEDERATION_EXPOSE_PREFIX,
  parsedOptions,
  PLUGIN_PREFIX,
  REMOTE_ENTRY_HELPER_PREFIX
} from '../public';
import {
  matchesUrl,
  NAME_CHAR_REG,
  parseExposeOptions,
  removeNonRegLetter,
  sendJs
} from '../utils';
import { createLogger } from '../logger';

import {
  type SharedModuleMeta,
  buildSharedWrapperCode,
  getPreBundleExports
} from './export-discovery';
import { REACT_REFRESH_WRAPPER_CODE, patchViteClientCode } from './hmr';
import { buildRemoteEntryCode } from './remote-entry-template';

const logger = createLogger('expose');

const SHARED_VIRTUAL_PREFIX = 'virtual:__federation_shared__:';
const RESOLVED_SHARED_PREFIX = '\0' + SHARED_VIRTUAL_PREFIX;

const FEDERATION_DEPS_DIR = '.federation-deps';

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

// Shared state between the main plugin and the enforce:'pre' resolver plugin.
// Both reference these module-level variables.  They're populated when
// devExposePlugin() runs (called from config() hook) and used by the
// resolver plugin at request time.
const sharedSet = new Set<string>();
let sharedModuleMeta = new Map<string, SharedModuleMeta>();

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
      return RESOLVED_SHARED_PREFIX + id;
    }
    return null;
  },

  load(id: string) {
    if (!id.startsWith(RESOLVED_SHARED_PREFIX)) {
      return null;
    }

    const specifier = id.slice(RESOLVED_SHARED_PREFIX.length);
    const meta = sharedModuleMeta.get(specifier);
    if (!meta) {
      return null;
    }

    return {
      code: buildSharedWrapperCode(specifier, meta),
      moduleType: 'js' as const
    };
  }
};

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
    const moduleId = `${REMOTE_ENTRY_HELPER_PREFIX}${filename}`;
    const result = await server.transformRequest(moduleId);
    if (result) {
      sendJs(res, result.code);
    } else {
      res.statusCode = 404;
      res.end('Module not found');
    }
  } catch (error) {
    res.statusCode = 500;
    res.end('Internal server error');
  }
  return true;
};

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
    const clientResult = await server.transformRequest('/@vite/client');
    if (!clientResult) {
      next();
      return true;
    }
    const port = server.config.server.port ?? 5173;
    const remoteOrigin = `http://localhost:${port}`;
    const code = patchViteClientCode(clientResult.code, remoteOrigin);
    sendJs(res, code);
  } catch (error) {
    next();
  }
  return true;
};

/**
 * Serve the react-refresh wrapper that re-uses the HOST's refresh
 * runtime singleton for cross-origin component registration.
 */
const handleReactRefresh = (res: ServerResponse): boolean => {
  sendJs(res, REACT_REFRESH_WRAPPER_CODE);
  return true;
};

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
    const result = await server.transformRequest('/@react-refresh');
    if (result) {
      sendJs(res, result.code);
      return true;
    }
  } catch {
    /* fall through */
  }
  next();
  return true;
};

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
    const match = url.match(/__federation_expose_(.+?)\.js/);
    if (match) {
      const exposeName = match[1];
      const exposeItem = parsedOptions.devExpose.find((item) => {
        const itemName = removeNonRegLetter(item[0], NAME_CHAR_REG);
        return itemName === exposeName;
      });
      if (exposeItem && exposeItem[1] && exposeItem[1].import) {
        const modulePath = exposeItem[1].import;
        const viteUrl = toViteUrl(modulePath, resolvedRoot);
        const code = `export { default } from '${viteUrl}';\nexport * from '${viteUrl}';`;
        sendJs(res, code);
      } else {
        res.statusCode = 404;
        res.end(`Expose module not found: ${exposeName}`);
      }
    } else {
      res.statusCode = 400;
      res.end('Invalid expose module URL');
    }
  } catch (error) {
    logger.error('Error loading expose module:', error);
    res.statusCode = 500;
    res.end('Internal server error');
  }
  return true;
};

// ---------------------------------------------------------------------------
// Shared module collection
// ---------------------------------------------------------------------------

/**
 * Collect all shared module specifiers into sharedSet, including
 * sub-path exports discovered from each package's exports map
 * (e.g. react/jsx-runtime, zustand/middleware).
 */
const collectSharedSpecifiers = (root: string): void => {
  for (const item of parsedOptions.devShared) {
    sharedSet.add(item[0]);
  }

  const nodeRequire = createRequire(join(root, 'package.json'));
  const baseNames = [...sharedSet];
  for (const baseName of baseNames) {
    try {
      const pkgJsonPath = nodeRequire.resolve(`${baseName}/package.json`);
      const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
      if (pkgJson.exports && typeof pkgJson.exports === 'object') {
        for (const subPath of Object.keys(pkgJson.exports)) {
          if (subPath !== '.' && subPath.startsWith('./')) {
            sharedSet.add(baseName + subPath.slice(1));
          }
        }
      }
    } catch {
      /* package.json not found or not readable */
    }
  }
};

// ---------------------------------------------------------------------------
// Pre-bundle build
// ---------------------------------------------------------------------------

/**
 * Build the federation pre-bundle using Rolldown: bundles ALL shared
 * modules in a single build with code splitting, then populates
 * sharedModuleMeta with discovered export names.
 */
const buildFederationPreBundle = async (root: string): Promise<void> => {
  const outDir = join(root, 'node_modules', FEDERATION_DEPS_DIR);
  mkdirSync(outDir, { recursive: true });

  const { build } = await import('rolldown');
  const sharedNames = [...sharedSet];

  const entries: Record<string, string> = {};
  for (const name of sharedNames) {
    entries[name.replace(/\//g, '_')] = name;
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
    });
  } catch (e) {
    logger.error(
      'Failed to build federation pre-bundle:',
      e instanceof Error ? e.message : e
    );
  }

  for (const name of sharedNames) {
    const fileName = name.replace(/\//g, '_') + '.js';
    const filePath = join(outDir, fileName);
    if (!existsSync(filePath)) {
      logger.warn('Pre-bundle missing for %s, skipping', name);
      continue;
    }
    const exports = await getPreBundleExports(filePath, name, root);
    const preBundleUrl = `/node_modules/${FEDERATION_DEPS_DIR}/${fileName}`;

    sharedModuleMeta.set(name, { preBundleUrl, exports });
  }

  logger.info('Pre-bundled shared modules:', [...sharedModuleMeta.keys()]);
};

// ---------------------------------------------------------------------------
// CORS middleware
// ---------------------------------------------------------------------------

/** Add CORS headers so the HOST browser can load files from this remote. */
const corsMiddleware = (
  req: IncomingMessage,
  res: ServerResponse,
  next: () => void
): void => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }
  next();
};

// ---------------------------------------------------------------------------
// Main plugin
// ---------------------------------------------------------------------------

export const devExposePlugin = (
  options: VitePluginFederationOptions
): PluginHooks => {
  parsedOptions.devExpose = parseExposeOptions(options);

  // Reset shared state for this plugin instance.
  // The module-level sharedSet/sharedModuleMeta are shared with
  // devSharedResolverPlugin (enforce:'pre').
  sharedSet.clear();
  sharedModuleMeta = new Map<string, SharedModuleMeta>();

  let resolvedRoot = process.cwd();

  let moduleMap = '';
  for (const item of parsedOptions.devExpose) {
    const name = removeNonRegLetter(item[0], NAME_CHAR_REG);
    moduleMap += `"${item[0]}":()=>{
      return __federation_import('./__federation_expose_${name}.js').then(module => Object.keys(module).every(item => exportSet.has(item)) ? () => module.default : () => module)},`;
  }

  return {
    name: [PLUGIN_PREFIX, 'expose-development'].join(':'),
    virtualFile: {
      [`${REMOTE_ENTRY_HELPER_PREFIX}${options.filename}`]:
        buildRemoteEntryCode(moduleMap)
    },
    async config(config: UserConfig) {
      resolvedRoot = config.root ? resolve(config.root) : process.cwd();

      // Only set up shared wrappers when this is a remote with shared modules
      if (!parsedOptions.devExpose.length || !parsedOptions.devShared.length) {
        return;
      }

      // Rolldown ships with Vite 8+.  Without it we can't build the
      // federation pre-bundle, so shared module interception is silently
      // disabled — the MFE still works standalone.
      try {
        await import('rolldown');
      } catch {
        return;
      }

      collectSharedSpecifiers(resolvedRoot);

      // Exclude ALL shared modules from Vite's dep optimizer so bare
      // specifier imports hit our resolveId hook instead.
      config.optimizeDeps ??= {};
      config.optimizeDeps.exclude = [
        ...(config.optimizeDeps.exclude ?? []),
        ...sharedSet
      ];
    },

    // Shared module resolution is handled by devSharedResolverPlugin
    // (enforce:'pre'), registered as a separate Vite plugin so it runs
    // BEFORE Vite's internal resolver.  The main federation plugin is
    // enforce:'post', which is too late to intercept bare specifiers
    // from pre-bundled deps.

    async configureServer(server) {
      if (sharedSet.size > 0) {
        await buildFederationPreBundle(resolvedRoot);
      }

      server.middlewares.use(corsMiddleware);

      server.middlewares.use(async (req, res, next) => {
        const url = req.url;

        if (url === `/${options.filename}`) {
          await handleRemoteEntry(server, options.filename!, res);
          return;
        }

        if (matchesUrl(url, '/@vite/client')) {
          await handleViteClient(server, res, next);
          return;
        }

        if (matchesUrl(url, '/@react-refresh')) {
          handleReactRefresh(res);
          return;
        }

        if (matchesUrl(url, '/@react-refresh-runtime')) {
          await handleReactRefreshRuntime(server, res, next);
          return;
        }

        if (url?.includes(FEDERATION_EXPOSE_PREFIX)) {
          handleExposeModule(url, resolvedRoot, res);
          return;
        }

        next();
      });
    }
  };
};
