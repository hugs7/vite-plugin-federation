---
layout: home
hero:
  name: '@hugs7/vite-plugin-federation'
  text: Module Federation for Vite 8+
  tagline: Share modules between independently deployed applications with Vite and Rolldown
  actions:
    - theme: brand
      text: Get Started
      link: /guide/
    - theme: alt
      text: Internals
      link: /internals/architecture
features:
  - title: Dev Mode Federation
    details: Full module federation support during development with HMR, shared module deduplication, and cross-origin serving.
  - title: Vite 8 + Rolldown
    details: Built for Vite 8's Rolldown-based dep optimizer. Handles CJS and ESM shared modules with different strategies.
  - title: React 19 Compatible
    details: Solves the dual React instance problem for React 19 (CJS-only) with dep-optimizer-aware transforms.
---
