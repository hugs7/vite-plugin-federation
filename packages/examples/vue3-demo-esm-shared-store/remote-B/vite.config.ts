import {defineConfig} from 'vite'
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
                './Button': './src/components/Button.vue'
            },
            shared: {
                vue: {},
                pinia: {},
                myStore: {
                    packagePath: './src/store.js',
                    import: false,
                    generate: false
                }
            }
        })
    ],
    build: {
        assetsInlineLimit: 40960,
        minify: true,
        cssCodeSplit: false,
        sourcemap: true,
        rolldownOptions: {
            output: {
                minifyInternalExports: false
            }
        }
    }
})
