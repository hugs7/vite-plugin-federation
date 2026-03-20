import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import federation from '@hugs7/vite-plugin-federation'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    vue(),
    federation({
      name: 'common-lib',
      filename: 'remoteEntry.js',
      exposes: {
        './CommonCounter': './src/components/CommonCounter.vue',
        './CommonHeader': './src/components/CommonHeader.vue'
      },
      shared: {
        vue: {
          requiredVersion: '^3.0.0',
          generate:false
        }
      },
    })
  ],
  build: {
    modulePreload: false,
    minify: false,
    cssCodeSplit: true,
    rolldownOptions: {
      output: {
        minifyInternalExports: false
      }
    }
  }
})
