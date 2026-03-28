import { ViteDevServer } from 'vite';
import { ServerResponse } from 'node:http';

import { sendJs } from 'src/utils';

const REACT_REFRESH_WRAPPER_CODE = `
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

/**
 * Serve the react-refresh wrapper that re-uses the HOST's refresh
 * runtime singleton for cross-origin component registration.
 */
export const handleReactRefresh = (res: ServerResponse): boolean => {
  sendJs(res, REACT_REFRESH_WRAPPER_CODE);
  return true;
};

/**
 * Serve the real react-refresh runtime under an alternate URL
 * so the wrapper can import it without recursion.
 */
export const handleReactRefreshRuntime = async (
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
