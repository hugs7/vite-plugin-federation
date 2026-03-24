<p align="center">
  <img src="https://vitejs.dev/logo.svg" width="80" alt="Vite logo" />
</p>

<h1 align="center">@hugs7/vite-plugin-federation</h1>

<p align="center">
  <strong>Module Federation for Vite & Rollup — with true dev-mode HMR</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@hugs7/vite-plugin-federation"><img src="https://badgen.net/npm/v/@hugs7/vite-plugin-federation" alt="npm version"></a>
  <a href="https://github.com/hugs7/vite-plugin-federation/actions/workflows/ci.yml"><img src="https://github.com/hugs7/vite-plugin-federation/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI"></a>
  <a href="https://nodejs.org/en/about/releases/"><img src="https://img.shields.io/badge/node-%3E%3D22-brightgreen" alt="Node &gt;=22"></a>
  <a href="https://www.npmjs.com/package/@hugs7/vite-plugin-federation"><img src="https://badgen.net/npm/license/@hugs7/vite-plugin-federation" alt="License"></a>
</p>

<p align="center">
  A maintained, modernised fork of <a href="https://github.com/originjs/vite-plugin-federation">originjs/vite-plugin-federation</a> —<br/>
  rebuilt for <strong>Vite 8+</strong>, <strong>Rolldown</strong>, <strong>Node 22+</strong>, and true dev-mode federation with React Fast Refresh.
</p>

---

## ✨ What's New in This Fork

This fork extends the original plugin with capabilities that didn't exist before — most notably, **full dev-mode federation** where both HOST and REMOTE run Vite dev servers, with instant cross-origin React Fast Refresh.

### 🔥 Dev-Mode Remote Expose Server

The original plugin required the remote side to run `vite build` (or `vite build --watch`) even during development. This fork introduces a **dev expose server** — the remote's Vite dev server serves `remoteEntry.js` and exposed modules directly via middleware, with full CORS support.

- No build step needed for the remote during development
- Shared modules (React, Redux, etc.) are bridged via **CJS shim files** generated at startup
- Shims use `resolve.alias` with exact regex matching so `react` doesn't match `react-dom`
- ESM packages that can't be enumerated in Node.js (e.g. packages referencing `window` at top level) get automatic CJS fallback shims
- The host's share scope provides module instances via `import()` by bare specifier, with intelligent unwrapping for CJS-only deps

### ⚡ True Cross-Origin HMR with React Fast Refresh

This is the headline feature. When a remote MFE file changes, the update appears **instantly** in the host SPA — no page reload, full React Fast Refresh with state preservation.

How it works under the hood:

1. **Re-export stubs** — Exposed modules are served as thin re-export stubs (`export * from '/src/index.ts'`) instead of transformed snapshots. The browser follows the import to the real source file on the remote's Vite dev server, which Vite tracks in its module graph.

2. **Patched `@vite/client`** — The remote's `/@vite/client` is intercepted and its `base` variable is patched from `"/"` to the absolute remote origin (e.g. `"http://localhost:6001/"`). This ensures HMR module re-imports resolve to the remote dev server, not the host page origin.

3. **Shared React Refresh runtime** — The host's `/@react-refresh` stores itself as a global singleton. The remote's `/@react-refresh` detects this and re-exports the host's singleton, ensuring all component families, mounted roots, and renderer references are tracked in one place. In standalone mode, the remote's own runtime is used instead.

The result: editing a component in the remote MFE triggers React Fast Refresh in the host SPA — often **faster** than standalone mode, because Fast Refresh only re-renders the changed component leaf without reconciling the full provider tree.

### 🛡️ TLA Deadlock Prevention (Rolldown)

Fixes top-level `await` deadlocks that occur with Rolldown's code-splitting. When multiple async chunks depend on each other through shared federation modules, the original plugin could produce circular TLA dependencies. This fork restructures the async resolution to prevent deadlocks.

### 📦 Modern Tooling & Node.js

- **Node.js 22+** minimum (dropped legacy Node support)
- **Vite 8+** and **Rolldown** support
- Updated all dependencies to latest versions
- Fixed CI pipeline for modern Node.js and npm

---

## 📖 Table of Contents

- [Install](#install)
- [Quick Start](#quick-start)
- [Dev Mode](#dev-mode)
- [Configuration](#configuration)
- [Webpack Interop](#webpack-interop)
- [Runtime API](#runtime-api)
- [FAQ](#faq)
- [Acknowledgements](#acknowledgements)

---

## Install

```bash
npm install @hugs7/vite-plugin-federation --save-dev
```

## Quick Start

### Remote (exposes modules)

```js
// vite.config.js
import federation from '@hugs7/vite-plugin-federation';

export default {
  plugins: [
    federation({
      name: 'remote-app',
      filename: 'remoteEntry.js',
      exposes: {
        './Button': './src/Button.vue',
      },
      shared: ['vue'],
    }),
  ],
};
```

### Host (consumes modules)

```js
// vite.config.js
import federation from '@hugs7/vite-plugin-federation';

export default {
  plugins: [
    federation({
      name: 'host-app',
      remotes: {
        remote_app: 'http://localhost:5001/assets/remoteEntry.js',
      },
      shared: ['vue'],
    }),
  ],
};
```

### Use the remote module

```js
// Vue
const RemoteButton = defineAsyncComponent(() => import('remote_app/Button'));

// React
const RemoteButton = React.lazy(() => import('remote_app/Button'));
```

---

## Dev Mode

### Full dev-mode federation (🆕 this fork)

Both host and remote run `vite dev`. The remote serves its exposed modules directly from its dev server — no build step required.

```js
// Remote vite.config.js — just run `vite dev`
federation({
  name: 'my-mfe',
  filename: 'remoteEntry.js',
  exposes: {
    './pages': './src/index.ts',
  },
  shared: ['react', 'react-dom', 'react-redux'],
});
```

```js
// Host vite.config.js — also `vite dev`
federation({
  name: 'my-spa',
  remotes: {
    'my-mfe': {
      external: 'http://localhost:6001/remoteEntry.js',
      format: 'esm',
      from: 'vite',
    },
  },
  shared: ['react', 'react-dom', 'react-redux'],
});
```

Edit a component in the remote → it updates instantly in the host via React Fast Refresh. ⚡

### How shared modules work in dev mode

The plugin generates **CJS bridge shims** in `node_modules/.federation-shims/` for each shared module. These shims check `globalThis.__federation_shared_modules__` at runtime:

- If the host has provided the module (federation mode) → use the host's instance
- If not (standalone mode) → `require()` the local copy

This ensures singleton guarantees for React, Redux contexts, and other shared state — the same instance is used by both host and remote.

### Build/link workflow (local development)

```bash
# Build the plugin
pnpm build

# Link it
cd packages/lib && npm link
cd /path/to/your-mfe && npm link @hugs7/vite-plugin-federation
cd /path/to/your-spa && npm link @hugs7/vite-plugin-federation

# Clear caches before restarting dev servers
rm -rf node_modules/.vite node_modules/.federation-shims
```

---

## Configuration

### `name: string`

**Required.** The module name of the remote.

### `filename: string`

Entry file of the remote module. Default: `remoteEntry.js`

### `exposes`

Components exposed by the remote:

```js
exposes: {
  // Basic
  './Button': './src/Button.vue',

  // With options
  './Button': {
    import: './src/Button.vue',
    name: 'button',
    dontAppendStylesToHead: true,
  },
}
```

### `remotes`

Remote modules consumed by the host:

```js
remotes: {
  // Basic
  remote_app: 'http://localhost:5001/assets/remoteEntry.js',

  // With options
  remote_app: {
    external: 'http://localhost:5001/assets/remoteEntry.js',
    format: 'esm',    // 'esm' | 'var' | 'systemjs'
    from: 'vite',     // 'vite' | 'webpack'
  },
}
```

### `shared`

Dependencies shared between host and remote:

```js
// Simple
shared: ['vue', 'pinia']

// With version control
shared: {
  vue: { version: '3.x', requiredVersion: '^3.0.0' },
  react: { singleton: true },
}
```

### `transformFileTypes: string[]`

Additional file types for the plugin to process. Defaults: `['.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs', '.vue', '.svelte']`

---

## Webpack Interop

This plugin is compatible with [Webpack Module Federation](https://webpack.js.org/concepts/module-federation/). You can consume Webpack-exposed modules in Vite or vice versa.

```js
remotes: {
  webpack_app: {
    external: 'http://localhost:5001/remoteEntry.js',
    format: 'var',
    from: 'webpack',
  },
}
```

> ⚠️ Mixing Vite and Webpack in React projects is not recommended due to differences in how they bundle CommonJS modules.

---

## Runtime API

Add remotes dynamically at runtime via `virtual:__federation__`:

```js
import {
  __federation_method_setRemote,
  __federation_method_getRemote,
  __federation_method_unwrapDefault,
} from 'virtual:__federation__';

// Register a remote at runtime
__federation_method_setRemote('remote_app', {
  url: 'http://localhost:5001/assets/remoteEntry.js',
  format: 'esm',
  from: 'vite',
});

// Load a module
const module = await __federation_method_getRemote('remote_app', './Button');
const Button = __federation_method_unwrapDefault(module);
```

<details>
<summary>TypeScript declarations</summary>

```ts
declare module 'virtual:__federation__' {
  interface IRemoteConfig {
    url: (() => Promise<string>) | string;
    format: 'esm' | 'systemjs' | 'var';
    from: 'vite' | 'webpack';
  }

  export function __federation_method_setRemote(name: string, config: IRemoteConfig): void;
  export function __federation_method_getRemote(name: string, exposedPath: string): Promise<unknown>;
  export function __federation_method_unwrapDefault(module: unknown): unknown;
  export function __federation_method_wrapDefault(module: unknown, need: boolean): unknown;
  export function __federation_method_ensure(remoteName: string): Promise<unknown>;
}
```

</details>

---

## FAQ

### `Top-level await` is not available in the configured target environment

Set `build.target` to `esnext`:

```js
build: {
  target: 'esnext',
}
```

### Remote module failed to load shared dependency

Explicitly declare `server.host` and `server.port` in the remote's Vite config to ensure the plugin can resolve dependency addresses correctly.

### TypeScript: Cannot find module `'remote/Component'`

Add a declaration file:

```ts
declare module 'remote_app/*' {}
```

---

## Acknowledgements

This project is a fork of [`originjs/vite-plugin-federation`](https://github.com/originjs/vite-plugin-federation), originally created by the [Origin.js](https://github.com/nicepkg) team under the [Mulan PSL v2 license](http://license.coscl.org.cn/MulanPSL2). Their foundational work on Module Federation for Vite made this project possible.

This fork (`@hugs7/vite-plugin-federation`) extends the original with dev-mode remote serving, cross-origin React Fast Refresh, Rolldown compatibility, and modern Node.js support.

---

<p align="center">
  Made with ☕ by <a href="https://github.com/hugs7">@hugs7</a>
</p>
