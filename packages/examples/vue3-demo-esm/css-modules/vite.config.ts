import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import federation from '@hugs7/vite-plugin-federation'
import autoprefixer from 'autoprefixer'

// https://vitejs.dev/config/
export default defineConfig({
  css: {
    modules: {
      scopeBehaviour: 'local',
      localsConvention: 'camelCase'
    },
    postcss: { plugins: [autoprefixer()] }
  },
  plugins: [
    vue(),
    federation({
      name: 'css-modules',
      filename: 'remoteEntry.js',
      exposes: {
        './Button': './src/components/Button.vue'
      },
      shared: {
        vue:{
          generate:false
        }
      }
    })
  ],
  build: {
    target: 'esnext',
    cssCodeSplit: true,
    rolldownOptions: {
      output: {
        format: 'es',
        minifyInternalExports: false
      }
    }
  }
})
