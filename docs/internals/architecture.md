# Plugin Architecture

## Entry Point

The plugin is exported from `packages/lib/src/index.ts` as a single Vite plugin with `enforce: 'post'`. This ensures it runs after Vite's built-in plugins (like `vite:css-post`).

```ts
// packages/lib/src/index.ts
const federation = (options: VitePluginFederationOptions): Plugin => {
  return {
    name: 'hugs7:federation',
    enforce: 'post',
    // ... hooks delegate to sub-plugins
  }
}
```

## Sub-Plugin Delegation

The main plugin doesn't implement federation logic directly. Instead, it creates a list of sub-plugins based on the current mode and delegates every Vite hook to them:

```ts
const registerPlugins = (mode: string, command: string) => {
  if (mode === 'production' || command === 'build') {
    pluginList = [
      prodSharedPlugin(options),
      prodExposePlugin(options),
      prodRemotePlugin(options)
    ]
  } else if (mode === 'development' || command === 'serve') {
    pluginList = [
      devSharedPlugin(options),
      devExposePlugin(options),
      devRemotePlugin(options)
    ]
  }
}
```

Each hook iterates through `pluginList` and calls the corresponding method:

```ts
config(config, env) {
  for (const pluginHook of pluginList) {
    pluginHook.config?.call(this, config, env)
  }
},
transform(code, id) {
  for (const pluginHook of pluginList) {
    const result = pluginHook.transform?.call(this, code, id)
    if (result) return result
  }
  return code
}
```

For `resolveId` and `load`, the main plugin also checks `@rollup/plugin-virtual` for virtual module resolution.

## Virtual Modules

Each sub-plugin can declare a `virtualFile` property — a record of virtual module IDs to their source code. These are registered with `@rollup/plugin-virtual`:

```ts
let virtualFiles = {}
pluginList.forEach((plugin) => {
  if (plugin.virtualFile) {
    virtualFiles = Object.assign(virtualFiles, plugin.virtualFile)
  }
})
virtualMod = virtual(virtualFiles)
```

Key virtual modules:
- `__remoteEntryHelper__remoteEntry.js` — the remote entry source (from `devExposePlugin` or `prodExposePlugin`)
- `__federation__` — the federation runtime with `__federation_method_getRemote`, `__federation_method_ensure`, etc. (from `devRemotePlugin` or `prodRemotePlugin`)
- `__federation_fn_import` — the `importShared()` function (production only, from `prodSharedPlugin`)

## Shared State

Global state is stored in `packages/lib/src/public.ts`:

```ts
export const parsedOptions = {
  prodExpose: [],  prodRemote: [],  prodShared: [],
  devShared: [],   devExpose: [],   devRemote: []
}

export const builderInfo = {
  builder: 'rollup',
  isHost: false,    // has remotes or shared config
  isRemote: false,  // has exposes config
  isShared: false   // has shared config
}
```

`builderInfo.isHost` and `builderInfo.isRemote` determine which code paths are active. An app can be **both** host and remote simultaneously.

## PluginHooks Type

Sub-plugins implement the `PluginHooks` interface, which extends Vite's `Plugin` type with a `virtualFile` property:

```ts
// types/pluginHooks.d.ts
import { Plugin as VitePlugin } from 'vite'
export interface PluginHooks extends VitePlugin {
  virtualFile?: Record<string, unknown>
}
```

## Hook Execution Order

During Vite startup and request handling:

1. **`config()`** — each sub-plugin modifies the Vite config (e.g., adding `optimizeDeps.exclude`)
2. **`configResolved()`** — sub-plugins receive the final resolved config
3. **`configureServer()`** — expose plugin adds middleware (CORS, remoteEntry serving, @vite/client patching)
4. **`resolveId()`** → **`load()`** — virtual module resolution
5. **`transform()`** — remote plugin rewrites `import('remote/module')` to federation calls; expose plugin handles shared module transforms

## File Map

| File | Purpose |
|------|---------|
| `src/index.ts` | Main plugin, hook delegation |
| `src/public.ts` | Shared state (`parsedOptions`, `builderInfo`) |
| `src/debug.ts` | Debug logging snippets for runtime code |
| `src/utils/index.ts` | Option parsing, path utilities |
| `src/dev/shared-development.ts` | Dev: parse shared options |
| `src/dev/expose-development.ts` | Dev: remoteEntry, shared wrappers, server middleware |
| `src/dev/remote-development.ts` | Dev: host-side federation runtime, import rewriting |
| `src/prod/shared-production.ts` | Prod: shared chunk emission, `importShared()` |
| `src/prod/expose-production.ts` | Prod: remoteEntry generation, CSS handling |
| `src/prod/remote-production.ts` | Prod: host-side runtime, import rewriting, preloading |
