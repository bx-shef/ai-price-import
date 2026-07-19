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
      // Bitrix24 Market listing code override for the «оцените приложение» modal. Empty → the
      // composable falls back to the app's real slug (LANDING_MARKET_CODE in landing.ts). Set
      // NUXT_PUBLIC_B24_MARKET_CODE only to point at a different listing (e.g. a re-publish).
      b24MarketCode: '',
      // Yandex.Metrika id (empty → useMetrikaGoal no-ops; landing analytics optional).
      metrikaId: '',
      // Embedded Bitrix24 CRM web-form (BriefForm) — client & partner enquiries.
      // Defaults = the shared bx-shef brief form (public embed token, same as client-bank);
      // override via NUXT_PUBLIC_B24_FORM_* to point at a product-specific form.
      b24FormId: process.env.NUXT_PUBLIC_B24_FORM_ID || '1',
      b24FormSecret: process.env.NUXT_PUBLIC_B24_FORM_SECRET || '3c735r',
      b24FormScriptUrl: process.env.NUXT_PUBLIC_B24_FORM_SCRIPT_URL || 'https://cdn-ru.bitrix24.by/b37817748/crm/form/loader_1.js'
    }
  },
  future: { compatibilityVersion: 4 },
  compatibilityDate: '2025-01-15',

  nitro: {
    prerender: {
      // Landing + in-portal + operator pages (static shells; data/actions via /api).
      // /install is the B24 Marketplace install handler — must be prerendered so a HEAD
      // request returns 200 for B24's URL validation.
      routes: ['/', '/app', '/import', '/settings', '/metrics', '/login', '/queues', '/install']
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
