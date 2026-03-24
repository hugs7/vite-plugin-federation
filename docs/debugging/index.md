# Debug Logging

The plugin includes a built-in debug logging system modeled after the `debug` npm package. It's available in both dev and production runtime code.

## Enabling Debug Logs

### In the Browser

Open the browser console and set:

```js
localStorage.debug = 'federation:*'
```

Then reload the page. You'll see colored log output for federation events.

### Namespace Patterns

| Pattern | What it shows |
|---------|--------------|
| `federation:*` | All federation logs |
| `federation:init` | Remote entry `init()` — shared module resolution |
| `federation:get` | Remote entry `get()` — exposed module loading |

### Example Output

```
federation:init Resolving shared modules: ['react', 'react-dom', 'react-redux']
federation:init Resolved: react ['default', '__esModule']
federation:init Resolved: react-dom ['default', '__esModule']
federation:init Resolved: react-redux ['Provider', 'useSelector', 'useDispatch', ...]
federation:get ./pages shared modules populated: ['react', 'react-dom', 'react-redux']
```

## How It Works

The debug snippets are defined in `packages/lib/src/debug.ts`:

### ESM Snippet (Virtual Modules)

```js
const __fed_debug = (() => {
  let pattern;
  try {
    pattern = (typeof localStorage !== 'undefined' && localStorage.debug) || '';
  } catch(e) { pattern = ''; }
  return (ns) => {
    if (!pattern) return () => {};
    const re = new RegExp('^' + pattern.replace(/\*/g, '.*?') + '$');
    if (!re.test(ns)) return () => {};
    return (...args) => console.debug('%c' + ns, 'color: #d97706', ...args);
  };
})();
```

### CJS Snippet (Shim Files)

Similar to the ESM version but uses `var` and `function` declarations for CJS compatibility.

## Inspecting Runtime State

### globalThis.__federation_shared_modules__

After `init()` runs, check what shared modules were resolved:

```js
console.log(Object.keys(globalThis.__federation_shared_modules__))
// ['react', 'react-dom', 'react-redux', ...]

console.log(globalThis.__federation_shared_modules__.react)
// { createElement, useState, useEffect, ... }

console.log(globalThis.__federation_shared_modules__['react-redux'])
// { Provider, useSelector, useDispatch, ReactReduxContext, ... }
```

### globalThis.__federation_shared__

The raw share scope (version-keyed):

```js
console.log(globalThis.__federation_shared__)
// { default: { react: { '19.2.4': { get: [Function] } }, ... } }
```

### Checking for Dual Instances

```js
// In the browser console, after loading a federated page:

// Check if React is the same instance
import('react').then(hostReact => {
  console.log('Same React?', 
    hostReact === globalThis.__federation_shared_modules__.react)
})
```

## Inspecting the Dep Optimizer

```bash
# View optimized files
ls node_modules/.vite/deps/

# Check what was optimized
cat node_modules/.vite/deps/_metadata.json | jq .

# Inspect react's optimized output
cat node_modules/.vite/deps/react.js

# Force re-optimization
rm -rf node_modules/.vite && npx vite --port 6001
```

## Network Tab Debugging

In the browser's Network tab, look for:

| Request | From | Purpose |
|---------|------|---------|
| `remoteEntry.js` | Host → Remote | Federation entry point |
| `@vite/client` | Host → Remote | Patched HMR client |
| `@react-refresh` | Host → Remote | Singleton wrapper |
| `__federation_expose_*.js` | Host → Remote | Expose stubs |
| `/src/pages/index.tsx` | Host → Remote | Real source file (via stub) |

Check the response of `@vite/client` to verify the base URL was patched:
```js
// Should show absolute URL, not "/"
const base = "http://localhost:6001/";
```
