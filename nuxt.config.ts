// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({

  modules: [
    '@nuxt/eslint',
    '@vueuse/nuxt',
    '@bitrix24/b24ui-nuxt',
    '@bitrix24/b24jssdk-nuxt'
  ],

  css: ['~/assets/css/main.css'],

  runtimeConfig: {
    // server-only (never exposed to client)
    databaseUrl: '',
    redisUrl: '',
    b24ClientId: '',
    b24ClientSecret: '',
    b24ApplicationToken: '',
    b24TokenEncKey: '',
    public: {
      siteUrl: '',
      commitSha: 'dev'
    }
  },
  future: { compatibilityVersion: 4 },
  compatibilityDate: '2025-01-15',

  nitro: {
    prerender: {
      // Only the pages that exist today; in-portal/operator pages land in later этапы.
      routes: ['/']
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
