// https://nuxt.com/docs/api/configuration/nuxt-config
import { readFileSync } from 'node:fs'
import { parseLegalEdition } from './app/utils/legalEdition'
import { allArchiveRoutes } from './app/utils/legalArchive'

// Редакции документов приложения читаются ИЗ САМИХ ДОКУМЕНТОВ на сборке (#414) и уезжают в
// runtimeConfig — оттуда их берёт запись о согласии.
//
// ⚠ Почему не `?raw`-импорт, как на страницах: rollup Nitro суффикс `?raw` не разбирает и падает на
// сборке («ENOENT ... privacy-policy.md?raw») — проверено. Чтение здесь даёт то же самое свойство,
// ради которого весь приём и заведён: второй копии дат в коде нет, источник один — сам документ.
// ⚠ Падение при отсутствии даты — намеренное (см. parseLegalEdition): сломанный документ обязан
// ронять сборку, а не уезжать в запись о согласии пустым полем.
const LEGAL_EDITIONS = {
  eula: parseLegalEdition(readFileSync(new URL('./docs/eula.md', import.meta.url), 'utf8'), 'docs/eula.md'),
  privacy: parseLegalEdition(readFileSync(new URL('./docs/privacy-policy.md', import.meta.url), 'utf8'), 'docs/privacy-policy.md')
}

// Яндекс Метрика — ТОЛЬКО лендинг, и с тремя ограничениями (#297, решение владельца 2026-08-04:
// счётчик нужен, чтобы вести рекламу и видеть клики).
//
//   1. `window.self === window.top` — счётчик не поднимается ВНУТРИ ФРЕЙМА. In-portal экраны
//      (`/app`, `/settings`, `/metrics`, `/import`, `/install`) живут в iframe портала: там счётчик
//      писал бы работу сотрудника в чужой CRM, а цели лендинга смешивались бы с портальным
//      трафиком. Тот же приём, что в соседнем client-bank.
//   2. `webvisor: false` — запись сессии и содержимого форм ВЫКЛЮЧЕНА, и это не «пока не включили».
//      На лендинге стоит демо-разбор: посетитель грузит туда накладную, и Вебвизор записал бы её
//      содержимое на сторону Яндекса. Политика прямо обещает обратное.
//   3. Идентификатор берётся из env и чистится от нецифрового — пустой ⇒ счётчика нет вовсе
//      (dev, staging, self-hosted у клиента): у аналитики издателя нет причин работать на чужом
//      сервере.
//
// clickmap/trackLinks оставлены — это карта кликов и внешние переходы, ради которых счётчик и
// ставится; содержимого страницы они не записывают.
const metrikaId = String(process.env.NUXT_PUBLIC_METRIKA_ID || '').replace(/\D/g, '')
// ⚠ Счётчик БОЛЬШЕ НЕ СТАРТУЕТ САМ (#404). Сниппет объявляет функцию `__ymStart` и зовёт её
// только при уже сохранённом согласии; иначе её зовёт кнопка баннера — тогда счётчик поднимается
// без перезагрузки страницы. Проверка кадра (`window.self===window.top`) стоит ВНУТРИ функции, то
// есть по-прежнему до создания тега: во фрейме портала счётчик не поднимется, даже если согласие
// в этом браузере когда-то дали на лендинге.
// ⚠ Чтение согласия завёрнуто в try: `localStorage` бросает в приватном режиме части браузеров, и
// исключение здесь снесло бы весь инлайн-скрипт вместе с ним — счётчик не заработал бы уже никогда.
// ⚠ Проверка кадра написана в положительной форме и обёрткой: гард в тестах ищет её ПЕРЕД созданием
// тега, а отрицательная форма с ранним выходом читалась бы им хуже.
const metrikaSnippet = `window.__ymStart=function(){if(window.self===window.top){if(window.__ymUp){return;}window.__ymUp=1;(function(m,e,t,r,i,k,a){m[i]=m[i]||function(){(m[i].a=m[i].a||[]).push(arguments)};m[i].l=1*new Date();for(var j=0;j<e.scripts.length;j++){if(e.scripts[j].src===r){return;}}k=e.createElement(t),a=e.getElementsByTagName(t)[0],k.async=1,k.src=r,a.parentNode.insertBefore(k,a)})(window,document,'script','https://mc.yandex.ru/metrika/tag.js?id=${metrikaId}','ym');ym(${metrikaId},'init',{ssr:true,webvisor:false,clickmap:true,accurateTrackBounce:true,trackLinks:true});}};try{var c=JSON.parse(localStorage.getItem('cookie-consent')||'null');if(c&&c.choice==='accepted'&&c.version===1){window.__ymStart();}}catch(e){}`

export default defineNuxtConfig({

  modules: [
    '@nuxt/eslint',
    '@vueuse/nuxt',
    '@bitrix24/b24ui-nuxt',
    '@bitrix24/b24jssdk-nuxt'
  ],

  app: {
    head: {
      // Favicon bundle (#298) — ONE place for every page (landing + in-portal inherit it).
      // Master is public/favicon.svg; the rest is generated from it by `pnpm icons`.
      // Order matters: browsers pick the FIRST usable match, so SVG (crisp at any size)
      // goes first, .ico stays as the legacy fallback, PNG sizes serve pinned-tab/pwa UIs.
      // Счётчик Метрики (см. metrikaSnippet выше): инлайн, с самозаглушением во фрейме. Пустой
      // идентификатор ⇒ ни тега, ни noscript-пикселя.
      script: metrikaId ? [{ innerHTML: metrikaSnippet }] : [],
      link: [
        { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' },
        { rel: 'icon', type: 'image/png', sizes: '32x32', href: '/favicon-32.png' },
        { rel: 'icon', type: 'image/png', sizes: '16x16', href: '/favicon-16.png' },
        { rel: 'icon', sizes: '16x16 32x32 48x48', href: '/favicon.ico' },
        { rel: 'apple-touch-icon', sizes: '180x180', href: '/apple-touch-icon.png' },
        { rel: 'manifest', href: '/site.webmanifest' }
      ]
    }
  },

  css: ['~/assets/css/main.css'],

  runtimeConfig: {
    // Редакции принятых документов (#414) — запекаются на сборке из docs/*.md (см. LEGAL_EDITIONS).
    legalEditions: LEGAL_EDITIONS,
    // Server secrets are read from process.env directly (bare names: DATABASE_URL,
    // REDIS_URL, B24_CLIENT_ID/SECRET, B24_APPLICATION_TOKEN, B24_TOKEN_ENC_KEY) — NOT
    // via runtimeConfig, because Nuxt only overrides runtimeConfig from NUXT_-prefixed
    // env, while the deploy (.env / env_file) uses the bare names. Declaring them here
    // would create dead '' keys that silently shadow the real env (500s / inert gates).
    public: {
      // Client-exposed; correctly overridden by NUXT_PUBLIC_-prefixed env at runtime.
      siteUrl: '',
      commitSha: 'dev',
      // Build date (YYYY-MM-DD) baked by the image build — the `<lastmod>` of /sitemap.xml. Empty
      // (local/dev build) → the element is omitted rather than filled with a wrong `now`.
      buildDate: '',
      // Bitrix24 Market listing code override for the «оцените приложение» modal. Empty → the
      // composable falls back to the app's real slug (LANDING_MARKET_CODE in landing.ts). Set
      // NUXT_PUBLIC_B24_MARKET_CODE only to point at a different listing (e.g. a re-publish).
      b24MarketCode: '',
      // Yandex.Metrika id (empty → счётчика нет и useMetrikaGoal no-op). Тот же источник, что у
      // сниппета выше, — иначе цели уходили бы в один счётчик, а тег грузился под другим.
      metrikaId,
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
      // `/eula` и `/privacy` — публичные юридические документы (#297): Маркет Bitrix24 требует
      // постоянные HTTPS-адреса, поэтому они пререндерятся и попадают в sitemap.
      // Архив редакций (#415) добавляется ИЗ РЕЕСТРА, а не переписыванием списка руками: новая
      // редакция иначе появлялась бы в архиве, но не пререндерилась — то есть ссылка из
      // договора вела бы в 404 ровно тогда, когда она понадобилась.
      routes: ['/', '/eula', '/privacy', '/site-terms', '/site-privacy', '/app', '/import', '/settings', '/metrics', '/login', '/queues', '/install', ...allArchiveRoutes()]
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
