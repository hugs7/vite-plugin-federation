# Server Middleware (configureServer)

Both `devExposePlugin` and `devRemotePlugin` register middleware on the Vite dev server. This middleware handles CORS, module serving, and cross-origin patching.

## Middleware on the Remote (devExposePlugin)

### 1. CORS Headers

Applied to **all** responses:

```ts
server.middlewares.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', '*')
  res.setHeader('Access-Control-Allow-Headers', '*')
  if (req.method === 'OPTIONS') {
    res.statusCode = 204
    res.end()
    return
  }
  next()
})
```

Without CORS headers, the host's browser blocks cross-origin requests to the remote dev server (e.g., `localhost:3000` loading from `localhost:6001`).

### 2. remoteEntry.js Serving

```ts
if (url === `/${options.filename}`) {
  const moduleId = `__remoteEntryHelper__${options.filename}`
  const result = await server.transformRequest(moduleId)
  res.setHeader('Content-Type', 'application/javascript')
  res.end(result.code)
}
```

Uses `server.transformRequest()` to process the virtual module through Vite's full transform pipeline (including other plugins), then serves the result.

### 3. @vite/client Patching

```ts
if (url === '/@vite/client' || url?.startsWith('/@vite/client?')) {
  const clientResult = await server.transformRequest('/@vite/client')
  const port = server.config.server.port ?? 5173
  const remoteOrigin = `http://localhost:${port}`
  let code = clientResult.code
  code = code.replace(
    /const base = "\/"\s*\|\|\s*"\/";/,
    `const base = "${remoteOrigin}/";`
  )
  code = code.replace(
    /const base\$1 = "\/"\s*\|\|\s*"\/";/,
    `const base$1 = "${remoteOrigin}/";`
  )
  res.end(code)
}
```

**Why this is needed**: When the host browser loads `@vite/client` from the remote, it runs in the host's page context. The stock client uses `base = "/"` which resolves to `localhost:3000` (the host). HMR module re-imports need to go to `localhost:6001` (the remote).

The patch replaces both the `base` and `base$1` URL variables with an absolute remote origin, so HMR `import()` calls resolve to the correct server.

### 4. @react-refresh Singleton (Remote Side)

```ts
if (url === '/@react-refresh') {
  const code = `
    import * as _localRuntime from '/@react-refresh-runtime';
    var _rt = (typeof window !== 'undefined' &&
      window.__vite_react_refresh_runtime__) || _localRuntime;
    if (typeof window !== 'undefined' &&
      !window.__vite_react_refresh_runtime__) {
      window.__vite_react_refresh_runtime__ = _localRuntime;
    }
    export var injectIntoGlobalHook = _rt.injectIntoGlobalHook;
    export var register = _rt.register;
    // ... all other exports from _rt
  `;
  res.end(code)
}
```

**The problem**: React Fast Refresh maintains global state — a map of component "families" (by type) and a set of mounted roots. If the host and remote each have their own `@react-refresh` runtime, they have separate family maps. When the remote's module updates:

1. The remote's refresh runtime re-registers the component
2. But `performReactRefresh()` only knows about roots in its own map
3. The host's roots (where the component is actually mounted) are in the host's map
4. Result: no re-render, or a full page reload

**The fix**: In federated mode, the remote checks for `window.__vite_react_refresh_runtime__` (set by the host's patched `@react-refresh`). If found, it re-exports the host's runtime — all component families and mounted roots are tracked in one place.

In standalone mode (no host runtime on window), the remote stores its own runtime globally.

### 5. @react-refresh-runtime (Actual Runtime)

```ts
if (url === '/@react-refresh-runtime') {
  const result = await server.transformRequest('/@react-refresh')
  res.end(result.code)
}
```

Serves the real react-refresh runtime under an alternate URL, so the wrapper can import it.

### 6. Expose Module Stubs

```ts
if (url?.includes('__federation_expose_')) {
  const match = url.match(/__federation_expose_(.+?)\.js/)
  const exposeName = match[1]
  const exposeItem = parsedOptions.devExpose.find(...)
  const modulePath = exposeItem[1].import
  const viteUrl = toViteUrl(modulePath, resolvedRoot)
  const code = `export { default } from '${viteUrl}';
                export * from '${viteUrl}';`
  res.end(code)
}
```

Serves thin re-export stubs that point to real source files. The browser follows the import to the real file, which Vite serves with HMR metadata.

The `toViteUrl()` function converts filesystem paths to Vite-serveable URLs:
- Paths inside the project root → root-relative (`/src/pages/index.tsx`)
- Paths outside the project root → `/@fs/absolute/path`

## Middleware on the Host (devRemotePlugin)

### @react-refresh Global Storage

```ts
if (parsedOptions.devRemote.length) {
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

The host's `@react-refresh` is patched to store itself on `window.__vite_react_refresh_runtime__`. This is the global singleton that the remote's `@react-refresh` wrapper will find and re-use.

## Middleware Execution Order

```
Request to Remote Dev Server (localhost:6001)
  │
  ▼
┌─────────────────────────────┐
│ CORS Headers Middleware     │  ← All requests get CORS headers
│ Access-Control-Allow-*      │
└────────────┬────────────────┘
             │
             ▼
┌─────────────────────────────┐
│ URL Matching Middleware     │
│                             │
│ /remoteEntry.js ──────────► Serve virtual module via transformRequest
│ /@vite/client ────────────► Patch base URL to absolute origin
│ /@react-refresh ──────────► Serve singleton wrapper
│ /@react-refresh-runtime ──► Serve real runtime
│ /__federation_expose_* ───► Serve re-export stub
│ (anything else) ──────────► next() → Vite's normal handler
└─────────────────────────────┘
```
