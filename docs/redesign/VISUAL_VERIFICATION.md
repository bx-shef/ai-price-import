# Визуальная верификация (Definition of Done)

> Last reviewed: 2026-07-19

> **ВАЖНО:** после любой правки UI/CSS/вёрстки снять скриншот результата и
> **посмотреть на пиксели** до того, как считать задачу выполненной — не доверять
> «собралось без ошибок».

## Как снять скриншоты

```bash
pnpm generate && pnpm screenshot      # все пререндеренные роуты
pnpm screenshot /app /import          # только эти роуты
```

Смотреть `screenshots/` — по файлу на **роут × вьюпорт × тему**:
`<slug>.<mobile|desktop>.<light|dark>.png`.

- **Роуты** (дефолт = `nitro.prerender.routes`): `/`, `/app`, `/import`, `/settings`,
  `/login`, `/queues`, `/install`.
- **Вьюпорты**: `mobile` 375×812, `desktop` 1280×900.
- **Темы**: `light`, `dark` (через `prefers-color-scheme` в контексте браузера).

Скрипт — `scripts/screenshot.mjs`: поднимает статику из `.output/public` на эфемерном
порту и снимает каждую комбинацию полностраничным скриншотом. Браузер — предустановленный
Chromium окружения (`PLAYWRIGHT_BROWSERS_PATH`), через `playwright-core` (без докачки).
`screenshots/` — в `.gitignore` (скрин реального портала может содержать данные CRM).

## Чек-лист

- [ ] Мобайл и десктоп: нет горизонтального скролла, ничего не обрезано/не наезжает.
- [ ] Тап-таргеты (кнопки/ссылки) не слипаются, читаемы на 375px.
- [ ] Пустые состояния и баннеры статуса выглядят осмысленно.
- [ ] In-portal страницы (`/app`,`/settings`,`/import`) рендерятся и вне фрейма
      (`useB24().init()` — no-op без портала) — проверяем именно standalone-скрин.

## Тема (light/dark)

In-portal страницы (`/app`,`/settings`,`/import`,`/login`,`/queues`,`/metrics`) —
**light/dark-auto**: заведён `app/app.config.ts` (нативный `colorMode` b24ui: `colorMode: true`,
`colorModeInitialValue: 'auto'`) + FOUC-гард `theme-init` в `app.vue` (ставит класс `.dark`/`.light`
до первого кадра по сохранённому/OS `prefers-color-scheme`), а `clear.vue` обёрнут в `<B24App>` и
красится семантическими токенами `--ui-color-*` (не сырыми Tailwind-грэями). В реальном портале Б24
тема приходит из фрейма (OS/портал), standalone — по `prefers-color-scheme`. Лендинг (`/`) пинит свою
тёмную оболочку через `htmlAttrs data-force-dark` (её `theme-init` уважает).

> ⚠ **Флейки скриншотов тёмной темы.** Иногда `pnpm screenshot` ловит момент до применения `.dark`
> (гонка `networkidle` × гидрации b24ui colorMode) → `*.dark.png` выходит идентичным `*.light.png`.
> Проверка: `md5sum <slug>.desktop.{light,dark}.png` — если одинаковые, перезапустить `pnpm screenshot
> /<route>` (одиночный роут стабильно рендерит тёмную). Это артефакт харнесса, не баг страницы.
