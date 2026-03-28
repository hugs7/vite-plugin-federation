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

import type { Program } from 'estree';
import { readFileSync } from 'fs';
import MagicString from 'magic-string';
import type { ConfigTypeSet, VitePluginFederationOptions } from 'types';
import type { Rolldown, UserConfig, ViteDevServer } from 'vite';

import type { PluginHooks } from '../../types/pluginHooks';
import { createLogger } from '../logger';
import {
  builderInfo,
  devRemotes,
  parsedOptions,
  PLUGIN_PREFIX,
  REMOTE_FROM_PARAMETER,
  VIRTUAL_FEDERATION_RESOLVED
} from '../public';
import { buildFederationRuntimeCode } from '../runtime/federation-runtime';
import {
  applyFederationImportPreamble,
  rewriteRemoteImports
} from '../transform/rewrite-remote-imports';
import {
  createRemotesMap,
  getFileExtname,
  getModuleMarker,
  matchesUrl,
  parseRemoteOptions,
  sendJs
} from '../utils';

const logger = createLogger('remote');

export const devRemotePlugin = (
  options: VitePluginFederationOptions
): PluginHooks => {
  parsedOptions.devRemote = parseRemoteOptions(options);
  // const remotes: { id: string; regexp: RegExp; config: RemotesConfig }[] = []
  for (const item of parsedOptions.devRemote) {
    devRemotes.push({
      id: item[0],
      regexp: new RegExp(`^${item[0]}/.+?`),
      config: item[1]
    });
  }

  const needHandleFileType = [
    '.js',
    '.ts',
    '.jsx',
    '.tsx',
    '.mjs',
    '.cjs',
    '.vue',
    '.svelte'
  ];
  options.transformFileTypes = (options.transformFileTypes ?? [])
    .concat(needHandleFileType)
    .map((item) => item.toLowerCase());
  const transformFileTypeSet = new Set(options.transformFileTypes);
  const hasRemotes = !!options.remotes;
  const hasShared = parsedOptions.devShared.length > 0;
  const needsFederationModule = hasRemotes || hasShared;

  const excludeRemotesFromOptimizeDeps = (config: UserConfig) => {
    if (parsedOptions.devRemote.length) {
      const excludeRemotes: string[] = [];
      parsedOptions.devRemote.forEach((item) => excludeRemotes.push(item[0]));
      config.optimizeDeps ??= {};
      config.optimizeDeps.exclude ??= [];
      config.optimizeDeps.exclude =
        config.optimizeDeps.exclude.concat(excludeRemotes);
    }
  };

  const handleHostReactRefresh = (server: ViteDevServer) => {
    // Patch /@react-refresh on the HOST so it stores itself as a
    // global singleton.  When a federated remote loads its own
    // /@react-refresh from a different origin, it can re-export
    // this singleton — ensuring all component families and mounted
    // roots are tracked in one place for React Fast Refresh.
    if (parsedOptions.devRemote.length) {
      server.middlewares.use(async (req, res, next) => {
        const url = req.url;
        if (matchesUrl(url, '/@react-refresh')) {
          try {
            const result = await server.transformRequest('/@react-refresh');
            if (result) {
              const code = `${result.code}
if(typeof window!=='undefined'){
  window.__vite_react_refresh_runtime__={
    injectIntoGlobalHook,register,createSignatureFunctionForTransform,
    isLikelyComponentType,getFamilyByType,performReactRefresh,
    setSignature,collectCustomHooksForSignature,
    validateRefreshBoundaryAndEnqueueUpdate,
    registerExportsForReactRefresh,__hmr_import
  };
}
`;
              sendJs(res, code);
              return;
            }
          } catch {
            /* fall through */
          }
        }
        next();
      });
    }
  };

  const devSharedScopeCode = async (
    shared: (string | ConfigTypeSet)[]
  ): Promise<string[]> => {
    const res: string[] = [];
    if (shared.length) {
      for (const item of shared) {
        const sharedName = item[0];
        const obj = item[1];
        if (typeof obj === 'object') {
          const str = `get:() => import('${sharedName}').then(m => {
            const keys = Object.keys(m);
            const hasNamed = keys.some(k => k !== 'default' && k !== '__esModule');
            return () => hasNamed ? m : (m.default ?? m);
          })`;
          res.push(`'${sharedName}':{'${obj.version}':{${str}}}`);
        }
      }
    }
    return res;
  };

  return {
    name: [PLUGIN_PREFIX, 'remote-development'].join(':'),
    virtualFile: needsFederationModule
      ? {
          __federation__: buildFederationRuntimeCode({
            remotesMapCode: hasRemotes
              ? createRemotesMap(devRemotes)
              : 'const remotesMap = {};',
            getFunctionCode: `function get(name, ${REMOTE_FROM_PARAMETER}){
  return import(/* @vite-ignore */ name).then(module => ()=> {
    if ((globalThis.__federation_shared_remote_from__ ?? ${REMOTE_FROM_PARAMETER}) === 'webpack') {
      return Object.prototype.toString.call(module).indexOf('Module') > -1 && module.default ? module.default : module;
    }
    return module;
  });
}`,
            shareScopeWrapperCode: `const wrapShareScope = ${REMOTE_FROM_PARAMETER} => {
  return {
    ${getModuleMarker('shareScope')}
  }
}`
          })
        }
      : { __federation__: '' },
    config: (config: UserConfig) => excludeRemotesFromOptimizeDeps(config),

    configureServer: (server) => handleHostReactRefresh(server),
    async transform(
      this: Rolldown.TransformPluginContext,
      code: string,
      id: string
    ) {
      if (builderInfo.isHost || builderInfo.isShared) {
        for (const arr of parsedOptions.devShared) {
          if (!arr[1].version && !arr[1].manuallyPackagePathSetting) {
            const packageJsonPath = (
              await this.resolve(`${arr[0]}/package.json`)
            )?.id;
            if (!packageJsonPath) {
              this.error(
                `No description file or no version in description file (usually package.json) of ${arr[0]}(${packageJsonPath}). Add version to description file, or manually specify version in shared config.`
              );
            } else {
              const json = JSON.parse(
                readFileSync(packageJsonPath, { encoding: 'utf-8' })
              );
              arr[1].version = json.version;
            }
          }
        }
      }

      if (id === VIRTUAL_FEDERATION_RESOLVED) {
        const scopeCode = await devSharedScopeCode(parsedOptions.devShared);
        return code.replace(getModuleMarker('shareScope'), scopeCode.join(','));
      }

      // ignore some not need to handle file types
      const fileExtname = getFileExtname(id);
      if (!transformFileTypeSet.has((fileExtname ?? '').toLowerCase())) {
        return;
      }

      let ast: Program | null = null;
      try {
        ast = this.parse(code) as Program;
      } catch (err) {
        logger.error('Failed to parse %s:', id, err);
      }
      if (!ast) {
        return null;
      }

      const magicString = new MagicString(code);
      const result = rewriteRemoteImports(ast, magicString, devRemotes);
      applyFederationImportPreamble(magicString, result);
      return magicString.toString();
    }
  };
};
