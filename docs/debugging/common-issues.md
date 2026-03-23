# Common Issues

## "Invalid hook call" / Hooks crash

**Symptom**: `Error: Invalid hook call. Hooks can only be called inside of the body of a function component.`

**Cause**: Two separate React instances. The host renders with its React, but the remote component calls hooks from a different React instance.

**Diagnosis**:
```js
// In browser console
console.log(globalThis.__federation_shared_modules__?.react)
// If undefined → init() didn't resolve react
// If present → check if remote is actually using it
```

**Fix**: Ensure shared modules are configured identically on both host and remote. Check that the shared module wrapper is intercepting imports (not the dep-optimized copy).

## "Could not find react-redux context value"

**Symptom**: `Error: could not find react-redux context value; please ensure the component is wrapped in a <Provider>`

**Cause**: Two separate `react-redux` instances creating different `ReactReduxContext` objects. The host's `<Provider>` uses one context, the remote's `useSelector` reads from another.

**Diagnosis**:
```js
// Check if react-redux was shared
console.log(globalThis.__federation_shared_modules__?.['react-redux'])
// Should have Provider, useSelector, ReactReduxContext, etc.
```

**Fix**: Ensure `react-redux` is in the shared config on both sides and that the virtual wrapper is working.

## "Cannot read properties of undefined (reading 'useRef')"

**Symptom**: `TypeError: Cannot read properties of undefined (reading 'useRef')` from a UI library component.

**Cause**: This was caused by the old `resolve.alias` + CJS shim approach. Rolldown generated anonymous `__esmMin` init wrappers, leaving `import_react` as `undefined`.

**Fix**: Use the current virtual wrapper approach (resolveId + load hooks), not resolve.alias. If you see this error, ensure no resolve.alias entries are redirecting react-related packages.

## Remote Entry 404

**Symptom**: `GET http://localhost:6001/remoteEntry.js 404`

**Cause**: The remote dev server isn't running, or the filename doesn't match.

**Fix**: 
1. Start the remote: `npx vite --port 6001`
2. Check `filename` in federation config matches the URL
3. Test directly: `curl http://localhost:6001/remoteEntry.js`

## CORS Errors

**Symptom**: `Access to script at 'http://localhost:6001/...' from origin 'http://localhost:3000' has been blocked by CORS policy`

**Cause**: The CORS middleware isn't running on the remote.

**Fix**: Ensure the remote uses this plugin (it adds CORS middleware automatically). You can also add `server.cors: true` to the remote's vite.config.

## HMR Not Working for Remote Components

**Symptom**: Changes to remote source files don't trigger updates in the host.

**Cause**: The `@vite/client` base URL wasn't patched correctly.

**Diagnosis**: In the Network tab, check the response of `/@vite/client` from the remote. The `base` variable should be an absolute URL (`http://localhost:6001/`), not `"/"`.

**Fix**: Ensure the CORS + @vite/client middleware is running. Check that the remote's port matches the configured port.

## Stale Dep Optimizer Cache

**Symptom**: Changes to federation config don't take effect. Old behavior persists.

**Fix**:
```bash
rm -rf node_modules/.vite
npx vite --port 6001
```

Always clear the dep optimizer cache after changing federation or shared module configuration.

## Top-Level Await (TLA) Deadlock in Production

**Symptom**: Production build hangs or modules fail to load. Browser shows pending module loads that never resolve.

**Cause**: `importShared()` uses `await` (TLA). If a shared module's own files are transformed to use `importShared()`, they import themselves — a deadlock.

**How the plugin prevents this**:
- Host-only builds: skip ALL node_modules (no TLA in vendor chunks)
- Remote builds: skip files belonging to the shared module's own package
- The federation runtime is emitted as a separate chunk to avoid circular static imports

If you see TLA issues, check that `prodRemotePlugin`'s transform is correctly skipping shared module sources.

## Testing Workflow

When debugging federation issues:

```bash
# 1. Build the plugin
cd /path/to/vite-plugin-federation
pnpm build

# 2. Clear caches and start the remote
cd /path/to/mfe
rm -rf node_modules/.vite
npx vite --port 6001

# 3. Start the host
cd /path/to/spa
rm -rf node_modules/.vite
npx vite --port 3000

# 4. Navigate to the federated route
# e.g., http://localhost:3000/interactiondashboard
```

Enable debug logging before navigating:
```js
localStorage.debug = 'federation:*'
```
