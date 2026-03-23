# The Shared Module Problem

This is the core problem that module federation must solve. Understanding it is essential for debugging federation issues.

## The Problem

When a host app loads a remote's module, that module has its own `import` statements — for `react`, `react-dom`, `react-redux`, etc. Without intervention, each of these imports resolves to the **remote's own copy** of the library, not the host's copy.

This creates **two separate instances** of each library in the browser:

```
Host (localhost:3000)              Remote (localhost:6001)
┌──────────────────┐              ┌──────────────────┐
│  react@19.2.4    │              │  react@19.2.4    │ ← Different instance!
│  (Host's copy)   │              │  (Remote's copy) │
│                  │              │                  │
│  ReactDOM.render │              │  useState()      │ ← Uses remote's React
│  with Host React │              │  useEffect()     │
└──────────────────┘              └──────────────────┘
```

## Why Dual React Instances Break Everything

### 1. Hooks Crash

React hooks (`useState`, `useEffect`, `useContext`, etc.) rely on an internal dispatcher stored as a module-level variable inside React. When a component is rendered by Host React but calls hooks from Remote React, the dispatcher is `null`:

```
Error: Invalid hook call. Hooks can only be called inside of the body
of a function component.
```

This happens because:
- The host's `ReactDOM.render()` sets up the dispatcher on **Host React's** internal `__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED`
- The remote component's `useState()` reads the dispatcher from **Remote React's** internals
- Remote React's dispatcher was never set → crash

### 2. ReactReduxContext is Not a Singleton

`react-redux` creates a `ReactReduxContext` via `React.createContext()` at module load time. With two instances:

```
Host's react-redux                    Remote's react-redux
┌─────────────────────┐              ┌─────────────────────┐
│ ReactReduxContext    │              │ ReactReduxContext    │
│ = createContext()    │              │ = createContext()    │ ← Different object!
│                      │              │                      │
│ <Provider store={}>  │              │ useSelector()        │
│ uses Host context    │              │ reads Remote context │
│                      │              │ → context is empty!  │
└─────────────────────┘              └─────────────────────┘
```

The host wraps the app in `<Provider store={store}>`, which provides the store via **Host's** `ReactReduxContext`. But the remote component calls `useSelector()` which reads from **Remote's** `ReactReduxContext` — which has no provider above it.

```
Error: could not find react-redux context value; please ensure the
component is wrapped in a <Provider>
```

### 3. Other Singleton Libraries

The same problem applies to any library that maintains module-level state:
- **zustand** — stores are module-level singletons
- **react-router** — router context must be shared
- **@reduxjs/toolkit** — relies on react-redux's context

## The Solution: Shared Modules

The federation protocol solves this with the **share scope**:

1. The host provides factories for each shared module in `init(shareScope)`
2. The remote resolves these factories and stores the host's module instances
3. When remote code imports a shared module, it gets the **host's copy** instead of its own

```
Host (localhost:3000)              Remote (localhost:6001)
┌──────────────────┐              ┌──────────────────┐
│  react@19.2.4    │──────────────│→ globalThis      │
│  (Single copy)   │   init()     │  .__federation_  │
│                  │              │  shared_modules__ │
│                  │              │  .react = Host's  │
│  react-redux     │──────────────│  .react-redux =   │
│  (Single copy)   │              │    Host's copy    │
└──────────────────┘              └──────────────────┘
```

Now all components — whether from the host or remote — use the same React instance, the same ReactReduxContext, and the same store.

## CJS vs ESM: Different Strategies

The challenge is that different shared modules have different module formats, and Vite's Rolldown dep optimizer handles them differently:

| Module | Format | Dep Optimizer Behavior | Federation Strategy |
|--------|--------|----------------------|-------------------|
| `react` | CJS | Single `require_react()` factory shared by all consumers | Virtual wrapper with `globalThis` check |
| `react-dom` | CJS | Single `require_react_dom()` factory | Virtual wrapper with `globalThis` check |
| `react-redux` | ESM | Shared via chunks, entry is a re-export | Virtual wrapper with `globalThis` check |
| `react-router` | ESM | Shared via chunks | Virtual wrapper with `globalThis` check |
| `zustand` | ESM | Shared via chunks | Virtual wrapper with `globalThis` check |

See [CJS Shared Modules](/internals/cjs-shared-modules) and [ESM Singleton Modules](/internals/esm-singleton-modules) for the implementation details of each strategy.
