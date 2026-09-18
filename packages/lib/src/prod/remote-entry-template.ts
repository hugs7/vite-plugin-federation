/**
 * Prod remote entry virtual module template.
 *
 * Generates the remoteEntry.js code for production builds with CSS
 * dynamic loading, module map, and shared scope init.
 */

import {
  DYNAMIC_LOADING_CSS,
  VITE_BASE_PLACEHOLDER,
  VITE_ASSETS_DIR_PLACEHOLDER,
  VIRTUAL_FN_IMPORT
} from '../public';
import { FEDERATION_IMPORT_SNIPPET } from '../runtime/snippets';

/**
 * When the remote consumes shared modules, resolve all of them once the host
 * has called init() and before any exposed module is handed out. Bundled CJS
 * dependencies that `require('<shared>')` cannot await, so they rely on the
 * shared instance already being available (see importSharedSync).
 */
const buildSharedPreloadCode = (hasShared: boolean) =>
  hasShared
    ? {
        imports: `import { preloadShared } from '${VIRTUAL_FN_IMPORT}';`,
        state: `let sharedReady = null;`,
        onInit: `sharedReady = preloadShared();`,
        onGet: `if (sharedReady) await sharedReady;`
      }
    : { imports: '', state: '', onInit: '', onGet: '' };

export const buildProdRemoteEntryCode = (
  moduleMap: string,
  filename: string,
  name?: string,
  hasShared = false
): string => {
  const preload = buildSharedPreloadCode(hasShared);
  return `
${preload.imports}
${FEDERATION_IMPORT_SNIPPET}
${preload.state}
const exportSet = new Set(['Module', '__esModule', 'default', '_export_sfc']);
let moduleMap = {${moduleMap}};
const seen = {};
export const ${DYNAMIC_LOADING_CSS} = (cssFilePaths, dontAppendStylesToHead, exposeItemName) => {
  const metaUrl = import.meta.url;
  if (typeof metaUrl === 'undefined') {
    console.warn('The remote style takes effect only when the build.target option in the vite.config.ts file is higher than that of "es2020".');
    return;
  }

  const curUrl = metaUrl.substring(0, metaUrl.lastIndexOf('${filename}'));
  const base = ${VITE_BASE_PLACEHOLDER};
  const assetsDir = ${VITE_ASSETS_DIR_PLACEHOLDER};

  cssFilePaths.forEach(cssPath => {
    let href = '';
    const baseUrl = base || curUrl;
    if (baseUrl) {
      const trimmer = {
        trailing: (path) => (path.endsWith('/') ? path.slice(0, -1) : path),
        leading: (path) => (path.startsWith('/') ? path.slice(1) : path)
      }
      const isAbsoluteUrl = (url) => url.startsWith('http') || url.startsWith('//');

      const cleanBaseUrl = trimmer.trailing(baseUrl);
      const cleanCssPath = trimmer.leading(cssPath);
      const cleanCurUrl = trimmer.trailing(curUrl);

      if (isAbsoluteUrl(baseUrl)) {
        href = [cleanBaseUrl, cleanCssPath].filter(Boolean).join('/');
      } else {
        if (cleanCurUrl.includes(cleanBaseUrl)) {
          href = [cleanCurUrl, cleanCssPath].filter(Boolean).join('/');
        } else {
          href = [cleanCurUrl + cleanBaseUrl, cleanCssPath].filter(Boolean).join('/');
        }
      }
    } else {
      href = cssPath;
    }

    if (dontAppendStylesToHead) {
      const key = 'css__${name}__' + exposeItemName;
      window[key] = window[key] || [];
      window[key].push(href);
      return;
    }

    if (href in seen) return;
    seen[href] = true;

    const element = document.createElement('link');
    element.rel = 'stylesheet';
    element.href = href;
    document.head.appendChild(element);
  });
};
export const get = async (module) => {
  if(!moduleMap[module]) throw new Error('Can not find remote module ' + module);
  ${preload.onGet}
  return moduleMap[module]();
};
export const init = (shareScope) => {
  globalThis.__federation_shared__= globalThis.__federation_shared__|| {};
  Object.entries(shareScope).forEach(([key, value]) => {
    for (const [versionKey, versionValue] of Object.entries(value)) {
      const scope = versionValue.scope || 'default';
      globalThis.__federation_shared__[scope] = globalThis.__federation_shared__[scope] || {};
      const shared = globalThis.__federation_shared__[scope];
      (shared[key] = shared[key]||{})[versionKey] = versionValue;
    }
  });
  ${preload.onInit}
};`;
};
