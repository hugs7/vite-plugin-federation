/**
 * Inline debug snippets for emitted runtime code.
 *
 * These follow the same convention as the `debug` npm package:
 * enable in the browser with `localStorage.debug = 'federation:*'`
 * and in Node.js with `DEBUG=federation:* node ...`.
 *
 * Each snippet defines a `__fed_debug(namespace)` factory that returns
 * a log function. The log function is a no-op when the namespace isn't
 * enabled.
 */

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
`;

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
`;
