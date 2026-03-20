import { defineConfig } from 'vite'

// https://vitejs.dev/config/
export default defineConfig({
  build: {
    lib: {
      entry: ['./src/index.ts', 'src/utils/semver/satisfy.ts'],
      formats: ['es', 'cjs']
    },
    target: 'node22',
    minify: false,
    rolldownOptions: {
      external: ['fs', 'path', 'crypto', 'magic-string', 'url', 'module', 'node:fs', 'node:path', 'node:crypto', 'node:url', 'node:module'],
      output: {
        minifyInternalExports: false
      }
    }
  }
})
