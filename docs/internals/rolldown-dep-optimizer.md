# The Rolldown Dep Optimizer

Vite 8+ uses Rolldown (instead of esbuild) for dependency optimization. Understanding how Rolldown handles CJS and ESM modules is critical for debugging federation issues.

## What the Dep Optimizer Does

When Vite starts, it pre-bundles dependencies from `node_modules/` into optimized ESM modules stored in `node_modules/.vite/deps/`. This:

1. Converts CJS modules to ESM
2. Bundles many internal files into single modules
3. Creates shared chunks for code used by multiple dependencies
4. Stores metadata in `_metadata.json`

## CJS Module Processing (react)

React 19 is a CJS package. Rolldown converts it to:

```js
// node_modules/.vite/deps/react.js
var require_react = __commonJS({
  "node_modules/react/index.js"(exports, module) {
    // ... CJS code
    module.exports = { createElement, useState, useEffect, ... }
  }
});

// ESM exports wrapping the CJS factory
export default require_react();
export { require_react as t };
```

The **critical property** is that `require_react` is a named export (`t`). Every other dep-optimized module that uses React imports this same factory:

```js
// node_modules/.vite/deps/react-dom.js  
import { t as require_react } from "./react.js";

// node_modules/.vite/deps/chunk-ABCD1234.js
import { t as require_react } from "./react.js";
```

This means **all consumers share one factory** — making it the perfect intercept point.

## ESM Module Processing (react-redux)

ESM modules like `react-redux` are handled differently:

```js
// node_modules/.vite/deps/react-redux.js
export { Provider, useSelector, useDispatch, ... } from "./chunk-XYZ.js";
```

The actual code lives in shared chunks. Other packages may also import from `chunk-XYZ.js` directly, bypassing the `react-redux.js` entry entirely.

## Why resolve.alias + CJS Shims Failed

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

### Why the Virtual Wrapper Approach Avoids This

The current approach (virtual modules via `resolveId` + `load`) operates at the Vite plugin level, **not** at the Rolldown optimizer level:

1. Rolldown processes `react` normally → generates clean `require_react` factory
2. When application code does `import React from 'react'`, Vite's plugin pipeline intercepts it
3. The `resolveId` hook returns a virtual module ID
4. The `load` hook returns wrapper code that checks `globalThis` first
5. Rolldown never sees the alias → no `__esmMin` bug

```
                  Rolldown Dep Optimizer
                  ┌─────────────────────┐
                  │ react.js            │
node_modules/ ───►│ require_react = ... │  ← Processes normally
react/            │ export default ...  │
                  └─────────────────────┘
                           │
                           │ (dep-optimized files reference this)
                           ▼
                  Vite Plugin Pipeline
                  ┌─────────────────────┐
App code:         │ resolveId('react')  │
import React ────►│ → virtual wrapper   │  ← Intercepts at plugin level
from 'react'      │                     │
                  │ load(virtual:react) │
                  │ → globalThis check  │
                  │   ?? import local   │
                  └─────────────────────┘
```

## The Previous Rolldown Plugin Approach (Commit 48ba606)

Another failed attempt used `rolldownOptions.plugins` with a virtual ESM wrapper:

```js
// Wrong approach - claimed "Rolldown inlines CJS require() calls"
rolldownOptions: {
  plugins: [{
    name: 'federation-shared-bridge',
    resolveId(id) { /* redirect to virtual */ },
    load(id) { /* return ESM wrapper */ }
  }]
}
```

This was based on the incorrect assumption that "Rolldown inlines CJS `require()` calls making the runtime `globalThis` check dead code." Testing proved this was **false** — Rolldown does NOT inline CJS require calls in the dep optimizer output.

## Debugging Dep Optimizer Output

To inspect what Rolldown generates:

```bash
# Check dep optimizer output
ls node_modules/.vite/deps/

# Inspect a specific module
cat node_modules/.vite/deps/react.js

# Check metadata
cat node_modules/.vite/deps/_metadata.json
```

Force re-optimization:
```bash
rm -rf node_modules/.vite && npx vite --port 6001
```

The `_metadata.json` file contains the mapping from package names to optimized file paths — the plugin uses this to match transform targets.
