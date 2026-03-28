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

import { walk } from 'estree-walker';
import MagicString from 'magic-string';
import path from 'node:path';
import type { Program } from 'estree';
import type { VitePluginFederationOptions } from 'types';
import type { PluginHooks } from '../../types/pluginHooks';
import {
  builderInfo,
  EXPOSES_KEY_MAP,
  parsedOptions,
  PLUGIN_PREFIX,
  prodRemotes,
  VIRTUAL_FN_IMPORT_RESOLVED
} from '../public';
import {
  createRemotesMap,
  getModuleMarker,
  parseRemoteOptions,
  REMOTE_FROM_PARAMETER,
  injectToHead,
  toOutputFilePathWithoutRuntime,
  toPreloadTag
} from '../utils';
import { buildFederationRuntimeCode } from '../runtime/federation-runtime';
import {
  rewriteRemoteImports,
  applyFederationImportPreamble
} from '../transform/rewrite-remote-imports';
import type { ResolvedConfig, Rolldown } from 'vite';

export const prodRemotePlugin = (
  options: VitePluginFederationOptions
): PluginHooks => {
  parsedOptions.prodRemote = parseRemoteOptions(options);
  // const remotes: Remote[] = []
  for (const item of parsedOptions.prodRemote) {
    prodRemotes.push({
      id: item[0],
      regexp: new RegExp(`^${item[0]}/.+?`),
      config: item[1]
    });
  }

  const shareScope = options.shareScope || 'default';
  let resolvedConfig: ResolvedConfig;
  let federationRuntimeEmitted = false;
  const hasRemotes = !!options.remotes;
  const hasShared = parsedOptions.prodShared.length > 0;
  const needsFederationModule = hasRemotes || hasShared;
  return {
    name: [PLUGIN_PREFIX, 'remote-production'].join(':'),
    virtualFile: needsFederationModule
      ? {
          __federation__: buildFederationRuntimeCode({
            remotesMapCode: hasRemotes
              ? createRemotesMap(prodRemotes)
              : 'const remotesMap = {};',
            extraPreludeCode: `const currentImports = {};
const merge = (obj1, obj2) => {
  const mergedObj = Object.assign(obj1, obj2);
  for (const key of Object.keys(mergedObj)) {
    if (typeof mergedObj[key] === 'object' && typeof obj2[key] === 'object') {
      mergedObj[key] = merge(mergedObj[key], obj2[key]);
    }
  }
  return mergedObj;
};
const __federation_import = async (name) => {
    currentImports[name] ??= import(name);
    return currentImports[name];
};`,
            getFunctionCode: `function get(name, ${REMOTE_FROM_PARAMETER}) {
    return __federation_import(name).then(module => () => {
        if ((globalThis.__federation_shared_remote_from__ ?? ${REMOTE_FROM_PARAMETER}) === 'webpack') {
            return Object.prototype.toString.call(module).indexOf('Module') > -1 && module.default ? module.default : module;
        }
        return module;
    });
}`,
            shareScopeWrapperCode: `const wrapShareScope = ${REMOTE_FROM_PARAMETER} => {
  globalThis.__federation_shared_remote_from__ = ${REMOTE_FROM_PARAMETER};
  return merge({
     ${getModuleMarker('shareScope')}
  }, (globalThis.__federation_shared__ || {})['${shareScope}'] || {});
}`
          })
        }
      : { __federation__: '' },
    configResolved(config) {
      resolvedConfig = config;
    },

    async transform(
      this: Rolldown.TransformPluginContext,
      code: string,
      id: string
    ) {
      if (builderInfo.isShared) {
        for (const sharedInfo of parsedOptions.prodShared) {
          if (!sharedInfo[1].emitFile) {
            sharedInfo[1].emitFile = this.emitFile({
              type: 'chunk',
              id: sharedInfo[1].id ?? sharedInfo[1].packagePath,
              preserveSignature: 'strict',
              name: `__federation_shared_${sharedInfo[0]}`
            });
          }
        }

        if (id === VIRTUAL_FN_IMPORT_RESOLVED) {
          const moduleMapCode = parsedOptions.prodShared
            .filter((shareInfo) => shareInfo[1].generate)
            .map(
              (sharedInfo) =>
                `'${
                  sharedInfo[0]
                }':{get:()=>()=>__federation_import(import.meta.ROLLUP_FILE_URL_${
                  sharedInfo[1].emitFile
                }),import:${sharedInfo[1].import}${
                  sharedInfo[1].requiredVersion
                    ? `,requiredVersion:'${sharedInfo[1].requiredVersion}'`
                    : ''
                }}`
            )
            .join(',');
          return code.replace(
            getModuleMarker('moduleMap', 'var'),
            `{${moduleMapCode}}`
          );
        }
      }

      if (builderInfo.isRemote) {
        for (const expose of parsedOptions.prodExpose) {
          if (!expose[1].emitFile) {
            expose[1].emitFile = this.emitFile({
              type: 'chunk',
              id: expose[1].id ?? expose[1].import,
              name: EXPOSES_KEY_MAP.get(expose[0]),
              preserveSignature: 'allow-extension'
            });
          }
        }
      }

      // Emit the federation runtime as its own chunk to prevent it from being
      // inlined into the entry. Without this, modules that use remote imports
      // (e.g. in vendor-framework) would import federation functions from the
      // entry chunk, creating circular static imports that deadlock when
      // combined with TLA from await importShared().
      if (
        builderInfo.isHost &&
        needsFederationModule &&
        !federationRuntimeEmitted
      ) {
        federationRuntimeEmitted = true;
        this.emitFile({
          type: 'chunk',
          id: '__federation__',
          name: '__federation_runtime__',
          preserveSignature: 'strict'
        });
      }

      if (builderInfo.isHost) {
        if (id === '\0virtual:__federation__') {
          const res: string[] = [];
          parsedOptions.prodShared.forEach((arr) => {
            const obj = arr[1];
            let str = '';
            if (typeof obj === 'object') {
              const fileUrl = `import.meta.ROLLUP_FILE_URL_${obj.emitFile}`;
              str += `get:() => get(${fileUrl}, ${REMOTE_FROM_PARAMETER}), loaded:1`;
              res.push(`'${arr[0]}':{'${obj.version}':{${str}}}`);
            }
          });
          return code.replace(getModuleMarker('shareScope'), res.join(','));
        }
      }

      if (builderInfo.isHost || builderInfo.isShared) {
        const isNodeModules =
          id.includes('/node_modules/') || id.includes('\\node_modules\\');

        if (isNodeModules) {
          if (!builderInfo.isRemote) {
            // Host-only builds: skip node_modules entirely — transforming
            // them to await importShared() creates TLA in vendor chunks
            // that often contain the shared modules themselves, causing
            // self-referential deadlocks during module evaluation.
            return null;
          }

          // Remote builds: allow the transform for third-party libraries
          // so their shared-module imports (e.g. react) go through
          // importShared() — preventing duplicate module instances at
          // runtime.  However, skip files that belong to a shared module's
          // own package to avoid self-referential deadlocks (e.g.
          // react/index.js importing itself via importShared('react')).
          const normalizedId = id.replace(/\\/g, '/');
          const isSharedModuleSource = parsedOptions.prodShared.some(
            (sharedInfo) => {
              const sharedName = sharedInfo[0];
              // Match node_modules/<sharedName>/ or node_modules/@scope/pkg/
              const pattern = `/node_modules/${sharedName}/`;
              return normalizedId.includes(pattern);
            }
          );
          if (isSharedModuleSource) {
            return null;
          }
        }

        let ast: Program | null = null;
        try {
          ast = this.parse(code) as Program;
        } catch (err) {
          console.error(err);
        }
        if (!ast) {
          return null;
        }

        const magicString = new MagicString(code);
        let hasImportShared = false;
        let modify = false;

        walk(ast, {
          enter(node: any) {
            // handle share, eg. replace import {a} from b  -> const a = importShared('b')
            if (node.type === 'ImportDeclaration') {
              const moduleName = node.source.value;
              if (
                parsedOptions.prodShared.some(
                  (sharedInfo) => sharedInfo[0] === moduleName
                )
              ) {
                const namedImportDeclaration: (string | never)[] = [];
                let defaultImportDeclaration: string | null = null;
                if (!node.specifiers?.length) {
                  // invalid import , like import './__federation_shared_lib.js' , and remove it
                  magicString.remove(node.start, node.end);
                  modify = true;
                } else {
                  node.specifiers.forEach((specify) => {
                    if (specify.imported?.name) {
                      namedImportDeclaration.push(
                        `${
                          specify.imported.name === specify.local.name
                            ? specify.imported.name
                            : `${specify.imported.name}:${specify.local.name}`
                        }`
                      );
                    } else {
                      defaultImportDeclaration = specify.local.name;
                    }
                  });

                  hasImportShared = true;

                  if (
                    defaultImportDeclaration &&
                    namedImportDeclaration.length
                  ) {
                    const imports = namedImportDeclaration.join(',');
                    const line = `const ${defaultImportDeclaration} = await importShared('${moduleName}');\nconst {${imports}} = ${defaultImportDeclaration};\n`;
                    magicString.overwrite(node.start, node.end, line);
                  } else if (defaultImportDeclaration) {
                    magicString.overwrite(
                      node.start,
                      node.end,
                      `const ${defaultImportDeclaration} = await importShared('${moduleName}');\n`
                    );
                  } else if (namedImportDeclaration.length) {
                    magicString.overwrite(
                      node.start,
                      node.end,
                      `const {${namedImportDeclaration.join(
                        ','
                      )}} = await importShared('${moduleName}');\n`
                    );
                  }
                }
              }
            }
          }
        });

        const rewriteResult = rewriteRemoteImports(
          ast,
          magicString,
          prodRemotes
        );
        applyFederationImportPreamble(magicString, rewriteResult);

        if (hasImportShared) {
          magicString.prepend(
            `import {importShared} from '${VIRTUAL_FN_IMPORT_RESOLVED}';\n`
          );
        }

        if (rewriteResult.requiresRuntime || hasImportShared || modify) {
          return {
            code: magicString.toString(),
            map: magicString.generateMap({ hires: true })
          };
        }
      }
    },

    generateBundle(options, bundle) {
      const preloadSharedReg = parsedOptions.prodShared
        .filter((shareInfo) => shareInfo[1].modulePreload)
        .map(
          (item) => new RegExp(`__federation_shared_${item[0]}-.{8}.js`, 'g')
        );
      const getImportedChunks = (
        chunk: Rolldown.OutputChunk,
        satisfy: (chunk: Rolldown.OutputChunk) => boolean,
        seen: Set<string> = new Set()
      ): Rolldown.OutputChunk[] => {
        const chunks: Rolldown.OutputChunk[] = [];
        chunk.imports.forEach((file) => {
          const importee = bundle[file];
          if (importee) {
            if (importee.type === 'chunk' && !seen.has(file)) {
              if (satisfy(importee)) {
                seen.add(file);
                chunks.push(...getImportedChunks(importee, satisfy, seen));
                chunks.push(importee);
              }
            }
          }
        });
        return chunks;
      };

      const sharedFiles: string[] = [];
      const entryChunk: Record<string, Rolldown.OutputAsset> = {};
      for (const fileName in bundle) {
        const file = bundle[fileName];
        if (file.type === 'asset') {
          if (fileName.endsWith('.html')) {
            entryChunk[fileName] = file;
          }
        } else {
          if (preloadSharedReg.some((item) => item.test(fileName))) {
            sharedFiles.push(fileName);
          }
        }
      }

      if (!sharedFiles.length) return;

      Object.keys(entryChunk).forEach((fileName) => {
        let html = entryChunk[fileName].source as string;
        const htmlPath = entryChunk[fileName].fileName;
        const basePath =
          resolvedConfig.base === './' || resolvedConfig.base === ''
            ? path.posix.join(
                path.posix
                  .relative(entryChunk[fileName].fileName, '')
                  .slice(0, -2),
                './'
              )
            : resolvedConfig.base;

        const toOutputFilePath = (filename: string) =>
          toOutputFilePathWithoutRuntime(
            filename,
            'asset',
            htmlPath,
            'html',
            resolvedConfig,
            (filename) => basePath + filename
          );

        const importFiles = sharedFiles
          .filter((item) => {
            return !html.includes(toOutputFilePath(item));
          })
          .flatMap((item) => {
            const filepath = item;
            const importFiles = getImportedChunks(
              bundle[item] as Rolldown.OutputChunk,
              (chunk) => !html.includes(toOutputFilePath(chunk.fileName))
            ).map((item) => item.fileName);

            return [filepath, ...importFiles].map((item) =>
              toOutputFilePath(item)
            );
          });

        html = injectToHead(
          html,
          [...new Set(importFiles)].map((item) => toPreloadTag(item))
        );

        entryChunk[fileName].source = html;
      });
    }
  };
};
