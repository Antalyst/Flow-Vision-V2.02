import tailwindcss from '@tailwindcss/vite'

// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  devtools: { enabled: true },

  // Full-stack Nuxt: pages are server-rendered and the API lives in server/ (Nitro).
  ssr: true,

  modules: ['@pinia/nuxt'],

  css: ['~/assets/styles/index.css'],

  // Old CLIENT-only URLs; uploading and the document list are shared pages now.
  routeRules: {
    '/client/documents': { redirect: '/documents' },
    '/client/submit': { redirect: '/documents/new' },
    // The scanner is shared by messengers (pickup) and office staff (receiving) now.
    '/liaison/qr-scanner': { redirect: '/scan' },
  },

  vite: {
    plugins: [tailwindcss()],
  },

  nitro: {
    // Native WebSockets for realtime (server/routes/_ws.ts)
    experimental: { websocket: true },
  },

  runtimeConfig: {
    public: {
      // Shows the seeded demo accounts on the login page. Override with NUXT_PUBLIC_SHOW_DEMO_ACCOUNTS=false.
      showDemoAccounts: true,
    },
  },

  app: {
    head: {
      title: 'FlowVision',
      htmlAttrs: { lang: 'en' },
      meta: [
        { name: 'viewport', content: 'width=device-width, initial-scale=1, viewport-fit=cover' },
        { name: 'description', content: 'Document tracking and workflow management for Bago City LGU' },
        { name: 'theme-color', content: '#F6F5F1' },
      ],
    },
  },
})
