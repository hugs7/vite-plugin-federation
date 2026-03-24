/**
 * Reusable code snippets emitted into generated runtime modules.
 *
 * Simple helper functions are written as real code (with syntax
 * highlighting and type checking), then serialised via .toString()
 * for injection into virtual modules that run in the browser.
 *
 * Complex snippets (like the debug IIFE) remain as template strings
 * because .toString() can't capture closure-bound constants.
 */

// ---------------------------------------------------------------------------
// Debug logging (same convention as the `debug` npm package:
// enable in the browser with `localStorage.debug = 'federation:*'`)
// ---------------------------------------------------------------------------

const DEBUG_COLOR = '#d97706'

/** ESM snippet for virtual modules (runs in the browser via Vite dev server) */
export const FEDERATION_DEBUG_SNIPPET_ESM = `\
const __fed_debug = (() => {
  let pattern;
  try { pattern = (typeof localStorage !== 'undefined' && localStorage.debug) || ''; } catch(e) { pattern = ''; }
  return (ns) => {
    if (!pattern) return () => {};
    const re = new RegExp('^' + pattern.replace(/\\*/g, '.*?') + '$');
    if (!re.test(ns)) return () => {};
    return (...args) => console.debug('%c' + ns, 'color: ${DEBUG_COLOR}', ...args);
  };
})();
`

// ---------------------------------------------------------------------------
// Module import helper
// ---------------------------------------------------------------------------

// Written as real code for syntax highlighting and linting.
// The `currentImports` variable is declared in the snippet output,
// not captured from outer scope.
const _federationImport = async (name: string) => {
  currentImports[name] ??= import(/* @vite-ignore */ name)
  return currentImports[name]
}

/** Cached dynamic import helper (declares currentImports + the function) */
export const FEDERATION_IMPORT_SNIPPET = `\
const currentImports = {};

const __federation_import = ${_federationImport.toString().replace(/: string/g, '')};
`

// ---------------------------------------------------------------------------
// Federation method helpers (shared between dev and prod remote entries)
// ---------------------------------------------------------------------------

const _unwrapDefault = (module: any) =>
  (module?.__esModule || module?.[Symbol.toStringTag] === 'Module')
    ? module.default
    : module

export const FEDERATION_METHOD_UNWRAP_DEFAULT = `\
const __federation_method_unwrapDefault = ${_unwrapDefault.toString().replace(/: any/g, '')};
`

const _wrapDefault = (module: any, need: boolean) => {
  if (!module?.default && need) {
    const obj = Object.create(null)
    obj.default = module
    obj.__esModule = true
    return obj
  }
  return module
}

export const FEDERATION_METHOD_WRAP_DEFAULT = `\
const __federation_method_wrapDefault = ${_wrapDefault.toString().replace(/: any|: boolean/g, '')};
`

const _getRemote = (remoteName: string, componentName: string) =>
  __federation_method_ensure(remoteName).then((remote: any) =>
    remote.get(componentName).then((factory: any) => factory())
  )

export const FEDERATION_METHOD_GET_REMOTE = `\
const __federation_method_getRemote = ${_getRemote.toString().replace(/: string|: any/g, '')};
`

const _setRemote = (remoteName: string, remoteConfig: any) => {
  remotesMap[remoteName] = remoteConfig
}

export const FEDERATION_METHOD_SET_REMOTE = `\
const __federation_method_setRemote = ${_setRemote.toString().replace(/: string|: any/g, '')};
`

// ---------------------------------------------------------------------------
// Ambient declarations so TypeScript doesn't complain about references
// in the function bodies above.  These are never executed.
// ---------------------------------------------------------------------------
declare const currentImports: Record<string, Promise<any>>
declare const remotesMap: Record<string, any>
declare function __federation_method_ensure(id: string): Promise<any>
