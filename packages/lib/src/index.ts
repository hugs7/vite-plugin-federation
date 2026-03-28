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

import virtual from '@rollup/plugin-virtual';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  ConfigEnv,
  Plugin,
  ResolvedConfig,
  Rolldown,
  UserConfig,
  ViteDevServer
} from 'vite';

import type { VitePluginFederationOptions } from '../types';
import type { PluginHooks } from '../types/pluginHooks';
import {
  devExposePlugin,
  devSharedResolverPlugin
} from './dev/expose-development';
import { devRemotePlugin } from './dev/remote-development';
import { devSharedPlugin } from './dev/shared-development';
import { prodExposePlugin } from './prod/expose-production';
import { prodRemotePlugin } from './prod/remote-production';
import { prodSharedPlugin } from './prod/shared-production';
import {
  builderInfo,
  DEFAULT_ENTRY_FILENAME,
  parsedOptions,
  PLUGIN_PREFIX,
  VIRTUAL_FEDERATION,
  VIRTUAL_FEDERATION_RESOLVED,
  VIRTUAL_FN_IMPORT_RESOLVED,
  VIRTUAL_FN_SATISFY
} from './public';

const federation = (options: VitePluginFederationOptions): Plugin[] => {
  if (!options.filename) {
    options.filename = DEFAULT_ENTRY_FILENAME;
  }

  let pluginList: PluginHooks[] = [];
  let virtualMod;
  let registerCount = 0;

  const registerPlugins = (mode: string, command: string) => {
    if (mode === 'test') {
      pluginList = [];
    } else if (mode === 'production' || command === 'build') {
      pluginList = [
        prodSharedPlugin(options),
        prodExposePlugin(options),
        prodRemotePlugin(options)
      ];
    } else if (mode === 'development' || command === 'serve') {
      pluginList = [
        devSharedPlugin(options),
        devExposePlugin(options),
        devRemotePlugin(options)
      ];
    } else {
      pluginList = [];
    }

    builderInfo.isHost = !!(
      parsedOptions.prodRemote.length ||
      parsedOptions.devRemote.length ||
      parsedOptions.prodShared.length ||
      parsedOptions.devShared.length
    );
    builderInfo.isRemote = !!(
      parsedOptions.prodExpose.length || parsedOptions.devExpose.length
    );
    builderInfo.isShared = !!(
      parsedOptions.prodShared.length || parsedOptions.devShared.length
    );

    let virtualFiles = {};
    pluginList.forEach((plugin) => {
      if (plugin.virtualFile) {
        virtualFiles = Object.assign(virtualFiles, plugin.virtualFile);
      }
    });
    virtualMod = virtual(virtualFiles);
  };

  const mainPlugin: Plugin = {
    name: [PLUGIN_PREFIX, 'federation'].join(':'),
    // for scenario vite.config.js build.cssCodeSplit: false
    // vite:css-post plugin will summarize all the styles in the style.xxxxxx.css file
    // so, this plugin need run after vite:css-post in post plugin list
    enforce: 'post',
    options(_options) {
      // rollup doesn't have options.mode and options.command
      if (!registerCount++) {
        registerPlugins((options.mode = options.mode ?? 'production'), '');
      }

      if (typeof _options.input === 'string') {
        _options.input = { index: _options.input };
      }
      _options.external = _options.external || [];
      if (!Array.isArray(_options.external)) {
        _options.external = [_options.external as string];
      }
      for (const pluginHook of pluginList) {
        pluginHook.options?.call(this, _options);
      }
      return _options;
    },
    async config(config: UserConfig, env: ConfigEnv) {
      options.mode = options.mode ?? env.mode;
      registerPlugins(options.mode, env.command);
      registerCount++;
      for (const pluginHook of pluginList) {
        await pluginHook.config?.call(this, config, env);
      }

      // only run when builder is vite since rollup doesn't have hook named `config`
      builderInfo.builder = 'vite';
      builderInfo.assetsDir = config?.build?.assetsDir ?? 'assets';
    },
    async configureServer(server: ViteDevServer) {
      for (const pluginHook of pluginList) {
        await pluginHook.configureServer?.call(this, server);
      }
    },
    configResolved(config: ResolvedConfig) {
      for (const pluginHook of pluginList) {
        pluginHook.configResolved?.call(this, config);
      }
    },
    buildStart(inputOptions) {
      for (const pluginHook of pluginList) {
        pluginHook.buildStart?.call(this, inputOptions);
      }
    },

    async resolveId(...args) {
      // Check sub-plugins first (e.g. shared module virtual resolution)
      for (const pluginHook of pluginList) {
        const result = await pluginHook.resolveId?.call(this, ...args);
        if (result) {
          return result;
        }
      }

      const v = virtualMod.resolveId.call(this, ...args);
      if (v) {
        return v;
      }
      if (args[0] === VIRTUAL_FN_IMPORT_RESOLVED) {
        return {
          id: VIRTUAL_FN_IMPORT_RESOLVED,
          moduleSideEffects: true
        };
      }
      if (args[0] === VIRTUAL_FN_SATISFY) {
        const federationId = (
          await this.resolve('@hugs7/vite-plugin-federation')
        )?.id;
        const pluginDir = federationId
          ? dirname(federationId)
          : dirname(fileURLToPath(import.meta.url));
        return await this.resolve(`${pluginDir}/satisfy.mjs`);
      }
      if (args[0] === VIRTUAL_FEDERATION) {
        return {
          id: VIRTUAL_FEDERATION_RESOLVED,
          moduleSideEffects: true
        };
      }
      return null;
    },

    load(...args) {
      // Check sub-plugins first
      for (const pluginHook of pluginList) {
        const result = pluginHook.load?.call(this, ...args);
        if (result) {
          return result;
        }
      }

      const v = virtualMod.load.call(this, ...args);
      if (v) {
        return v;
      }
      return null;
    },

    transform(code: string, id: string) {
      for (const pluginHook of pluginList) {
        const result = pluginHook.transform?.call(this, code, id);
        if (result) {
          return result;
        }
      }
      return code;
    },
    moduleParsed(moduleInfo: Rolldown.ModuleInfo): void {
      for (const pluginHook of pluginList) {
        pluginHook.moduleParsed?.call(this, moduleInfo);
      }
    },

    outputOptions(outputOptions) {
      for (const pluginHook of pluginList) {
        pluginHook.outputOptions?.call(this, outputOptions);
      }
      return outputOptions;
    },

    renderChunk(code, chunkInfo, _options) {
      for (const pluginHook of pluginList) {
        const result = pluginHook.renderChunk?.call(
          this,
          code,
          chunkInfo,
          _options
        );
        if (result) {
          return result;
        }
      }
      return null;
    },

    generateBundle(_options, bundle, isWrite) {
      for (const pluginHook of pluginList) {
        pluginHook.generateBundle?.call(this, _options, bundle, isWrite);
      }
    }
  };

  // Return the main plugin + the enforce:'pre' shared resolver.
  // Vite flattens plugin arrays, so this works transparently.
  // devSharedResolverPlugin runs before Vite's internal resolver to
  // intercept shared module imports.  It's a no-op in production or
  // when no shared modules are configured.
  return [mainPlugin, devSharedResolverPlugin];
};

export default federation;
