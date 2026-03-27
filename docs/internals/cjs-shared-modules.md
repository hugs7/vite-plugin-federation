# Shared Modules: Uniform Handling via Federation Pre-Bundle

> **Historical note**: This page was previously titled "CJS Shared Modules" and documented a separate strategy for CJS packages like React. The CJS/ESM distinction is **no longer relevant** — all shared modules are now handled uniformly via the Rolldown-based federation pre-bundle.

## Why CJS vs ESM No Longer Matters

Previously, the plugin needed to classify each shared module as CJS or ESM and apply different strategies:
- CJS modules (react, react-dom) were served from Vite's `.vite/deps/` output
- ESM modules (react-redux) were served via `/@fs/` URLs pointing to the real package source

This complexity existed because Vite's dep optimizer handled CJS and ESM modules differently internally. The new approach **bypasses this entirely** by:

1. **Externalizing** all shared modules from Vite's dep optimizer (so it never processes them)
2. **Pre-bundling** each shared module independently via `rolldown.build()` into clean ESM files

## How It Works

### Step 1: Externalize in the Dep Optimizer

A Rolldown plugin inside `optimizeDeps.rolldownOptions.plugins` marks ALL shared modules as `external`:

```ts
// Inside the dep optimizer plugin
resolveId(id) {
  if (sharedModuleMeta.has(id)) {
    return { id, external: true }
  }
}
```

This prevents Vite's dep optimizer from bundling shared modules into `.vite/deps/`. Other dependencies that import shared modules will have `import` statements pointing to the bare specifier (e.g., `import react from "react"`), which the virtual wrapper then intercepts at runtime.

### Step 2: Federation Pre-Bundle

At server startup, `rolldown.build()` bundles each shared module into a clean ESM file in `node_modules/.federation-deps/`:

```
node_modules/.federation-deps/
  react.js          ← Clean ESM, regardless of react being CJS
  react-dom.js
  react-redux.js
  react/jsx-runtime.js
```

Rolldown handles CJS-to-ESM conversion automatically — the output is always clean ESM with proper `export default` and named exports. This is the key insight: **Rolldown normalizes all module formats into ESM**, so the plugin doesn't need to care about the input format.

### Step 3: Virtual Wrappers via resolveId + load

When application code does `import React from 'react'`, the plugin intercepts it:

#### resolveId Hook

```ts
resolveId(id: string) {
  if (sharedModuleMeta.has(id)) {
    return { id: RESOLVED_SHARED_PREFIX + id }
  }
  return null
}
```

#### load Hook

```ts
load(id: string) {
  if (!id.startsWith(RESOLVED_SHARED_PREFIX)) return null
  const specifier = id.slice(RESOLVED_SHARED_PREFIX.length)
  const meta = sharedModuleMeta.get(specifier)
  if (!meta) return null
  return { code: buildSharedWrapperCode(specifier, meta) }
}
```

#### The Wrapper Code

All shared modules — regardless of original format — get the same wrapper structure:

```js
// For 'react':
const __shared = globalThis.__federation_shared_modules__?.['react'];
const __mod = __shared ?? await import('/node_modules/.federation-deps/react.js');
export default (__mod.default ?? __mod);
```

```js
// For 'react-redux' (has named exports):
const __shared = globalThis.__federation_shared_modules__?.['react-redux'];
const __mod = __shared ?? await import('/node_modules/.federation-deps/react-redux.js');
export default (__mod.default ?? __mod);
export const Provider = __mod['Provider'];
export const useSelector = __mod['useSelector'];
export const useDispatch = __mod['useDispatch'];
// ... all other named exports
```

The fallback URL always points to the federation pre-bundle output — never to `.vite/deps/` or `/@fs/` paths.

### How Export Names Are Discovered

The plugin discovers export names at config time using two methods:

1. **Dynamic import** in a subprocess — `node --input-type=module -e "import('react').then(m => console.log(JSON.stringify(Object.keys(m))))"`
2. **Static analysis** fallback — uses `es-module-lexer` to parse the source file without executing it (handles browser-only modules that reference `window`)

```ts
const getModuleExportNames = (name: string, root: string): string[] => {
  try {
    const result = execSync(
      `node --input-type=module -e "import('${name}').then(m => console.log(JSON.stringify(Object.keys(m))))"`,
      { cwd: root, encoding: 'utf-8', timeout: 10000 }
    )
    return JSON.parse(result.trim())
  } catch {
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
4. Falls back to `await import('/node_modules/.federation-deps/react.js')` → loads federation pre-bundle
5. Works normally as a standalone app

## Sub-path Imports

For sub-path imports like `react/jsx-runtime`, the wrapper doesn't check the shared modules map (the host doesn't provide sub-paths). Instead, it always imports from the federation pre-bundle:

```js
// For 'react/jsx-runtime':
const __mod = await import('/node_modules/.federation-deps/react/jsx-runtime.js');
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
4. This made `import_react` undefined for some UI library components

The current approach avoids this entirely — shared modules are externalized from the dep optimizer, so Rolldown never tries to bundle them. The federation pre-bundle is a completely separate Rolldown invocation.

See [Rolldown Dep Optimizer](/internals/rolldown-dep-optimizer) for the full explanation.
