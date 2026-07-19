# Оценка приложения в Маркете («оцените приложение»)

> Last reviewed: 2026-07-19

Ненавязчивый in-portal попап, который просит пользователя поставить оценку/отзыв приложению в
Маркете Bitrix24. Идея (из подсказки Маркета): показать своё модальное окно и по кнопке открыть
детальную страницу приложения на витрине через `BX24.openPath` — там пользователь и ставит оценку.
Реализовано **переиспользуемым компонентом** `AppRatingModal.vue`, а вся логика «показывать/не
показывать» — **на сервере**, рядом с авторизацией портала.

## Как это работает

**Когда показываем.** Только когда польза очевидна — после **успешного импорта** (на `/app`
триггер `hasSuccessfulImport`: есть хотя бы один документ в статусе «готово» или созданная в CRM
сущность). Компонент лишь реагирует на решение сервера.

**Где хранится факт.** Таблица `portal_app_rating` (одна строка на портал, ключ `member_id` — как у
`portal_tokens`, «рядом с авторизацией»):

| столбец | смысл |
|---|---|
| `prompted_at` | когда попап последний раз **показали** (троттлинг) |
| `opened_at` | когда пользователь нажал «Оценить» и мы **открыли** детальную страницу Маркета |
| `reviewed` | **вручную** ставится `true`, когда подтверждён реальный отзыв → больше не показываем |

**Решение о показе** (чистая функция `shouldPrompt`, `server/utils/appRatingPolicy.ts`):

1. `reviewed = true` → **никогда** не показываем (отзыв подтверждён).
2. `opened_at` задан → **не показываем** (пользователь уже кликнул; ждём ручной проверки).
3. иначе → показываем, но **не чаще одного раза в `RATING_REPROMPT_DAYS` (4 дня)** — по `prompted_at`.

Итог: попап всплывает «раз в несколько дней», а не на каждый вход.

**Поток:**

```
успешный импорт → GET /api/app-rating {show}
   show=true → рисуем модалку → POST {action:'prompted'}   (троттлит следующий показ на 4 дня)
      «Оценить»   → POST {action:'opened'} + frame.slider.openPath('/marketplace/detail/<code>/')
      «Не сейчас» → просто скрываем (prompted_at уже проставлен)
```

`GET /api/app-rating` — **без сайд-эффектов** (только читает), показ фиксирует клиент через POST.
Оба роута аутентифицированы **фрейм-токеном** (`resolveFrameMember` → `member_id` из проверенного
домена; клиентский `member_id` не в доверии). Вне портала / без `DATABASE_URL` — инертно (`show:false`).

## Управление из UI оператора (не через SQL)

Отзыв в Маркете подтверждается **вручную** (у REST нет надёжного «этот портал оставил отзыв»), но
владелец **не пишет SQL** — управляет со страницы оператора `/queues`, карточка **«Оценки
приложения»** (рядом с «Авторизацией порталов», тот же паттерн, что кнопка reauth):

- по каждому установленному порталу видно состояние: `ещё не показывался` / `показан` /
  **`открыл Маркет — проверьте отзыв`** (наверху списка) / `отзыв подтверждён`, + даты показа/клика;
- через ~`RATING_REPROMPT_DAYS` после клика проверяем витрину и жмём:
  - **«Отзыв оставлен»** → `reviewed=true` (терминально, попап больше не показываем);
  - **«Сбросить»** → снимаем `opened_at`/`prompted_at` (попап покажется снова при следующем импорте).

Роуты (сессия оператора, cookie `OP_COOKIE`, как у `/api/ops/tokens`), только несекретные поля:

- `GET /api/ops/app-rating` → `{ portals: [{ memberId, domain, state, promptedAtMs, openedAtMs }] }`
  (`listRatingStatus` LEFT JOIN `portal_tokens` → видны и порталы без строки; `buildRatingStatuses`
  сортирует «требует внимания» первыми).
- `POST /api/ops/app-rating { memberId, action: 'reviewed' | 'reset' }` (`handleAppRatingOp` →
  `markReviewed` / `clearOpened`; валидация hex-`member_id`).

Прямой SQL остаётся запасным путём (те же функции `markReviewed` / `clearOpened`):

```sql
UPDATE portal_app_rating SET reviewed = true, updated_at = now() WHERE member_id = '<member_id>';
UPDATE portal_app_rating SET opened_at = NULL, prompted_at = NULL, updated_at = now()
  WHERE member_id = '<member_id>' AND reviewed = false;
```

## Настройка

- Код листинга по умолчанию — реальный слаг приложения `shef.priceimport` (единый источник —
  `LANDING_MARKET_CODE` в `app/utils/landing.ts`, оттуда же строится публичный URL витрины). Путь к
  детальной странице строит `marketDetailPath(code)` (`app/config/b24.ts`).
- `NUXT_PUBLIC_B24_MARKET_CODE` — **override** кода (напр. при перепубликации на другой листинг).
  Пусто → используется слаг по умолчанию, попап **включён**.

## Визуальная подсказка (гиф/видео)

В модалке — короткая зацикленная **гифка** `public/app-rating-demo.gif` (320×204, ~0.5 МБ, 47
кадров, ~7 c), которая показывает, как именно ставится оценка в интерфейсе Маркета. Она **лениво**
подгружается (`loading="lazy"` + `unmount-on-hide` у модалки) — не тянется, пока попап не открыли,
и не утяжеляет лендинг/`/app`.

Исходник (`rating_demo_1.gif`, 3.5 МБ) сжат Pillow'ом: ресайз до 320px, каждый 3-й кадр, палитра
64 цвета. **Дальнейшая оптимизация (по желанию):** заменить гиф на немой зацикленный `<video>`
(`webm`/`mp4`) — при том же качестве это ~в 3–5 раз меньше и плавнее; нужен `ffmpeg` на сборке.
Тогда `<img>` в `AppRatingModal.vue` меняется на `<video autoplay muted loop playsinline>`.

## Файлы

- `server/db/schema.ts` — таблица `portal_app_rating` (+ очистка при uninstall в `tokenStore.deletePortal`).
- `server/utils/appRatingPolicy.ts` — чистое решение `shouldPrompt` (+ тесты).
- `server/utils/appRatingStore.ts` — состояние через инъекцию `QueryFn` (+ тесты).
- `server/api/app-rating.get.ts` / `.post.ts` — фрейм-токен-роуты (read / prompted+opened).
- `server/utils/appRatingStatus.ts` + `appRatingOpsHandler.ts` — чистые ядра ops-управления (+ тесты).
- `server/api/ops/app-rating.get.ts` / `.post.ts` — ops-роуты (сессия оператора) для карточки на `/queues`.
- `app/composables/useAppRating.ts` — клиент (check/markPrompted/openMarket через `slider.openPath`).
- `app/components/AppRatingModal.vue` — **переиспользуемый** попап на `B24Modal`.
- `app/pages/queues.vue` — карточка «Оценки приложения» (управление вручную).
- `app/config/b24.ts` — `marketDetailPath`; `nuxt.config.ts` — `public.b24MarketCode`.
