# The Host Side

The host side is handled by `devRemotePlugin` (dev) and `prodRemotePlugin` (production). It generates the federation runtime that the host app uses to load remote modules.

## The `__federation__` Virtual Module

Both dev and prod remote plugins generate a `__federation__` virtual module. This module contains:

1. **`remotesMap`** — URL and format info for each remote
2. **`wrapShareScope()`** — generates the share scope object with factories
3. **`__federation_method_ensure()`** — loads and initializes a remote
4. **`__federation_method_getRemote()`** — loads a specific module from a remote

### remotesMap

```js
const remotesMap = {
  'interactiondashboard': {
    url: 'http://localhost:6001/remoteEntry.js',
    format: 'esm',
    from: 'vite'
  }
}
```

### wrapShareScope (Dev Mode)

The `devSharedScopeCode` function generates factory entries for each shared module:

```ts
// packages/lib/src/dev/remote-development.ts
async function devSharedScopeCode(shared) {
  const res = []
  for (const item of shared) {
    const sharedName = item[0]
    const obj = item[1]
    const str = `get:() => import('${sharedName}').then(m => {
      const keys = Object.keys(m);
      const hasNamed = keys.some(k => k !== 'default' && k !== '__esModule');
      return () => hasNamed ? m : (m.default ?? m);
    })`
    res.push(`'${sharedName}':{'${obj.version}':{${str}}}`)
  }
  return res
}
```

This generates code like:

```js
const wrapShareScope = remoteFrom => {
  return {
    'react': {
      '19.2.4': {
        get: () => import('react').then(m => {
          const keys = Object.keys(m);
          const hasNamed = keys.some(k => k !== 'default' && k !== '__esModule');
          return () => hasNamed ? m : (m.default ?? m);
        })
      }
    },
    'react-redux': {
      '9.2.0': {
        get: () => import('react-redux').then(m => {
          const keys = Object.keys(m);
          const hasNamed = keys.some(k => k !== 'default' && k !== '__esModule');
          return () => hasNamed ? m : m;  // has named exports → return full module
        })
      }
    }
  }
}
```

#### CJS vs ESM Factory Behavior

The factory checks whether the module has named exports:

- **CJS modules (react)**: Only have `default` and `__esModule` → `hasNamed = false` → returns `m.default` (the unwrapped CJS export)
- **ESM modules (react-redux)**: Have named exports like `Provider`, `useSelector` → `hasNamed = true` → returns the full module `m`

This distinction is critical because the remote's `init()` stores these values in `globalThis.__federation_shared_modules__`, and the shared module wrappers need to re-export the correct shape.

### __federation_method_ensure

Loads a remote's `remoteEntry.js` and calls `init()`:

```js
async function __federation_method_ensure(remoteId) {
  const remote = remotesMap[remoteId];
  if (!remote.inited) {
    if (['esm', 'systemjs'].includes(remote.format)) {
      return new Promise((resolve, reject) => {
        const getUrl = typeof remote.url === 'function'
          ? remote.url
          : () => Promise.resolve(remote.url);
        getUrl().then(url => {
          import(url).then(lib => {
            if (!remote.inited) {
              const shareScope = wrapShareScope(remote.from);
              remote.lib = lib;
              remote.lib.init(shareScope);
              remote.inited = true;
            }
            resolve(remote.lib);
          }).catch(reject);
        });
      });
    }
  } else {
    return remote.lib;
  }
}
```

Key points:
- Supports both `esm` (dynamic import) and `var` (script tag) loading
- The `remote.inited` flag prevents double-initialization
- `wrapShareScope(remote.from)` generates the share scope with CJS/ESM-aware factories

### __federation_method_getRemote

Chains `ensure()` → `get()` → `factory()`:

```js
function __federation_method_getRemote(remoteName, componentName) {
  return __federation_method_ensure(remoteName)
    .then(remote => remote.get(componentName)
    .then(factory => factory()));
}
```

## Import Rewriting (Transform Hook)

The host's transform hook rewrites imports of remote modules using AST walking with `estree-walker`:

### Dynamic Import

```js
// Original
import('interactiondashboard/pages')

// Rewritten to
__federation_method_getRemote('interactiondashboard', './pages')
  .then(module => __federation_method_wrapDefault(module, true))
```

### Static Import

```js
// Original
import Dashboard from 'interactiondashboard/pages'

// Rewritten to
const __federation_var_interactiondashboardpages =
  await __federation_method_getRemote('interactiondashboard', './pages');
let Dashboard = __federation_method_unwrapDefault(__federation_var_interactiondashboardpages)
```

### Named Import

```js
// Original
import { DashboardPage, SettingsPage } from 'interactiondashboard/pages'

// Rewritten to
const __federation_var_interactiondashboardpages =
  await __federation_method_getRemote('interactiondashboard', './pages');
let { DashboardPage, SettingsPage } = __federation_var_interactiondashboardpages
```

### Export Re-export

```js
// Original
export { DashboardPage } from 'interactiondashboard/pages'

// Rewritten to
const __federation_var_interactiondashboardpages =
  await __federation_method_getRemote('interactiondashboard', './pages');
const { DashboardPage: __federation_var_interactiondashboardpages_DashboardPage } =
  __federation_var_interactiondashboardpages;
export { __federation_var_interactiondashboardpages_DashboardPage as DashboardPage };
```

## Host-Side React Refresh Patching

The host's `devRemotePlugin` patches `@react-refresh` to store the refresh runtime globally:

```ts
// packages/lib/src/dev/remote-development.ts
configureServer(server) {
  server.middlewares.use(async (req, res, next) => {
    if (url === '/@react-refresh') {
      const result = await server.transformRequest('/@react-refresh')
      const code = result.code +
        `\nif(typeof window!=='undefined'){` +
        `window.__vite_react_refresh_runtime__={` +
        `injectIntoGlobalHook,register,...` +
        `};};\n`
      res.end(code)
    }
  })
}
```

This allows the remote's `@react-refresh` to re-use the host's refresh runtime singleton, ensuring component families and mounted roots are tracked in one place.
