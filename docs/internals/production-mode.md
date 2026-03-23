# Production Mode

In production mode, the plugin uses three sub-plugins that operate during Vite's build process.

## prodSharedPlugin (shared-production.ts)

Handles shared module chunk emission and version resolution.

### Key Responsibilities

1. **Parse shared options** — calls `parseSharedOptions()` to populate `parsedOptions.prodShared`

2. **Emit shared chunks** — in `buildStart()`, emits each shared module as a separate chunk via `this.emitFile()`:
   ```ts
   this.emitFile({
     name: '__federation_fn_import',
     type: 'chunk',
     id: '__federation_fn_import',
     preserveSignature: 'strict'
   })
   ```

3. **Version resolution** — reads `package.json` from each shared module to determine versions, handling monorepo layouts

4. **Manual chunks** — in `outputOptions()`, provides a `manualChunks` function that groups shared module dependencies into their own chunks

5. **`importShared()` function** — provides the `__federation_fn_import` virtual module containing the `importShared()` function used at runtime

6. **Clean up** — in `generateBundle()`, removes shared chunks with `generate: false`

### The importShared() Runtime

The `federation_fn_import.js` file provides the `importShared()` function that production builds use:

```js
const moduleMap = __rf_var__moduleMap;
const moduleCache = Object.create(null);

async function importShared(name, shareScope = 'default') {
  // Check global share scope first (populated by host)
  // Fall back to local module if not found
}
```

## prodExposePlugin (expose-production.ts)

Generates the production `remoteEntry.js`.

### Key Responsibilities

1. **Emit remote entry** — in `buildStart()`, emits the remote entry as a chunk:
   ```ts
   this.emitFile({
     fileName: `assets/remoteEntry.js`,
     type: 'chunk',
     id: `__remoteEntryHelper__remoteEntry.js`,
     preserveSignature: 'strict'
   })
   ```

2. **Emit expose chunks** — each exposed module gets its own chunk

3. **CSS handling** — replaces CSS placeholders with actual filenames in `generateBundle()`, handles both `cssCodeSplit: true` (per-module CSS) and `cssCodeSplit: false` (single CSS file)

4. **Path resolution** — replaces expose path placeholders (`${__federation_expose_X}`) with final chunk paths relative to the remote entry

### Production init() vs Dev init()

```js
// Production: only stores in globalThis.__federation_shared__
export const init = (shareScope) => {
  globalThis.__federation_shared__ = globalThis.__federation_shared__ || {};
  Object.entries(shareScope).forEach(([key, value]) => {
    // Store version-keyed entries
  });
};

// No pre-resolution of shared modules
// No @vite/client loading
```

In production, shared modules are resolved lazily via `importShared()` instead of eagerly in `init()`.

## prodRemotePlugin (remote-production.ts)

Handles the host-side federation runtime for production builds.

### Key Responsibilities

1. **Generate `__federation__` virtual module** — similar to dev mode but with `importShared()` support

2. **Emit federation runtime chunk** — prevents the federation runtime from being inlined into the entry chunk, avoiding circular imports:
   ```ts
   if (builderInfo.isHost && !federationRuntimeEmitted) {
     federationRuntimeEmitted = true
     this.emitFile({
       type: 'chunk',
       id: '__federation__',
       name: '__federation_runtime__',
       preserveSignature: 'strict'
     })
   }
   ```

3. **Transform imports** — rewrites both:
   - Shared module imports → `await importShared('react')`
   - Remote module imports → `__federation_method_getRemote()`

4. **Smart skip logic** — avoids transforming files that would cause circular dependencies:
   - Host-only builds: skip all `node_modules/` (shared modules would import themselves)
   - Remote builds: skip only the shared module's own package files
   - Non-node_modules: always transform

5. **HTML preloading** — in `generateBundle()`, injects `<link rel="modulepreload">` tags for shared modules into HTML entry points

### The Shared Module Transform

In production, shared module imports are rewritten to use `importShared()`:

```js
// Original
import React from 'react'
import { useSelector } from 'react-redux'

// Rewritten to
const React = await importShared('react');
const { useSelector } = await importShared('react-redux');
```

This `await importShared()` call creates a **Top-Level Await (TLA)** in the module, which is why the plugin must carefully avoid transforming files that would create circular TLA dependencies.

### The Circular Dependency Fix

The federation runtime is emitted as its own chunk to prevent this cycle:

```
entry.js → imports __federation__ 
         → which has wrapShareModule with import.meta.ROLLUP_FILE_URL_X
         → which points to shared chunk
         → which may import entry.js (circular!)
```

By emitting `__federation_runtime__` as a separate chunk:

```
entry.js → imports __federation_runtime__ chunk
         → which has share scope code
         → shared chunks are independent
         → no circular dependency ✅
```
