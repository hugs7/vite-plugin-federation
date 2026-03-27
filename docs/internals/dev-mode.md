# Dev Mode Overview

In development mode, three sub-plugins cooperate to enable live module federation between Vite dev servers:

## The Three Sub-Plugins

### 1. `devSharedPlugin` (shared-development.ts)

The simplest of the three — it only parses shared module configuration:

```ts
export const devSharedPlugin = (options): PluginHooks => {
  parsedOptions.devShared = parseSharedOptions(options)
  return { name: 'hugs7:shared-development' }
}
```

The parsed options are stored in `parsedOptions.devShared` and consumed by the other two plugins.

### 2. `devExposePlugin` (expose-development.ts)

The most complex plugin. It handles everything on the **remote** side:

- **Generates `remoteEntry.js`** — the virtual module that implements `init()` and `get()`
- **Externalizes shared modules** from the dep optimizer via a Rolldown plugin in `optimizeDeps.rolldownOptions.plugins`, and runs a federation pre-bundle (`rolldown.build()`) at startup to produce clean ESM fallbacks in `node_modules/.federation-deps/`
- **Shared module virtual wrappers** — `resolveId` + `load` hooks that intercept bare imports of shared modules and serve wrapper code checking `globalThis.__federation_shared_modules__`, falling back to the federation pre-bundle
- **`configureServer()` middleware** — CORS headers, remoteEntry serving, `@vite/client` patching, `@react-refresh` singleton, expose module stubs

### 3. `devRemotePlugin` (remote-development.ts)

Handles everything on the **host** side:

- **Generates `__federation__` virtual module** — contains `__federation_method_ensure()`, `__federation_method_getRemote()`, and the share scope factory code
- **`transform()` hook** — rewrites `import('remote/module')` and `import { X } from 'remote/module'` statements to use `__federation_method_getRemote()`
- **`configureServer()` middleware** — patches `@react-refresh` on the host to store its runtime as a window global

## Dev Mode Request Flow

When a user navigates to a federated route on the host (e.g., `localhost:3000/interactiondashboard`):

1. The host's router component does `import('interactiondashboard/pages')`
2. The plugin's transform rewrites this to `__federation_method_getRemote('interactiondashboard', './pages')`
3. `__federation_method_ensure()` dynamically imports `http://localhost:6001/remoteEntry.js`
4. The host calls `remoteEntry.init(shareScope)` with factories for each shared module
5. `init()` resolves each factory and stores results in `globalThis.__federation_shared_modules__`
6. The host calls `remoteEntry.get('./pages')`
7. `get()` awaits `init()` completion, then dynamically imports `__federation_expose_pages.js`
8. The expose stub re-exports from the real source file — Vite tracks it for HMR
9. The source file's imports of `react`, `react-redux`, etc. are intercepted by the shared module wrappers, which read from `globalThis.__federation_shared_modules__` — using the **host's** copies

## Virtual Module Graph

```
Host (localhost:3000)                    Remote (localhost:6001)
┌─────────────────────┐                  ┌──────────────────────────┐
│  App.tsx             │                  │  remoteEntry.js          │
│  └─ import(remote/…) │──HTTP──────────►│  ├─ init(shareScope)     │
│     ↓ rewritten to   │                  │  │  └─ resolve factories │
│  __federation__      │                  │  │     └─ store in       │
│  ├─ remotesMap       │                  │  │       globalThis       │
│  ├─ wrapShareScope   │                  │  └─ get('./pages')       │
│  └─ ensure/getRemote │                  │     └─ import expose stub│
│                      │                  │        └─ pages/index.tsx│
│  Share scope code:   │                  │           └─ import react│
│  import('react')     │                  │              ↓ wrapper   │
│    .then(m => ...)   │                  │           globalThis     │
│                      │                  │           shared modules │
└─────────────────────┘                  └──────────────────────────┘
```
