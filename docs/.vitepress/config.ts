import { defineConfig } from 'vitepress'

export default defineConfig({
  title: '@hugs7/vite-plugin-federation',
  description: 'Module Federation for Vite 8+ with Rolldown',
  base: '/',
  themeConfig: {
    nav: [
      { text: 'Guide', link: '/guide/' },
      { text: 'Internals', link: '/internals/architecture' },
      { text: 'Debugging', link: '/debugging/' }
    ],
    sidebar: {
      '/guide/': [
        {
          text: 'Getting Started',
          items: [
            { text: 'Introduction', link: '/guide/' },
            { text: 'Quick Start', link: '/guide/quick-start' }
          ]
        }
      ],
      '/internals/': [
        {
          text: 'Architecture',
          items: [
            { text: 'Plugin Architecture', link: '/internals/architecture' },
            { text: 'Dev Mode Overview', link: '/internals/dev-mode' },
            { text: 'The Shared Module Problem', link: '/internals/shared-module-problem' },
            { text: 'CJS Shared Modules', link: '/internals/cjs-shared-modules' },
            { text: 'ESM Singleton Modules', link: '/internals/esm-singleton-modules' },
            { text: 'The Remote Entry', link: '/internals/remote-entry' },
            { text: 'The Host Side', link: '/internals/host-side' },
            { text: 'Production Mode', link: '/internals/production-mode' },
            { text: 'Rolldown Dep Optimizer', link: '/internals/rolldown-dep-optimizer' },
            { text: 'Server Middleware', link: '/internals/server-middleware' }
          ]
        }
      ],
      '/debugging/': [
        {
          text: 'Debugging',
          items: [
            { text: 'Debug Logging', link: '/debugging/' },
            { text: 'Common Issues', link: '/debugging/common-issues' }
          ]
        }
      ]
    },
    socialLinks: [
      { icon: 'github', link: 'https://github.com/nicolo-ribaudo/vite-plugin-federation' }
    ],
    search: {
      provider: 'local'
    },
    outline: {
      level: [2, 3]
    }
  }
})
