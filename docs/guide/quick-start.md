# Quick Start

## Installation

```bash
npm install @hugs7/vite-plugin-federation --save-dev
```

## Remote Configuration (MFE)

The remote exposes modules that the host will consume:

```ts
// vite.config.ts (Remote - e.g., MFE at port 6001)
import { defineConfig } from 'vite'
import federation from '@hugs7/vite-plugin-federation'

export default defineConfig({
  plugins: [
    federation({
      name: 'interactiondashboard',
      filename: 'remoteEntry.js',
      exposes: {
        './pages': './src/pages/index.tsx'
      },
      shared: {
        react: {},
        'react-dom': {},
        'react-router': {},
        'react-redux': {},
        '@reduxjs/toolkit': {},
        zustand: {}
      }
    })
  ],
  server: {
    port: 6001,
    cors: true
  }
})
```

## Host Configuration (SPA)

The host consumes modules from remotes:

```ts
// vite.config.ts (Host - e.g., SPA at port 3000)
import { defineConfig } from 'vite'
import federation from '@hugs7/vite-plugin-federation'

export default defineConfig({
  plugins: [
    federation({
      remotes: {
        interactiondashboard: {
          external: 'http://localhost:6001/remoteEntry.js',
          format: 'esm',
          from: 'vite'
        }
      },
      shared: {
        react: {},
        'react-dom': {},
        'react-router': {},
        'react-redux': {},
        '@reduxjs/toolkit': {},
        zustand: {}
      }
    })
  ]
})
```

## Usage in Host Code

```tsx
// In the host application
const RemotePage = React.lazy(
  () => import('interactiondashboard/pages')
)

function App() {
  return (
    <Suspense fallback={<Loading />}>
      <RemotePage />
    </Suspense>
  )
}
```

The plugin's transform hook rewrites `import('interactiondashboard/pages')` to use the federation runtime, which loads `remoteEntry.js`, calls `init(shareScope)`, and then calls `get('./pages')`.

## Development Workflow

1. Start the remote dev server:
   ```bash
   cd mfe-project
   npx vite --port 6001
   ```

2. Start the host dev server:
   ```bash
   cd spa-project
   npx vite --port 3000
   ```

3. Navigate to `http://localhost:3000/your-route` — the host loads the remote's modules live from port 6001.

## Production Build

```bash
# Build the remote
cd mfe-project
npx vite build

# Build the host
cd spa-project
npx vite build
```

The remote generates a `remoteEntry.js` in its build output. The host's build rewrites remote imports to use `importShared()` for shared modules and dynamic imports for remote modules.
