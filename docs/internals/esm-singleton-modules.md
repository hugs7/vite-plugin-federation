# ESM Singleton Modules (react-redux)

ESM modules like `react-redux` require a different federation strategy than CJS modules. This page explains why and how the plugin handles them.

## Why ESM Modules Are Different

Unlike CJS modules (react, react-dom) which the dep optimizer wraps in a single `require_X()` factory, ESM modules are processed differently by Rolldown:

- The optimizer may split ESM modules into shared **chunks**
- Other dep-optimized packages can import these chunks directly
- There's no single factory function to intercept

For `react-redux` specifically, the critical issue is `ReactReduxContext`:

```js
// Inside react-redux source
import React from 'react'
const ReactReduxContext = React.createContext(null)
```

This `createContext()` call happens at module load time. If two copies of `react-redux` load, you get two different context objects, and `useSelector()`/`useDispatch()` in the remote can't find the host's `<Provider>`.

## The Virtual Wrapper Approach

The plugin uses the same `resolveId` + `load` virtual wrapper approach as for CJS modules. When any file in the remote imports `react-redux`, the plugin intercepts it:

### resolveId

```ts
resolveId(id: string) {
  if (sharedModuleMeta.has(id)) {
    return { id: RESOLVED_SHARED_PREFIX + id }
  }
  return null
}
```

### Generated Wrapper Code

For ESM modules with named exports, `buildSharedWrapperCode` generates:

```js
const __shared = globalThis.__federation_shared_modules__?.['react-redux'];
const __mod = __shared ?? await import(/* @vite-ignore */ '/@fs/.../react-redux/dist/react-redux.mjs');
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

### How It Works

**In federated mode** (loaded via host):
1. `init(shareScope)` resolves the host's `react-redux` factory
2. Stores `globalThis.__federation_shared_modules__['react-redux'] = hostModule`
3. Remote imports `react-redux` → virtual wrapper finds the shared module
4. All named exports (`Provider`, `useSelector`, `ReactReduxContext`) come from the host's copy
5. ✅ Single `ReactReduxContext` instance across host and remote

**In standalone mode** (no host):
1. `globalThis.__federation_shared_modules__` is undefined
2. Virtual wrapper falls back to `await import('/@fs/.../react-redux.mjs')`
3. Loads the remote's own copy normally
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

## Key Differences from CJS Strategy

| Aspect | CJS (react) | ESM (react-redux) |
|--------|-------------|-------------------|
| Module format | CommonJS | ES Modules |
| Dep optimizer output | Single `require_X` factory | Chunks + re-exports |
| Named exports | Only `default` | Many (`Provider`, `useSelector`, etc.) |
| Singleton concern | Internal dispatcher | `ReactReduxContext` object |
| Wrapper output | `export default (__mod.default ?? __mod)` | Default + all named exports |
