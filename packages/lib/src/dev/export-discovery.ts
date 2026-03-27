/**
 * Export discovery utilities for federation pre-bundled shared modules.
 *
 * Discovers export names from pre-bundled files using multiple strategies
 * (es-module-lexer, CJS pattern scanning, original source scanning).
 */

import { init as initLexer, parse as parseLexer } from 'es-module-lexer'
import { readFileSync } from 'fs'
import { createRequire } from 'module'
import { join } from 'path'
import { CJS_EXPORTS_RE } from '../public'

/** Collect CJS export names from a code string into a set. */
const collectCjsExportNames = (code: string, target: Set<string>): void => {
  for (const match of code.matchAll(CJS_EXPORTS_RE)) {
    target.add(match[1])
  }
}

/**
 * Scan a file (and optionally its chunk imports) for CJS `exports.XXX = ...`
 * patterns.  With code splitting, CJS module bodies may live in chunk files
 * rather than the entry file itself.
 */
export const scanCjsExports = (
  code: string,
  fileDir: string
): Set<string> => {
  const cjsExports = new Set<string>(['default'])

  collectCjsExportNames(code, cjsExports)

  // If we only found `default` in the entry, the CJS body may be in a chunk.
  // Follow relative imports and scan those too.
  if (cjsExports.size <= 1) {
    for (const imp of code.matchAll(/from\s+["'](\.[^"']+)["']/g)) {
      try {
        const chunkPath = join(fileDir, imp[1])
        const chunkCode = readFileSync(chunkPath, 'utf-8')
        collectCjsExportNames(chunkCode, cjsExports)
      } catch {
        /* chunk not found */
      }
    }
  }

  return cjsExports
}

/**
 * Discover export names from a federation pre-bundled file.
 *
 * Strategy (fastest to slowest, stops when exports found):
 * 1. es-module-lexer on the entry file (works for ESM modules)
 * 2. Scan entry + chunk files for `exports.XXX = ...` (works for CJS)
 * 3. Scan the ORIGINAL package source for `exports.XXX = ...` (fallback
 *    when code splitting moves CJS bodies into shared chunks that the
 *    entry doesn't directly import)
 */
export const getPreBundleExports = async (
  filePath: string,
  moduleName: string,
  root: string
): Promise<string[]> => {
  try {
    await initLexer
    const code = readFileSync(filePath, 'utf-8')
    const [, exports] = parseLexer(code)
    const names = exports
      .map((e) => (typeof e === 'string' ? e : e.n))
      .filter(Boolean)

    // ESM module with real named exports — use them directly.
    // Filter out Rolldown's internal `t` factory export (used for CJS
    // interop: `export { require_xxx as t }`) which is not a real
    // consumer-facing export.
    const realNames = names.filter((n) => n !== 't')
    if (
      realNames.length > 1 ||
      (realNames.length === 1 && realNames[0] !== 'default')
    ) {
      return realNames
    }

    // CJS module — scan pre-bundle entry + chunks for exports.XXX patterns
    const fileDir = filePath.substring(0, filePath.lastIndexOf('/'))
    const cjsExports = scanCjsExports(code, fileDir)
    if (cjsExports.size > 1) {
      return [...cjsExports]
    }

    // Fallback: scan the ORIGINAL package source.  With code splitting,
    // CJS bodies can end up in shared chunks that the entry file doesn't
    // directly import (e.g. react/jsx-runtime shares a chunk with react).
    try {
      const nodeRequire = createRequire(join(root, 'package.json'))
      const origPath = nodeRequire.resolve(moduleName)
      const origCode = readFileSync(origPath, 'utf-8')
      const origExports = new Set<string>(['default'])

      collectCjsExportNames(origCode, origExports)

      // Follow require('./...') to find CJS sub-files
      if (origExports.size <= 1) {
        const origDir = origPath.substring(0, origPath.lastIndexOf('/'))
        for (const req of origCode.matchAll(
          /require\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g
        )) {
          try {
            const subPath = nodeRequire.resolve(join(origDir, req[1]))
            const subCode = readFileSync(subPath, 'utf-8')
            collectCjsExportNames(subCode, origExports)
          } catch {
            /* sub-file not found */
          }
        }
      }

      if (origExports.size > 1) {
        return [...origExports]
      }
    } catch {
      /* original source fallback failed */
    }

    return names.length ? names : ['default']
  } catch {
    return ['default']
  }
}

/** Metadata for a shared virtual module */
export interface SharedModuleMeta {
  /** URL to the federation pre-bundled file (served via /@fs/ or root-relative) */
  preBundleUrl: string
  /** Enumerated export names (discovered from pre-bundle output) */
  exports: string[]
}

/**
 * Build ESM wrapper code for a shared virtual module.
 * At runtime, checks globalThis.__federation_shared_modules__ first (set by
 * the host's init()), falling back to a dynamic import of the federation
 * pre-bundled version of the package.
 */
export const buildSharedWrapperCode = (
  name: string,
  meta: SharedModuleMeta,
  originUrl?: string
): string => {
  const named = meta.exports.filter((e) => e !== 'default')
  const hasDefault = meta.exports.includes('default')

  const importUrl = originUrl
    ? `${originUrl}${meta.preBundleUrl}`
    : meta.preBundleUrl

  // Named exports live in different places depending on module format:
  //   ESM pre-bundle: named exports are on __mod (the namespace object)
  //                   __mod.default is the default export VALUE (e.g. a function)
  //   CJS pre-bundle: only has `export default require_xxx()`, so named
  //                   exports are properties of __mod.default (the module.exports)
  //
  // For named exports, try __mod[name] first (ESM), fall back to
  // (__mod.default ?? __mod)[name] (CJS).

  let code = ''
  code += `const __shared = globalThis.__federation_shared_modules__?.[${JSON.stringify(name)}];\n`
  code += `const __mod = __shared ?? await import(/* @vite-ignore */ ${JSON.stringify(importUrl)});\n`

  if (hasDefault) {
    code += `export default (__mod.default ?? __mod);\n`
  }
  for (const e of named) {
    if (/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(e)) {
      code += `export const ${e} = __mod[${JSON.stringify(e)}] ?? (__mod.default ?? __mod)[${JSON.stringify(e)}];\n`
    }
  }

  return code
}
