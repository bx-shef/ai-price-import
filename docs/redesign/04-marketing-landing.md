# Маркетинг и лендинг (редизайн procure-ai)

> Last reviewed: 2026-07-07

План маркетинговой части: публичный лендинг + промо/cross-sell + аналитика. Подход и почти все
компоненты переносимы 1-в-1 из эталона `client-bank-alfa-by` (который сам портирован с
`offer.bx-shef.by`, репо `bx-shef/Lp`). Здесь — что берём, как это ложится на procure-ai и что
меняется под наш домен (закупки/прайсы вместо выписок).

Зависит от решения **Q6** (нужен ли публичный лендинг или только in-portal). Ниже — план на случай «да».

---

## 1. Что берём из эталона (переносимо почти как есть)

| Актив | Файл в эталоне | Что делает |
|---|---|---|
| Тёмная бренд-оболочка | `app/layouts/landing.vue` | `B24Header`/`B24Footer`, форс-dark только для `/` через `data-force-dark`, in-portal не трогает |
| Палитра/токены | `app/assets/css/main.css` (`.landing-shell`) | vibecode-фон `#030022` + радиальное сияние, cyan-акцент, self-hosted шрифты |
| Централизованный контент | `app/utils/landing.ts` | тексты + SEO из одного источника (тесты); title/description не дрейфуют |
| Анимация hero | `app/components/HeroGraph.vue` | canvas: внешние узлы шлют импульсы в центральный хаб; perf-hardened, reduced-motion |
| Glow за курсором | `app/composables/useCardGlow.ts` + `[data-glow-card]` | подсветка карточек |
| Встроенная форма Б24 | `BriefForm.vue` + `app/utils/b24Form.ts` + `public/b24-form.html` | CRM-форма в same-origin iframe со **своим** form-scoped CSP (строгий CSP страницы не ослабляется) |
| Визитка | `BusinessCardModal.vue` + `HoldRevealQr.vue` | фото, QR (десктоп + мобильный hold-to-reveal), vCard, «назначить созвон» |
| Промо/cross-sell | `CustomDevCard.vue`, `AppInBitrixCard.vue` | «нужна доработка под ваш процесс», карточка листинга Маркета |
| Аналитика | Яндекс.Метрика (инлайн в `nuxt.config.ts`) + `useMetrikaGoal` | **самозаглушается в iframe** (in-portal не пишет session-replay CRM); цели через `reachGoal` |
| OG-картинка | `scripts/make-og.mjs` (`pnpm og`) | 1200×630 из HTML-шаблона через headless Chromium, коммитим статикой |

## 2. Что меняем под procure-ai

- **Контент `landing.ts`** — переписать под домен закупок: боль «менеджер вбивает накладные руками» →
  результат «загрузил файл — сделка в „Закупках“ создалась сама». Шаги «Как это работает» (3):
  загрузка файла → AI распознаёт поставщика/договор/позиции/цены → сделка в Bitrix24. «Почему мы»:
  распознавание PDF/сканов/фото/XLSX/DOCX, УНП/договор/артикул, безопасность (изолированный MCP,
  недоверенный документ), метрики экономии времени.
- **Форматы/интеграции** (tech-row) — PDF, скан/фото (OCR), XLSX/XLS, DOCX; таргет — Bitrix24
  (воронка «Закупки»), на горизонте 1С:УТ.
- **HeroGraph** — перекрасить/переименовать узлы: Накладная, Прайс, PDF, Скан, XLSX, Поставщик,
  Договор, Каталог → импульсы в центральный хаб **Bitrix24 / Сделка «Закупки»**. Параметризация
  `rgb`/`photo` уже заложена в эталоне.
- **OG/бренд** — свой заголовок/сабтайтл и, при необходимости, партнёрский бейдж (ИП/интегратор).
- **Промо `CustomDevCard`** — ссылка на бриф/партнёра (как в экосистеме `bx-shef`), тексты вшиты.

## 3. Технические инварианты (из эталона, не ломать)

- **Форс-dark только на `/`** через `htmlAttrs data-force-dark` + `.landing-shell`; in-portal
  страницы (`/app`,`/import`,`/install`,`/metrics`) остаются light/dark-auto. FOUC-гард — `theme-init`
  в `app.vue` до первого рендера.
- **CSP строгий**, без `script-src 'unsafe-inline'`: инлайн-скрипты (theme-init, `__NUXT__.config`,
  сниппет Метрики) разрешаются по sha256, которые `scripts/csp-hashes.mjs` считает на сборке.
  `frame-ancestors`/`connect-src` разрешают облачные домены Б24 + `mc.yandex.ru`.
- **Форма Б24 — только через `public/b24-form.html`** с form-scoped CSP (`location = /b24-form.html`),
  чтобы официальный загрузчик работал, а строгий CSP страницы не ослаблялся. URL строит чистый
  `b24Form.ts` (allowlist хостов + валидация id/secret; тесты). Пустой конфиг ⇒ слот-плейсхолдер.
- **Метрика в iframe отключается** (`window.self !== window.top`) — иначе webvisor писал бы
  session-replay CRM клиента, а цели пачкали бы аналитику лендинга портальным трафиком.
- **Контент централизован** в `landing.ts` и оттуда же кормит SEO — единственный источник правды.

## 4. Definition of Done (визуальная верификация)

После любой правки UI/лендинга — `pnpm generate && pnpm screenshot`, смотреть `screenshots/`
(mobile/desktop × light/dark) до того, как считать готовым. OG перегенерировать при смене
заголовка/брендинга (`pnpm og`).

## 5. Порядок работ (этап 3 карты проекта)

1. Порт `landing.vue` + `main.css` (`.landing-shell` токены) + шрифты.
2. Порт `landing.ts` → переписать контент под закупки; подключить SEO в `app.vue`.
3. Порт `HeroGraph.vue` → перекрасить/переименовать узлы.
4. Порт `BriefForm.vue` + `b24Form.ts` + `public/b24-form.html` + nginx form-scoped CSP.
5. Порт промо (`CustomDevCard`, `AppInBitrixCard`) + визитка (если нужна).
6. Метрика (`nuxt.config.ts` инлайн + `useMetrikaGoal`) + CSP-hashing.
7. OG-генерация (`make-og.mjs`) под свой бренд.
8. Скриншоты, пиксель-ревью, обновить `Last reviewed`.
