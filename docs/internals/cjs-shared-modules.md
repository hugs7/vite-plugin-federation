# CJS Shared Modules (react, react-dom)

React 19 and React-DOM are purely CommonJS packages. Vite's Rolldown dep optimizer converts them to ESM, but the internal structure matters for understanding how federation intercepts them.

## How Rolldown Handles CJS Modules

When Vite's dep optimizer processes `react` (a CJS package), it generates a file like:

```js
// node_modules/.vite/deps/react.js
var require_react = __commonJS({
  "node_modules/react/index.js"(exports, module) {
    module.exports = require_react_production();
  }
});
export default require_react();
export { require_react as t };
```

The key insight: **every other dep-optimized file that uses React imports the same factory**:

```js
// node_modules/.vite/deps/react-dom.js
import { t as require_react } from "./react.js";
// uses require_react() internally
```

```js
// node_modules/.vite/deps/@westpac_ui_ButtonGroup.js
import { t as require_react } from "./react.js";
// uses require_react() internally
```

This means there is a **single point of control** — the `react.js` file's exports. If we intercept what `react.js` returns, all consumers automatically get the federation-provided version.

## The Virtual Wrapper Approach

In dev mode, `devExposePlugin` intercepts imports of shared modules using `resolveId` + `load` hooks:

### resolveId Hook

```ts
// packages/lib/src/dev/expose-development.ts
resolveId(id: string) {
  // Intercept bare shared specifiers
  if (sharedModuleMeta.has(id)) {
    return { id: RESOLVED_SHARED_PREFIX + id }
  }
  return null
}
```

When any file in the remote does `import React from 'react'`, instead of resolving to the real `react` package, it resolves to a virtual module `\0virtual:__federation_shared__:react`.

### load Hook

```ts
load(id: string) {
  if (!id.startsWith(RESOLVED_SHARED_PREFIX)) return null
  const specifier = id.slice(RESOLVED_SHARED_PREFIX.length)
  const meta = sharedModuleMeta.get(specifier)
  if (!meta) return null
  return { code: buildSharedWrapperCode(specifier, meta) }
}
```

### The Wrapper Code

The `buildSharedWrapperCode` function generates:

```js
// For 'react' (CJS, only has default export):
const __shared = globalThis.__federation_shared_modules__?.['react'];
const __mod = __shared ?? await import('/@fs/.../node_modules/react/index.js');
export default (__mod.default ?? __mod);
```

```js
// For 'react-redux' (ESM, has named exports):
const __shared = globalThis.__federation_shared_modules__?.['react-redux'];
const __mod = __shared ?? await import('/@fs/.../node_modules/react-redux/dist/react-redux.mjs');
export default (__mod.default ?? __mod);
export const Provider = __mod['Provider'];
export const useSelector = __mod['useSelector'];
export const useDispatch = __mod['useDispatch'];
// ... all other named exports
```

### How Export Names Are Discovered

The plugin discovers export names at config time using two methods:

1. **Dynamic import** in a subprocess — `node --input-type=module -e "import('react').then(m => console.log(JSON.stringify(Object.keys(m))))"`
2. **Static analysis** fallback — uses `es-module-lexer` to parse the source file without executing it (handles browser-only modules that reference `window`)

```ts
// packages/lib/src/dev/expose-development.ts
const getModuleExportNames = (name: string, root: string): string[] => {
  try {
    // Try dynamic import first
    const result = execSync(
      `node --input-type=module -e "import('${name}').then(m => console.log(JSON.stringify(Object.keys(m))))"`,
      { cwd: root, encoding: 'utf-8', timeout: 10000 }
    )
    return JSON.parse(result.trim())
  } catch {
    // Fall back to static analysis with es-module-lexer
    const resolvedPath = nodeRequire.resolve(name)
    return getExportNamesStatically(resolvedPath)
  }
}
```

## Runtime Behavior

When the remote is loaded in **federated mode** (via the host):

1. Host calls `init(shareScope)` → remote resolves factories → `globalThis.__federation_shared_modules__.react = hostReactModule`
2. Remote component does `import React from 'react'`
3. Plugin's `resolveId` redirects to the virtual wrapper
4. Wrapper checks `globalThis.__federation_shared_modules__['react']` → **found** (set by init)
5. Returns the host's React → ✅ single React instance

When the remote runs in **standalone mode** (no host):

1. No `init()` called → `globalThis.__federation_shared_modules__` is undefined
2. Remote component does `import React from 'react'`
3. Wrapper checks `globalThis.__federation_shared_modules__?.['react']` → **undefined**
4. Falls back to `await import('/@fs/.../react/index.js')` → loads local copy
5. Works normally as a standalone app

## Sub-path Imports

For sub-path imports like `react/jsx-runtime`, the wrapper doesn't check the shared modules map (the host doesn't provide sub-paths). Instead, it always imports the local package:

```js
// For 'react/jsx-runtime':
const __mod = await import('/@fs/.../node_modules/react/jsx-runtime.js');
export default (__mod.default ?? __mod);
export const jsx = __mod['jsx'];
export const jsxs = __mod['jsxs'];
export const Fragment = __mod['Fragment'];
```

## Why Not resolve.alias?

An earlier approach used `resolve.alias` to redirect `react` to a shim file. This failed because:

1. Rolldown's dep optimizer saw the alias target as a different module
2. It generated lazy `__esmMin` init wrappers instead of top-level imports
3. Some `__esmMin` inits were generated as anonymous functions (a Rolldown bug)
4. This made `import_react` undefined for components like `@westpac/ui`'s `ButtonGroupButton`

The virtual wrapper approach avoids this because it only intercepts at the Vite plugin level, not at the Rolldown optimizer level. The dep optimizer still processes `react` normally — the interception happens when application code imports it.

See [Rolldown Dep Optimizer](/internals/rolldown-dep-optimizer) for the full explanation.
