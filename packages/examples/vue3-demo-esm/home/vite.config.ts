import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import federation from '@hugs7/vite-plugin-federation'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    vue(),
    federation({
      name: 'home',
      filename: 'remoteEntry.js',
      exposes: {
        './Content': './src/components/Content.vue',
        './Button': './src/components/Button.js',
        './Images': './src/components/Images.vue',
        './UnusedButton': './src/components/UnusedButton.vue'
      },
      shared: {
        vue:{
          generate:false,
          modulePreload: true,
        },
        pinia:{
          generate:false,
          modulePreload: true,
        },
        // This is to test if the custom library can be SHARED, there is no real point
        // myStore:{
        //   packagePath:'./src/store.js'
        // }
      }
    })
  ],
  build: {
    assetsInlineLimit: 40960,
    minify: true,
    cssCodeSplit: false,
    sourcemap:true,
    rolldownOptions: {
      output: {
        minifyInternalExports: false
      }
    }
  }
})
