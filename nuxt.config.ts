// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({

  modules: [
    '@nuxt/eslint',
    '@vueuse/nuxt',
    '@bitrix24/b24ui-nuxt',
    '@bitrix24/b24jssdk-nuxt'
  ],

  app: {
    head: {
      // Global favicon (SVG — modern browsers; the landing + in-portal pages inherit it).
      link: [{ rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' }]
    }
  },

  css: ['~/assets/css/main.css'],

  runtimeConfig: {
    // Server secrets are read from process.env directly (bare names: DATABASE_URL,
    // REDIS_URL, B24_CLIENT_ID/SECRET, B24_APPLICATION_TOKEN, B24_TOKEN_ENC_KEY) — NOT
    // via runtimeConfig, because Nuxt only overrides runtimeConfig from NUXT_-prefixed
    // env, while the deploy (.env / env_file) uses the bare names. Declaring them here
    // would create dead '' keys that silently shadow the real env (500s / inert gates).
    public: {
      // Client-exposed; correctly overridden by NUXT_PUBLIC_-prefixed env at runtime.
      siteUrl: '',
      commitSha: 'dev',
      // Yandex.Metrika id (empty → useMetrikaGoal no-ops; landing analytics optional).
      metrikaId: ''
    }
  },
  future: { compatibilityVersion: 4 },
  compatibilityDate: '2025-01-15',

  nitro: {
    prerender: {
      // Landing + in-portal + operator pages (static shells; data/actions via /api).
      // /install is the B24 Marketplace install handler — must be prerendered so a HEAD
      // request returns 200 for B24's URL validation.
      routes: ['/', '/app', '/import', '/settings', '/login', '/queues', '/install']
    }
  },

  eslint: {
    config: {
      stylistic: {
        commaDangle: 'never',
        braceStyle: '1tbs'
      }
    }
  }
})
