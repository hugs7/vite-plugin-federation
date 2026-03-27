# ESM Singleton Modules (react-redux)

> **Historical note**: This page previously documented a separate federation strategy for ESM modules. ESM modules now use the **exact same strategy** as CJS modules — all shared modules are externalized from the dep optimizer and served via the federation pre-bundle. See [Shared Modules: Uniform Handling](/internals/cjs-shared-modules) for the full architecture.

## Why ESM Modules Were Previously Different

In the old approach, CJS modules (react, react-dom) and ESM modules (react-redux) required different strategies because Vite's dep optimizer handled them differently:

- CJS modules → single `require_X()` factory in `.vite/deps/`
- ESM modules → split into shared chunks, no single intercept point

This distinction no longer exists. All shared modules are **externalized** from the dep optimizer entirely, and the federation pre-bundle (`rolldown.build()`) converts everything to clean ESM in `node_modules/.federation-deps/`.

## The Singleton Problem Still Matters

Even though the implementation strategy is now uniform, understanding **why** ESM singleton modules need to be shared is still important for debugging.

For `react-redux`, the critical issue is `ReactReduxContext`:

```js
// Inside react-redux source
import React from 'react'
const ReactReduxContext = React.createContext(null)
```

This `createContext()` call happens at module load time. If two copies of `react-redux` load, you get two different context objects, and `useSelector()`/`useDispatch()` in the remote can't find the host's `<Provider>`.

## Current Strategy

All shared modules — CJS and ESM — follow the same flow:

1. **Externalized** in Vite's dep optimizer via a Rolldown plugin (`optimizeDeps.rolldownOptions.plugins`)
2. **Pre-bundled** into clean ESM by `rolldown.build()` at server startup → `node_modules/.federation-deps/`
3. **Virtual wrappers** via `resolveId` + `load` intercept all bare specifier imports

### Generated Wrapper Code

For ESM modules with named exports, `buildSharedWrapperCode` generates:

```js
const __shared = globalThis.__federation_shared_modules__?.['react-redux'];
const __mod = __shared ?? await import('/node_modules/.federation-deps/react-redux.js');
export default (__mod.default ?? __mod);
export const Provider = __mod['Provider'];
export const useSelector = __mod['useSelector'];
export const useDispatch = __mod['useDispatch'];
export const useStore = __mod['useStore'];
export const connect = __mod['connect'];
export const batch = __mod['batch'];
export const ReactReduxContext = __mod['ReactReduxContext'];
// ... all other named exports
```

This is identical in structure to the wrapper generated for CJS modules like `react` — only the list of named exports differs.

### How It Works

**In federated mode** (loaded via host):
1. `init(shareScope)` resolves the host's `react-redux` factory
2. Stores `globalThis.__federation_shared_modules__['react-redux'] = hostModule`
3. Remote imports `react-redux` → virtual wrapper finds the shared module
4. All named exports (`Provider`, `useSelector`, `ReactReduxContext`) come from the host's copy
5. ✅ Single `ReactReduxContext` instance across host and remote

**In standalone mode** (no host):
1. `globalThis.__federation_shared_modules__` is undefined
2. Virtual wrapper falls back to `await import('/node_modules/.federation-deps/react-redux.js')`
3. Loads the federation pre-bundle output (clean ESM)
4. ✅ Works as a standalone app

## Export Name Discovery

The plugin discovers all export names at startup using `getModuleExportNames()`:

```ts
const getModuleExportNames = (name: string, root: string): string[] => {
  // Method 1: Dynamic import in subprocess
  execSync(`node --input-type=module -e "import('${name}').then(m => ...)"`)
  
  // Method 2: Static analysis with es-module-lexer (fallback)
  getExportNamesStatically(resolvedPath)
}
```

For `react-redux`, this returns something like:
```json
["Provider", "ReactReduxContext", "batch", "connect", "createDispatchHook",
 "createSelectorHook", "createStoreHook", "shallowEqual", "useDispatch",
 "useSelector", "useStore", "default"]
```

## Package Resolution with createRequire

The plugin uses `createRequire` to resolve packages, which correctly handles:
- **Hoisted node_modules** in monorepo/workspace setups
- **Symlinked packages** (npm link)

```ts
const nodeRequire = createRequire(join(root, 'package.json'))
const realPath = nodeRequire.resolve('react-redux')
// → /home/user/project/node_modules/react-redux/dist/react-redux.mjs
```
