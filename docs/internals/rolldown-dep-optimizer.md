# The Rolldown Dep Optimizer

Vite 8+ uses Rolldown (instead of esbuild) for dependency optimization. Understanding how the federation plugin interacts with the dep optimizer is critical for debugging federation issues.

## What the Dep Optimizer Does

When Vite starts, it pre-bundles dependencies from `node_modules/` into optimized ESM modules stored in `node_modules/.vite/deps/`. This:

1. Converts CJS modules to ESM
2. Bundles many internal files into single modules
3. Creates shared chunks for code used by multiple dependencies
4. Stores metadata in `_metadata.json`

## Current Approach: Externalize + Federation Pre-Bundle

The federation plugin uses a two-part strategy to handle shared modules:

### Part 1: Externalize Shared Modules from the Dep Optimizer

A Rolldown plugin inside `optimizeDeps.rolldownOptions.plugins` marks ALL shared modules as `external`:

```ts
optimizeDeps: {
  rolldownOptions: {
    plugins: [{
      name: 'federation-dep-externalize',
      resolveId(id) {
        if (sharedModuleMeta.has(id)) {
          return { id, external: true }
        }
      }
    }]
  }
}
```

This means when Vite's dep optimizer bundles a dependency that imports `react`, it generates:

```js
// node_modules/.vite/deps/some-ui-library.js
import react from "react";  // ← external, bare specifier preserved
// ... uses react normally
```

Instead of the old behavior where it would inline or chunk-split the shared module. The bare specifier is then intercepted by the plugin's `resolveId` hook at runtime.

### Part 2: Federation Pre-Bundle via rolldown.build()

At server startup, the plugin runs a separate `rolldown.build()` to bundle each shared module into clean ESM files:

```
node_modules/.federation-deps/
  react.js              ← Clean ESM (CJS input → ESM output)
  react-dom.js
  react-redux.js
  react/jsx-runtime.js
```

This federation pre-bundle:
- Handles CJS-to-ESM conversion automatically (Rolldown normalizes all formats)
- Produces self-contained files with no cross-chunk dependencies
- Serves as the **fallback** when running in standalone mode (no host providing shared modules)

### Part 3: Virtual Wrappers (resolveId + load)

When application code imports a shared module, the plugin's Vite-level hooks intercept it:

```
App code: import React from 'react'
  │
  ▼
resolveId('react') → '\0virtual:__federation_shared__:react'
  │
  ▼
load('\0virtual:...') → wrapper code:
  │  const __shared = globalThis.__federation_shared_modules__?.['react'];
  │  const __mod = __shared ?? await import('/node_modules/.federation-deps/react.js');
  │  export default (__mod.default ?? __mod);
  ▼
Browser executes wrapper → uses host's React (if federated) or federation pre-bundle (if standalone)
```

## Why This Is Better Than the Old Approach

The previous approach let Vite's dep optimizer process shared modules normally, then tried to intercept them downstream:

- **CJS modules** were served from `.vite/deps/` — required understanding Rolldown's CJS factory output format
- **ESM modules** were served from `/@fs/` URLs — required different middleware and `?__fed_raw` query params
- A `isCjsFile()` heuristic was needed to classify each module
- `.vite/deps/` response monkey-patching middleware intercepted and modified optimizer output
- CJS sub-dep redirect middleware handled transitive dependencies

The new approach is simpler: shared modules never enter the dep optimizer, so there's nothing to intercept or patch downstream. The federation pre-bundle provides a uniform fallback regardless of the original module format.

## Historical Context: Why resolve.alias Failed

An earlier approach wrote CJS shim files and used `resolve.alias` to redirect imports:

```js
// .federation-shims/react.cjs
const g = globalThis.__federation_shared_modules__;
if (g && g['react']) {
  module.exports = g['react'];
} else {
  module.exports = require('/real/path/to/react');
}
```

```js
// vite.config
resolve: {
  alias: {
    react: '.federation-shims/react.cjs'
  }
}
```

### The __esmMin Bug

With this alias, Rolldown's dep optimizer treated the shim as a different module entry point. Instead of generating clean top-level imports:

```js
// ✅ Without alias (clean)
import { t as require_react } from "./react.js";
var import_react = require_react();
import_react.createElement(...)
```

It generated lazy `__esmMin` initialization wrappers:

```js
// ❌ With alias (broken)
var __esmMin_react;
var init_react = () => {
  __esmMin_react = require('./react-shim.cjs');
};

// In some files, the init was ANONYMOUS — a Rolldown bug:
var init_react = () => { /* sets __esmMin_react */ };

// Usage
init_react();
__esmMin_react.createElement(...)  // undefined if anonymous init!
```

The anonymous `__esmMin` init caused `import_react` (or equivalent) to be `undefined` for some UI library components:

```
TypeError: Cannot read properties of undefined (reading 'useRef')
```

This was not a federation logic error — it was Rolldown generating broken code because the alias changed its optimization assumptions.

### Why the Current Approach Avoids This

The current approach externalizes shared modules from the dep optimizer entirely. Rolldown never tries to bundle, alias, or wrap them — it just emits `import react from "react"` as an external import. The interception happens purely at the Vite plugin level via `resolveId` + `load`.

```
                  Rolldown Dep Optimizer
                  ┌─────────────────────────────┐
                  │ some-ui-library.js           │
node_modules/ ───►│ import react from "react";   │  ← Shared modules are external
ui-library/       │ // ... uses react normally   │
                  └──────────────────────────────┘
                           │
                           │ (bare specifier preserved)
                           ▼
                  Vite Plugin Pipeline
                  ┌─────────────────────────────┐
App code:         │ resolveId('react')           │
import React ────►│ → virtual wrapper            │  ← Intercepts at plugin level
from 'react'      │                              │
                  │ load(virtual:react)           │
                  │ → globalThis check            │
                  │   ?? import federation        │
                  │      pre-bundle               │
                  └──────────────────────────────┘
```

## Debugging

### Inspect dep optimizer output

```bash
# Check dep optimizer output (shared modules should NOT appear here)
ls node_modules/.vite/deps/

# Verify shared modules are externalized — look for bare specifiers in deps
grep -r '"react"' node_modules/.vite/deps/ --include='*.js'

# Check metadata
cat node_modules/.vite/deps/_metadata.json
```

### Inspect federation pre-bundle output

```bash
# Check federation pre-bundle output
ls node_modules/.federation-deps/

# Inspect a specific module
cat node_modules/.federation-deps/react.js
```

### Force re-optimization

```bash
rm -rf node_modules/.vite node_modules/.federation-deps && npx vite --port 6001
```
