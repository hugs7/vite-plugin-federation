# Introduction

`@hugs7/vite-plugin-federation` implements [Module Federation](https://webpack.js.org/concepts/module-federation/) for Vite 8+ applications. It allows independently deployed applications to share modules at runtime — one application (the **host**) can dynamically load components from another (the **remote**) without bundling them together at build time.

## Why This Plugin?

Traditional module federation solutions were built for webpack. As teams migrate to Vite, they need federation that understands Vite's dev server, its Rolldown-based dependency optimizer, and its ESM-first architecture.

This plugin provides:

- **Dev mode federation** — load remote modules from another Vite dev server with full HMR support
- **Production federation** — generate optimized `remoteEntry.js` bundles compatible with both Vite and webpack hosts
- **Shared module deduplication** — ensure libraries like React, React-Redux, and Zustand are singletons across the federation boundary
- **Vite 8 / Rolldown compatibility** — work correctly with Rolldown's dep optimizer, which handles CJS and ESM modules differently than esbuild

## Key Concepts

### Host and Remote

- **Host**: The main application (e.g., a Single-Page Application) that loads remote modules at runtime
- **Remote**: A micro-frontend or widget that exposes modules for the host to consume

### The init/get Protocol

Federation follows a simple protocol:

1. Host loads `remoteEntry.js` from the remote
2. Host calls `init(shareScope)` — providing factories for shared modules (react, react-dom, etc.)
3. Remote resolves these factories and stores the results globally
4. Host calls `get('./module')` — the remote returns the requested module, using the host's shared modules instead of its own copies

### Share Scope

The share scope is an object mapping module names to version-keyed factories:

```js
{
  'react': {
    '19.2.4': {
      get: () => import('react').then(m => () => m.default ?? m)
    }
  },
  'react-redux': {
    '9.2.0': {
      get: () => import('react-redux').then(m => () => m)
    }
  }
}
```

Each factory's `get()` returns a function that resolves to the actual module. This lazy pattern allows the remote to decide whether to use the host's version or its own fallback.

## Architecture at a Glance

The plugin registers as a single Vite plugin (`hugs7:federation`) with `enforce: 'post'`. Internally, it creates three sub-plugins depending on the mode:

| Mode | Sub-plugins |
|------|-------------|
| Development | `devSharedPlugin`, `devExposePlugin`, `devRemotePlugin` |
| Production | `prodSharedPlugin`, `prodExposePlugin`, `prodRemotePlugin` |

Each sub-plugin handles one aspect of federation:

- **Shared** — parses shared module configuration
- **Expose** — handles modules exposed by a remote (generates `remoteEntry.js`)
- **Remote** — handles remote module consumption on the host side

See [Plugin Architecture](/internals/architecture) for the full details.
