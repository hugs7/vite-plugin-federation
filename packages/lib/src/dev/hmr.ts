/**
 * HMR utilities for dev-mode federation.
 *
 * Contains the react-refresh wrapper for cross-origin singleton sharing
 * and the @vite/client patching for absolute remote origins.
 */

export const REACT_REFRESH_WRAPPER_CODE = `
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
`;

export const patchViteClientCode = (
  code: string,
  remoteOrigin: string
): string => {
  code = code.replace(
    /const base = "\/"\s*\|\|\s*"\/";/,
    `const base = "${remoteOrigin}/";`
  );
  code = code.replace(
    /const base\$1 = "\/"\s*\|\|\s*"\/";/,
    `const base$1 = "${remoteOrigin}/";`
  );
  return code;
};
