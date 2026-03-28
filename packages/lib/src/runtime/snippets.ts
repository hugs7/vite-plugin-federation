/**
 * Shared runtime code snippets used across federation virtual modules.
 *
 * These are string templates that get embedded as runtime code in the
 * browser — they are NOT executed at build time.
 */

/**
 * Caching dynamic import wrapper. Each virtual module that uses this
 * gets its own `currentImports` scope, preventing duplicate network
 * requests for the same module URL within that context.
 */
export const FEDERATION_IMPORT_SNIPPET = `\
const currentImports = {};
const __federation_import = async (name) => {
  currentImports[name] ??= import(name);
  return currentImports[name];
};`;
