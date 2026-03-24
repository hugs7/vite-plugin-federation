# The Remote Entry (remoteEntry.js)

The `remoteEntry.js` file is the contract between host and remote. It implements two functions: `init()` and `get()`.

## Source Location

In dev mode, `remoteEntry.js` is a virtual module defined in `devExposePlugin`:

```
packages/lib/src/dev/expose-development.ts → virtualFile['__remoteEntryHelper__remoteEntry.js']
```

In production, it's defined in `prodExposePlugin` and emitted as a real chunk:

```
packages/lib/src/prod/expose-production.ts → virtualFile['__remoteEntryHelper__remoteEntry.js']
```

## Dev Mode Remote Entry

### The `init(shareScope)` Function

```js
export const init = (shareScope) => {
  // 1. Store share scope globally (legacy compat)
  globalThis.__federation_shared__ = globalThis.__federation_shared__ || {};
  Object.entries(shareScope).forEach(([key, value]) => {
    for (const [versionKey, versionValue] of Object.entries(value)) {
      const scope = versionValue.scope || 'default';
      globalThis.__federation_shared__[scope] =
        globalThis.__federation_shared__[scope] || {};
      const shared = globalThis.__federation_shared__[scope];
      (shared[key] = shared[key] || {})[versionKey] = versionValue;
    }
  });

  // 2. Resolve shared module factories → store in globalThis
  globalThis.__federation_shared_modules__ =
    globalThis.__federation_shared_modules__ || {};
  
  __federation_shared_resolving = Promise.all(
    Object.keys(shareScope).map(async (key) => {
      const versions = shareScope[key];
      const ver = Object.keys(versions)[0];
      if (ver) {
        const factory = await versions[ver].get();
        const mod = await factory();
        globalThis.__federation_shared_modules__[key] = mod;
      }
    })
  );

  // 3. Load remote's @vite/client for HMR
  const remoteOrigin = new URL(import.meta.url).origin;
  import(remoteOrigin + '/@vite/client');
};
```

Step-by-step:

1. **Store share scope** — populates `globalThis.__federation_shared__` with version-keyed module factories (legacy format, used by production mode)

2. **Resolve factories** — for each shared module (e.g., `react`, `react-redux`):
   - Calls `factory.get()` which returns a function (the factory)
   - Calls `factory()` which returns the actual module
   - Stores the resolved module in `globalThis.__federation_shared_modules__[key]`
   - This is what the shared module wrappers read from

3. **Load @vite/client** — imports the remote's Vite client script so HMR updates from the remote dev server are received. The middleware patches the client to use absolute URLs.

### The `get(module)` Function

```js
export const get = async (module) => {
  // Wait for init() to finish resolving shared modules
  if (__federation_shared_resolving) await __federation_shared_resolving;
  if (__federation_dev_client_loaded) await __federation_dev_client_loaded;
  
  // Look up the module in the module map
  if (!moduleMap[module]) throw new Error('Can not find remote module ' + module);
  return moduleMap[module]();
};
```

The `get()` function:
1. **Awaits `init()` completion** — ensures `globalThis.__federation_shared_modules__` is populated before any exposed module loads. This is critical because the exposed modules' imports will synchronously check the global.
2. **Returns a factory** — the module map entry returns a function that resolves to the module

### The Module Map

```js
let moduleMap = {
  "./pages": () => {
    return __federation_import('./__federation_expose_pages.js')
      .then(module =>
        Object.keys(module).every(item => exportSet.has(item))
          ? () => module.default
          : () => module
      );
  }
}
```

Each exposed module is mapped to a function that:
1. Dynamically imports the expose stub (`__federation_expose_pages.js`)
2. Checks if the module only has "standard" exports (Module, __esModule, default, _export_sfc)
3. If yes, returns `module.default` (unwrap the ESM wrapper)
4. If no, returns the full module (preserve named exports)

### The Expose Stubs

The expose stubs are served by the `configureServer` middleware (not virtual modules):

```js
// Served at /__federation_expose_pages.js
export { default } from '/src/pages/index.tsx';
export * from '/src/pages/index.tsx';
```

These thin re-export stubs redirect the browser to the real source file, which Vite tracks in its module graph for HMR updates.

## Production Mode Remote Entry

The production remote entry is similar but with key differences:

- No `@vite/client` loading (no dev server)
- `init()` only populates `globalThis.__federation_shared__` (no pre-resolution)
- `get()` doesn't await shared resolution
- Module map uses Rollup file URLs for chunk paths
- Includes CSS dynamic loading via `dynamicLoadingCss()`

## Debug Logging

The dev remote entry includes debug logging via `__fed_debug`:

```js
const _logInit = __fed_debug('federation:init');
const _logGet = __fed_debug('federation:get');
```

Enable in browser console:
```js
localStorage.debug = 'federation:*'
```

This logs shared module resolution, factory calls, and module loading — invaluable for debugging federation issues.
