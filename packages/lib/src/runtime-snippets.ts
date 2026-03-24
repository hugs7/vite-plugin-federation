/**
 * Reusable code snippets emitted into generated runtime modules.
 *
 * These are string constants injected into virtual files that run in
 * the browser.  Centralising them here avoids duplication between the
 * dev and prod plugin files.
 */

// ---------------------------------------------------------------------------
// Debug logging (same convention as the `debug` npm package)
// ---------------------------------------------------------------------------

/** CJS snippet for shim files (runs in Vite's dep optimizer / browser) */
export const FEDERATION_DEBUG_SNIPPET_CJS = `\
var __fed_debug = (function() {
  var pattern;
  try { pattern = (typeof localStorage !== 'undefined' && localStorage.debug) || ''; } catch(e) { pattern = ''; }
  return function(ns) {
    if (!pattern) return function() {};
    var re = new RegExp('^' + pattern.replace(/\\*/g, '.*?') + '$');
    if (!re.test(ns)) return function() {};
    return function() { console.debug.apply(console, ['%c' + ns, 'color: #d97706'].concat(Array.prototype.slice.call(arguments))); };
  };
})();
`

/** ESM snippet for virtual modules (runs in the browser via Vite dev server) */
export const FEDERATION_DEBUG_SNIPPET_ESM = `\
const __fed_debug = (() => {
  let pattern;
  try { pattern = (typeof localStorage !== 'undefined' && localStorage.debug) || ''; } catch(e) { pattern = ''; }
  return (ns) => {
    if (!pattern) return () => {};
    const re = new RegExp('^' + pattern.replace(/\\*/g, '.*?') + '$');
    if (!re.test(ns)) return () => {};
    return (...args) => console.debug('%c' + ns, 'color: #d97706', ...args);
  };
})();
`

// ---------------------------------------------------------------------------
// Module import / expose helpers
// ---------------------------------------------------------------------------

/** Cached dynamic import helper */
export const FEDERATION_IMPORT_SNIPPET = `\
const currentImports = {};

const __federation_import = async (name) => {
  currentImports[name] ??= import(/* @vite-ignore */ name);
  return currentImports[name];
};
`

/**
 * Helper functions shared between dev and prod remote entry modules.
 * These handle unwrapping/wrapping default exports and loading remote modules.
 */
export const FEDERATION_METHOD_UNWRAP_DEFAULT = `\
const __federation_method_unwrapDefault = (module) =>
  (module?.__esModule || module?.[Symbol.toStringTag] === 'Module') ? module.default : module;
`

export const FEDERATION_METHOD_WRAP_DEFAULT = `\
const __federation_method_wrapDefault = (module, need) => {
  if (!module?.default && need) {
    let obj = Object.create(null);
    obj.default = module;
    obj.__esModule = true;
    return obj;
  }
  return module;
};
`

export const FEDERATION_METHOD_GET_REMOTE = `\
const __federation_method_getRemote = (remoteName, componentName) =>
  __federation_method_ensure(remoteName).then((remote) => remote.get(componentName).then(factory => factory()));
`

export const FEDERATION_METHOD_SET_REMOTE = `\
const __federation_method_setRemote = (remoteName, remoteConfig) => {
  remotesMap[remoteName] = remoteConfig;
};
`
