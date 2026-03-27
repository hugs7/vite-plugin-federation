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

import { Node, walk } from 'estree-walker';
import MagicString from 'magic-string';
import { basename, dirname, extname, parse, relative, resolve } from 'path';
import type { Program } from 'estree';
import type { VitePluginFederationOptions } from 'types';
import type { ResolvedConfig, Rolldown } from 'vite';
import type { PluginHooks } from '../../types/pluginHooks';
import {
  builderInfo,
  DYNAMIC_LOADING_CSS_PREFIX,
  EXPOSES_KEY_MAP,
  EXPOSES_MAP,
  EXTERNALS,
  FEDERATION_EXPOSE_PREFIX,
  parsedOptions,
  PLUGIN_PREFIX,
  REMOTE_ENTRY_HELPER_PREFIX,
  SHARED,
  VITE_BASE_PLACEHOLDER,
  VITE_ASSETS_DIR_PLACEHOLDER,
  viteConfigResolved
} from '../public';
import { buildProdRemoteEntryCode } from './remote-entry-template';
import {
  getModuleMarker,
  NAME_CHAR_REG,
  normalizePath,
  parseExposeOptions,
  removeNonRegLetter,
  toJsArrayLiteral
} from '../utils';

export const prodExposePlugin = (
  options: VitePluginFederationOptions
): PluginHooks => {
  let moduleMap = '';
  const hasOptions = parsedOptions.prodExpose.some((expose) => {
    return expose[0] === parseExposeOptions(options)[0]?.[0];
  });
  if (!hasOptions) {
    parsedOptions.prodExpose = Array.prototype.concat(
      parsedOptions.prodExpose,
      parseExposeOptions(options)
    );
  }
  // exposes module
  for (const item of parseExposeOptions(options)) {
    const moduleName = getModuleMarker(`\${${item[0]}}`, SHARED);
    EXTERNALS.push(moduleName);
    const exposeFilepath = normalizePath(resolve(item[1].import));
    EXPOSES_MAP.set(item[0], exposeFilepath);
    EXPOSES_KEY_MAP.set(
      item[0],
      `${FEDERATION_EXPOSE_PREFIX}${removeNonRegLetter(item[0], NAME_CHAR_REG)}`
    );
    moduleMap += `\n"${item[0]}":()=>{
      ${DYNAMIC_LOADING_CSS}('${DYNAMIC_LOADING_CSS_PREFIX}${exposeFilepath}', ${item[1].dontAppendStylesToHead}, '${item[0]}')
      return __federation_import('\${__federation_expose_${item[0]}}').then(module =>Object.keys(module).every(item => exportSet.has(item)) ? () => module.default : () => module)},`;
  }

  return {
    name: [PLUGIN_PREFIX, 'expose-production'].join(':'),
    virtualFile: {
      [`${REMOTE_ENTRY_HELPER_PREFIX}${options.filename}`]:
        buildProdRemoteEntryCode(moduleMap, options.filename!, options.name)
    },

    configResolved(config: ResolvedConfig) {
      if (config) {
        viteConfigResolved.config = config;
      }
    },

    buildStart() {
      // if we don't expose any modules, there is no need to emit file
      if (parsedOptions.prodExpose.length > 0) {
        this.emitFile({
          fileName: `${
            builderInfo.assetsDir ? builderInfo.assetsDir + '/' : ''
          }${options.filename}`,
          type: 'chunk',
          id: `${REMOTE_ENTRY_HELPER_PREFIX}${options.filename}`,
          preserveSignature: 'strict'
        });
      }
    },

    generateBundle(_options, bundle) {
      // replace import absolute path to chunk's fileName in remoteEntry.js
      let remoteEntryChunk;
      for (const file in bundle) {
        const chunk = bundle[file];
        if (
          'facadeModuleId' in chunk &&
          chunk?.facadeModuleId ===
            `\0virtual:${REMOTE_ENTRY_HELPER_PREFIX}${options.filename}`
        ) {
          remoteEntryChunk = chunk;
          break;
        }
      }
      // placeholder replace
      if (remoteEntryChunk) {
        // 替换 base 和 assetsDir 占位符
        remoteEntryChunk.code = remoteEntryChunk.code
          .replace(
            VITE_BASE_PLACEHOLDER,
            `'${viteConfigResolved.config?.base || ''}'`
          )
          .replace(
            VITE_ASSETS_DIR_PLACEHOLDER,
            `'${viteConfigResolved.config?.build?.assetsDir || ''}'`
          );

        const filepathMap = new Map<string, any>();
        const getFilename = (name: string) => parse(parse(name).name).name;
        const cssBundlesMap: Map<
          string,
          Rolldown.OutputAsset | Rolldown.OutputChunk
        > = Object.keys(bundle)
          .filter((name) => extname(name) === '.css')
          .reduce((res, name) => {
            const filename = getFilename(name);
            res.set(filename, bundle[name]);
            return res;
          }, new Map());
        remoteEntryChunk.code = remoteEntryChunk.code.replace(
          new RegExp(`(["'\`])${DYNAMIC_LOADING_CSS_PREFIX}.*?\\1`, 'g'),
          (str) => {
            // when build.cssCodeSplit: false, all files are aggregated into style.xxxxxxxx.css
            if (
              viteConfigResolved.config &&
              !viteConfigResolved.config.build.cssCodeSplit
            ) {
              if (cssBundlesMap.size) {
                return toJsArrayLiteral(
                  [...cssBundlesMap.values()].map((b) => basename(b.fileName))
                );
              } else {
                return '[]';
              }
            }
            const filepath = str.slice(
              (`'` + DYNAMIC_LOADING_CSS_PREFIX).length,
              -1
            );
            if (!filepath || !filepath.length) return str;
            let fileBundle = filepathMap.get(filepath);
            if (!fileBundle) {
              fileBundle = Object.values(bundle).find(
                (b) => 'facadeModuleId' in b && b.facadeModuleId === filepath
              );
              if (fileBundle) filepathMap.set(filepath, fileBundle);
              else return str;
            }
            const depCssFiles: Set<string> = new Set();
            const addDepCss = (bundleName: string) => {
              const theBundle = bundle[bundleName] as any;
              if (theBundle && theBundle.viteMetadata) {
                for (const cssFileName of theBundle.viteMetadata.importedCss.values()) {
                  const cssBundle = cssBundlesMap.get(getFilename(cssFileName));
                  if (cssBundle) {
                    depCssFiles.add(cssBundle.fileName);
                  }
                }
              }
              if (theBundle && theBundle.imports && theBundle.imports.length) {
                theBundle.imports.forEach((name) => addDepCss(name));
              }
            };

            [fileBundle.fileName, ...fileBundle.imports].forEach(addDepCss);

            return toJsArrayLiteral([...depCssFiles].map((d) => basename(d)));
          }
        );

        // replace the export file placeholder path to final chunk path
        for (const expose of parseExposeOptions(options)) {
          const module = Object.keys(bundle).find((module) => {
            const chunk = bundle[module];
            return chunk.name === EXPOSES_KEY_MAP.get(expose[0]);
          });

          if (module) {
            const chunk = bundle[module];
            const fileRelativePath = relative(
              dirname(remoteEntryChunk.fileName),
              chunk.fileName
            );
            const slashPath = fileRelativePath.replace(/\\/g, '/');
            remoteEntryChunk.code = remoteEntryChunk.code.replace(
              `\${${FEDERATION_EXPOSE_PREFIX}${expose[0]}}`,
              viteConfigResolved.config?.base?.replace(/\/+$/, '')
                ? [
                    viteConfigResolved.config.base.replace(/\/+$/, ''),
                    viteConfigResolved.config.build?.assetsDir?.replace(
                      /\/+$/,
                      ''
                    ),
                    slashPath
                  ]
                    .filter(Boolean)
                    .join('/')
                : `./${slashPath}`
            );
          }
        }

        // remove all __f__dynamic_loading_css__ after replace
        let ast: Program | null = null;
        try {
          ast = this.parse(remoteEntryChunk.code) as Program;
        } catch (err) {
          console.error(err);
        }
        if (!ast) {
          return;
        }
        const magicString = new MagicString(remoteEntryChunk.code);
        walk(ast as Node, {
          enter(node: any) {
            if (
              node &&
              node.type === 'CallExpression' &&
              typeof node.arguments[0]?.value === 'string' &&
              node.arguments[0]?.value.indexOf(
                `${DYNAMIC_LOADING_CSS_PREFIX}`
              ) > -1
            ) {
              magicString.remove(node.start, node.end + 1);
            }
          }
        });
        remoteEntryChunk.code = magicString.toString();
      }
    }
  };
};
