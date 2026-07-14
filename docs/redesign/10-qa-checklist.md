# План проверок procure-ai

> Last reviewed: 2026-07-14

Этот документ — практический чек-лист ручных и автоматических проверок procure-ai по подсистемам. Пользоваться им так: начните с раздела «Быстрый старт (smoke)», убедитесь, что приложение вообще поднимается, затем идите по нужной подсистеме и прогоняйте строки таблицы (колонка «Метка» показывает, что уже покрыто vitest, а что требует ручного прогона, живого портала или LLM-ключа). Документ детализирует три уровня из [`07-testing.md`](07-testing.md): чистое ядро (unit, `pnpm test`), интеграция роутов/пайплайна (ручной прогон бэкенда) и сквозные проверки на живом портале Bitrix24. Каждая метка `[нужен живой портал]` / `[нужен LLM-ключ]` собрана отдельно в разделе «Что заблокировано и почему».

## Быстрый старт (smoke)

Минимальный набор «запустилось ли вообще» перед прогоном подсистемных проверок:

1. `pnpm check` — lint + typecheck + весь vitest зелёные (быстрый барьер регрессий).
2. `pnpm generate` — SSG-сборка проходит без ошибок; в `.output/public/index.html` есть тексты лендинга.
3. `pnpm dev` — dev-сервер поднимается на `http://localhost:3000`, лендинг `/` рендерится (тёмная оболочка, hero-граф, демо-блок).
4. `curl -s localhost:3000/api/health` → `200` с `{status:'ok', commit, commitUrl, time}` и без секретов.
5. Открыть `/import`, `/login`, `/queues` — страницы рендерятся (in-portal/служебные, layout `clear`); `/login` и `/queues` несут `noindex`.
6. `curl -F file=@public/demo/kp-ru.txt localhost:3000/api/demo/extract` → `200` с распознанным документом (демо-путь без LLM и без портала).
7. Логи старта бэкенда: `[db] schema ensured`, `[queue] started N pipeline workers` (или тихий no-op без Redis/БД), `[env] …` предупреждения без падения процесса.

## Проверки по подсистемам

### Демо на лендинге

Детерминированный экстрактор (КП/счёт/ТТН, ru/be/kk) без LLM и без Bitrix24. Ядро — `app/utils/demoExtract.ts`; backend — `server/api/demo/extract.post.ts`; UI — `app/components/DemoTryout.vue`; примеры — `public/demo/*.txt` (9 шт.).

| Проверка | Действие | Ожидаемо | Метка |
|---|---|---|---|
| Полный прогон демо-тестов | `pnpm test:unit` (`demoExtract`/`demoRateLimit`/`demoUpload`) | Все зелёные | [авто] |
| Парсинг 9 примеров | `tests/demoExtract.test.ts` | Для каждого языка верные `docType`/`language`/`supplier.name`/`taxIdKind`/`taxId`, число `items`, суммы `totals` (kp-ru: 4 позиции, УНП 191234567, total 9796.8, vat 1632.8, warnings=0) | [авто] |
| `parseNum` локализованных чисел | `tests/demoExtract.test.ts` | `1 850,00`/`1850.00`/`1 850.00`→1850; `1.234.567,89`≈1234567.89; `''`/`—`→undefined | [авто] |
| Бухгалтерские минусы | `tests/demoExtract.test.ts` | `(330,00)`→-330; `1 234,56-`→-1234.56; `-42`→-42 | [авто] |
| Rate-limiter 3/10мин | `tests/demoRateLimit.test.ts` | 3 разрешены → 4-й `allowed:false` + `retryAfterMs`; слот освобождается по окну; ключи независимы; `sweep` чистит истёкшие | [авто] |
| `clientKey` из XFF | `tests/demoRateLimit.test.ts` | Берётся последний хоп XFF; фолбэк socket → `unknown` | [авто] |
| Валидация загрузки | `tests/demoUpload.test.ts` | `ext` нормализует регистр/путь/dotfile; пустой→400, >1МБ→413, pdf/xlsx→415; UTF-8 + фолбэк 1251 | [авто] |
| Пустой/`undefined`/свободный текст | `tests/demoExtract.test.ts` | `docType:'unknown'`, `items:[]`, warnings, не бросает | [авто] |
| Обрезка по `MAX_DEMO_ITEMS`=500, разделители tab/`;`, синонимы колонки | `tests/demoExtract.test.ts` | 500 строк + warning; распознаются; безымянная числовая строка → `(без наименования)` | [авто] |
| Виды налог. ID УНП/ИНН/БИН/ИИН/ЖСН/БСН | `tests/demoExtract.test.ts` | Корректный `taxIdKind`; `language:'unknown'` без подсказки | [авто] |
| DoS-гард `MAX_DEMO_CHARS`=200000 | Подать текст >200k символов в `extractDemo` | Обрезка по срезу, не виснет | [вручную] |
| Негатив `,`-детекции | Строки с десятичными запятыми (`1,50`) | НЕ ловятся как таблица (нужно ≥3 колонок на всех строках) | [вручную] |
| Классификация итогов | Смешанные/повторные строки итогов | «Всего к оплате/…» → `total` раньше «Итого» → `sum`; НДС/ПДВ/ҚҚС → `vat` | [вручную] |
| Endpoint happy-path (детерминированный) | `curl -F file=@public/demo/kp-ru.txt localhost:3000/api/demo/extract` | 200 `{result, notice, remaining}` **синхронно**; `remaining` убывает | [вручную] |
| AI-путь асинхронный (GH #70) | Загрузить PDF/скан/`.xls` | submit → `202 {jobId, status:'pending'}`; поллинг `GET /api/demo/result/:jobId` → `{status:'pending'}` → `{status:'done', result}`; несуществующий/устаревший id → 404; при переполнении concurrency/стора → 503+`Retry-After` | [нужен LLM-ключ/прод] |
| Нет Content-Length | chunked-запрос без размера | 411 «Не указан размер запроса.» | [вручную] |
| Превышен размер по заголовку | `Content-Length` >~1.1МБ | 413 до чтения тела | [вручную] |
| Файл не передан / пустой | POST без части `file` / 0 байт | 400 «Файл не передан.» / «Файл пуст.» | [вручную] |
| Неверное расширение | `curl -F file=@some.zip` (или `.exe`) | 415 с текстом про поддерживаемые форматы (PDF/скан/Excel/Word приняты) | [вручную] |
| Отклонённый файл не жжёт квоту | 3× битых → валидный | Валидный проходит (валидация раньше `limiter.check`) | [вручную] |
| windows-1251 файл | Загрузить .txt в CP1251 | Корректно декодируется, поставщик/позиции читаемы | [вручную] |
| Лимит 3/10мин на IP | 4 подряд валидных с одного IP | 4-й → 429 + `Retry-After`, `{error, retryAfterSec}` | [нужен живой портал/прод] |
| UI кнопки-примеры (9 шт.) | Клик грузит `/demo/<id>.txt`, парсит КЛИЕНТСКИ | Карточка результата без обращения к API/лимиту | [вручную] |
| UI дропзона / повторный файл / ошибка API | drag-drop → POST; повтор того же файла; 415/429 | «Разбираем…»; повтор срабатывает (`input.value=''`); красный блок ошибки | [вручную] |
| UI баннер публичности + скриншоты | Amber-баннер «3 файла за 10 минут»; `pnpm screenshot` | Виден; light/dark × mobile/desktop без слома вёрстки (nuxt-теста на компонент нет) | [вручную] |
| Реальное извлечение PDF/скан/Excel через `runAgent` | Прогнать PDF/скан/`.xls` на **проде** (async-путь) | `202 {jobId}` → поллинг → `{status:'done', result}` с товарами/поставщиком; бинарники+LLM только в прод-образе (в dev не воспроизвести) | [нужен LLM-ключ/прод] |
| Запись в Bitrix24 | — | В демо-пути отсутствует полностью | [нужен живой портал] |

### Публичный лендинг

Файлы: `app/pages/index.vue`, `app/components/HeroParticles.vue`, `app/utils/landing.ts`, `app/app.vue` (SEO). Тест: `tests/landing.test.ts`.

| Проверка | Действие | Ожидаемо | Метка |
|---|---|---|---|
| Контент-константы лендинга | `pnpm test:unit` → `tests/landing.test.ts` | `LANDING_STEPS` = 3 шага `n=[1,2,3]`; `LANDING_FEATURES` = 4; `LANDING_SUBTITLE` содержит `1-в-1` | [авто] |
| `copyrightYears` год/диапазон/клэмп | `tests/landing.test.ts` | `(2026,2026)→"2026"`, `(2024,2026)→"2024–2026"`, `(2027,2026)→"2026"` | [авто] |
| SSG-сборка `/` | `pnpm generate`, смотреть `.output/public/index.html` | Без ошибок; в HTML заголовок, подзаголовок, 3 шага, 4 фичи, footer «© … ИП Шевчик И.С.» | [авто/вручную] |
| Заголовок вкладки и `lang` | Открыть `/` | `<html lang="ru">`; `<title>` = «AI-импорт документов в Bitrix24»; `bodyAttrs.class` с `bg-[#05010f]` | [вручную] |
| CTA ведут в приложение | Клик по обеим кнопкам CTA | Переход на `/app` (в prerender), не внешний URL, не 404 | [вручную] |
| HeroParticles: reduced-motion | Включить «уменьшение движения», перезагрузить `/` | Статичный кадр, `requestAnimationFrame` не стартует | [вручную] |
| HeroParticles: пауза вне видимости/скрытой вкладки | Проскроллить hero, переключить вкладку | Импульсы замирают, при возврате продолжаются (~30fps) | [вручную] |
| HeroParticles: очистка ресурсов | Переходы `/`↔`/app` несколько раз | Нет накопления слушателей/RAF; `running=false` после ухода | [вручную] |
| HeroParticles client-only / SSR | `pnpm generate` + просмотр без JS | Генерация не падает на canvas/`window`; canvas `aria-hidden`, слой `pointer-events-none` | [вручную/авто] |
| Доступность декоративных слоёв | axe/скринридер по `/` | glow-div и canvas `aria-hidden`; иерархия h1→h2→h3 логична | [вручную] |
| Визуальная тёмная оболочка | Открыть `/` в light/dark, desktop/mobile | Всегда тёмный фон; grid шагов `sm:grid-cols-3`, фич `sm:grid-cols-2`; на мобиле 1 колонка, нет гор. скролла | [вручную] |
| Пробел SEO-меты | Ревизия `app.vue`/`index.vue` | Нет `meta description`/`og:image`/`twitter:card`/canonical, `siteUrl` пуст — фиксировать как пробел | [вручную] |
| HeroParticles не покрыт тестами | Ручная визуальная проверка через `pnpm dev` | Скрипта скриншотов нет — снимать вручную | [вручную] |

### Загрузка документа и извлечение текста

Файлы: `server/api/import/upload.post.ts`, `status.get.ts`, `server/utils/{fileStore,textExtract,extractRunners}.ts`, `app/utils/importUpload.ts`, `server/queue/handlers.ts` (`handleFileExtractJob`), `app/pages/import.vue`. Сам HTTP-роут unit-тестами не покрыт — только чистые части.

| Проверка | Действие | Ожидаемо | Метка |
|---|---|---|---|
| Прогон релевантных unit-тестов | `pnpm test:unit` (или `pnpm test`) | Все зелёные | [авто] |
| `validateUploadFile`/`planUploadBatch` | `tests/importUpload.test.ts` | Принимает pdf/png/jpg/jpeg/xlsx/xls/docx; отклоняет неизвестное/пустое/оверсайз; усечение по `MAX_UPLOAD_FILES`=10 | [авто] |
| `fileStore` пути | `tests/fileStore.test.ts` | `safeSeg` срезает `..`; `uploadPath` заперт в baseDir; `saveUpload` mkdir→write; `deleteUpload` глотает отсутствие | [авто] |
| `planExtraction`/`extractText` маршрутизация | `tests/textExtract.test.ts` | По расширению; цифровой PDF→pdfToText, скан-PDF→OCR, порог `MIN_PDF_TEXT`=32 без OCR, unsupported→throw с именем | [авто] |
| `decodeBytes` | `tests/decodeBytes.test.ts` | UTF-8 цел; невалидный UTF-8→1251; литеральный U+FFFD не переключает; пустой→'' | [авто] |
| `handleFileExtractJob` | `tests/pipelineHandlers.test.ts` | Успех→saveText+enqueue; пустой→failJob; >`MAX_DOCUMENT_TEXT`=500000→failJob; бросок→failJob | [авто] |
| `jobStore` | `tests/jobStore.test.ts` | `createJob` ON CONFLICT; `listJobs` member-scoped DESC, LIMIT [1,200] | [авто] |
| Фрейм-авторизация | `tests/resolveFrameMember.test.ts`, `tests/frameAuth.test.ts` | verify→member_id; 401 отказ токена; 502 транспорт; 401 портал не установлен; SSRF-гард домена | [авто] |
| upload без авторизации | `curl -X POST :3000/api/import/upload -F file=@doc.pdf` | 401 `{error:"frame auth required"}` | [вручную] |
| upload с не-b24 доменом | curl `X-B24-Domain: evil.com` | 401 (SSRF-гард) | [вручную] |
| upload токеном чужого портала | curl Bearer+домен | 401/502 по `resolveFrameMember` | [нужен живой портал] |
| upload при недоступной очереди | POST файла с остановленным Redis | 503 «сервис обработки временно недоступен», байты/job не создаются | [вручную] |
| upload оверсайз по заголовку | `Content-Length` ~21МБ | 413 «файл слишком большой» до буферизации | [вручную] |
| upload без `file`/пустой | POST без части / 0 байт | 400 «файл не передан» | [вручную] |
| upload запрещённое расширение | POST `.exe`/`.zip`/`.txt` | 400 «Неподдерживаемый формат: .<ext>» | [вручную] |
| upload двойная граница размера ~20.5МБ | Файл между `MAX_UPLOAD_BYTES` и +1МБ | Пред-проверка пройдёт, `validateUploadFile` → 400 «больше 20 МБ» | [вручную] |
| upload happy-path | POST корректный `.pdf` ≤20МБ | 200 `{jobId, status:"queued"}`; файл на диске; строка `import_job`; задача в очереди | [нужен живой портал] |
| upload подделка member_id | POST с member_id в теле | Игнорируется — берётся из `resolveFrameMember` | [вручную/код-ревью] |
| status без авторизации | `GET /api/import/status` | 401 «frame auth required» | [вручную] |
| status свой портал | GET Bearer+домен | `{jobs:[…]}` только своего портала, новые сверху, ≤50 | [нужен живой портал] |
| status изоляция порталов | GET из портала A | Задачи B не видны | [нужен живой портал] |
| Извлечение: цифровой PDF | Загрузить PDF с текстовым слоем | `pdftotext -layout` даёт текст, OCR не вызывается | [нужен бинарями] |
| Извлечение: скан-PDF / изображение | Загрузить скан / `.png`/`.jpg` | Фолбэк на OCR, rus/bel/kaz/eng | [нужен бинарями] |
| Извлечение: office | Загрузить `.xlsx`/`.docx`/`.xls` | `officeToText`: таблицы (`xls/xlsx/ods`) → **CSV** (TAB/UTF-8, `officeConvertTarget`), текст-доки (`doc/docx/odt/rtf`) → **txt**; временный каталог удаляется | [нужен бинарями] |
| Извлечение: много-листовая книга (GH #76) | Загрузить ТТН/накладную с товарами на не-первом листе («Приложение») | Боевой `officeToText`: **все листы** склеены в порядке книги (шапка первой), товары не теряются; пустые листы отброшены. NB демо-фолбэк `xlsxToTextFallback` — только первый лист | [нужен бинарями] |
| Извлечение: cp1251 | Загрузить не-UTF-8 | `decodeBytes` декодирует в 1251 | [нужен бинарями/вручную] |
| Извлечение: зависание/таймаут | Файл >90с обработки | SIGKILL, «timed out» (`RUN_TIMEOUT_MS`=90000) → job `error` | [вручную] |
| Извлечение: отсутствие бинаря | pdf без `pdftotext` в PATH | job `error` «извлечение текста: …» | [вручную] |
| Извлечение: память (бомба) | zip/XML/image-бомба | Таймаут ограничивает CPU, не память — это `mem_limit` контейнера | [нужен деплой] |
| Жизненный цикл: очистка байтов | Успешная extract-джоба | `saveText`+`enqueueAgentRun`, загруженные байты удаляются (минимизация) | [нужен живой портал] |
| Жизненный цикл: ошибка/оверсайз | Битый/пустой/огромный файл | `status='error'`, русское сообщение; на `/import` красным; текст >500000 → «разбейте на части» без обрезки | [нужен живой портал] |
| UI `/import` вне портала | Загрузить страницу | Рендерится, пайплайн не идёт → error в оранжевом блоке | [вручную] |
| UI `/import` в портале | drag-drop / `<input multiple>`; «Обновить» | Последовательный upload, `input.value=''`; список перечитывается, статус-бейджи | [нужен живой портал] |
| UI визуальная проверка | `pnpm generate && pnpm screenshot` | light/dark × mobile/desktop | [вручную] |

### Агент-экстрактор (LLM)

Файлы: `server/agent/{runAgent,mcpConfig,spawn,retry,extractJson}.ts`, `prompts/extract.ts`, `app/utils/extractedDocument.ts`, проводка — `server/queue/{liveDeps,worker}.ts`. Агент — чистый экстрактор (документ на stdin → один JSON `ExtractedDocument`), без доступа к Bitrix24; в MVP инструменты запрещены.

| Проверка | Действие | Ожидаемо | Метка |
|---|---|---|---|
| Оркестрация `runAgent` | `pnpm test:unit` → `tests/runAgent.test.ts` | Успех с 1-й; transient→retry+backoff; исчерпание 3 попыток; terminal без ретрая; пустой выход→terminal; brosok→transient; exit-0 `{is_error:true}`→retry; `>MAX_ITEMS`→жёсткая ошибка; обрезка строки ошибки ≤301 | [авто] |
| `parseAgentOutput`/`agentEnvelopeError` | `tests/runAgent.test.ts` | JSON; распаковка конверта `{result:"…json…"}`; null без JSON; флаг ошибок | [авто] |
| Нормализация `validateExtractedDocument` | `tests/extractedDocument.test.ts` | Коэрция чисел ru/be/kk и `20%`; сохранение `vatRate:0`; отклонение 4+-буквенной валюты; digits-only taxId; drop supplier без name; DoS-клампы; cap `MAX_ITEMS` | [авто] |
| Промпт | `tests/extractPrompt.test.ts` | «РОВНО ОДИН JSON» без markdown; метки налогов 3 стран; единый НДС + 1-в-1 + казахские буквы; пример проходит валидатор | [авто] |
| Санитайз env `agentSpawnEnv` | `tests/agent.test.ts` | Пропускает LLM-ключи/PATH, вырезает `DATABASE_URL`/`B24_TOKEN_ENC_KEY`/`B24_CLIENT_SECRET`; extractor-mode: пустой `--allowedTools`, полный `--disallowedTools`, нет `--mcp-config`; per-job bearer в `buildMcpConfig` | [авто] |
| `extractJson` | `tests/agent.test.ts` | Последний сбалансированный объект; скобки/кавычки в строках; null на битом/пустом/оверсайз >2МБ | [авто] |
| `spawn` (`makeAgentSpawn`) | `tests/agentSpawn.test.ts` | Сбор stdout/stderr, санитайз-env; дедлайн→SIGKILL code 124; резолв один раз; error→terminal | [авто] |
| Retry-политика | `tests/agentRetry.test.ts` | `classifyAgentError` transient на 429/5xx/ECONNRESET/overloaded, terminal на своём timeout/пустом; `nextBackoffMs` экспонента+джиттер кап 30с | [авто] |
| Наш дедлайн-килл не зацикливает | `tests/agentRetry.test.ts` | code 124 «agent timed out» классифицируется terminal | [авто] |
| Prompt-injection exfil | `tests/agent.test.ts` (денилист + env-allowlist) | Env лишён секретов даже при проскочившем туле | [авто] |
| Синхронность денилиста с Claude Code | Глазами сверить список в `mcpConfig.ts` при обновлении CLI | Все exfil-опасные тулы в `--disallowedTools` | [вручную] |
| Актуальность CLI-флагов | `claude --help` | `--print --bare --output-format json` актуальны | [вручную] |
| Реальный прогон экстракции | Подать ru/be/kk документ через `runAgent`/очередь | `ok:true`, `items` 1-в-1, верные `taxIdKind`, единый `priceIncludesVat`, валюта ISO-4217 | [нужен LLM-ключ] |
| Негатив без таблицы / мусор | Документ без таблицы | `ok:false`, «не извлёк табличную часть», spawn 1 раз | [нужен LLM-ключ] |
| Отказ провайдера 429/529 | Заглушка на 529 / `{is_error:true}` | До 3 попыток с backoff → `ok:false`; invalid key → terminal 1 попытка | [нужен LLM-ключ] |
| Таймаут / отсутствие бинаря | Долгий ответ >`AGENT_TIMEOUT_MS`=120000; `AGENT_BIN=nonexistent` | SIGKILL terminal без ретрая; ENOENT→terminal | [нужен LLM-ключ] |
| Сквозной путь в crm-sync | extracted → `crm-sync` | Проверять в разделе crm-sync; агент даёт вход | [нужен живой портал] |

### Запись в CRM (crm-sync)

Оркестрация `server/queue/crmSyncCore.ts` (`runCrmSync`) + чистые REST-билдеры (`crmWrite`, `productLookup`, `companyLookup`, `chatNotify`, `configurableActivity`, `disk`), проводка `liveDeps.ts`, обёртка `handlers.ts`. Ядро без I/O, транспорты — DI.

| Проверка | Действие | Ожидаемо | Метка |
|---|---|---|---|
| Happy path: создание target | `tests/crmSyncCore.test.ts` | `createTarget` с fields (вкл. `opportunity`+`isManualOpportunity:'Y'` для сделки/КП/смарт-счёта); `recordResult` ДО `setRows`; строки пишутся; `created=true` | [авто] |
| Сумма сделки (opportunity) | `tests/server-crm.test.ts` (`computeOpportunity`/`supportsOpportunity`) | по-юнитное округление как Bitrix; проставляется только для 2/7/31, смарт-процесс (≥1000) пропускается | [авто] |
| Уведомление об успехе | `tests/crmSyncCore.test.ts` | `notifySuccess` с summary (supplier/entityId/rowCount/warnings) | [авто] |
| Идемпотентный повтор | `tests/crmSyncCore.test.ts` | `getExisting`≠null → нет create, `setRows` повторяется (замещение), `created=false`, без повторного `notifySuccess` | [авто] |
| Поставщик не найден | `tests/crmSyncCore.test.ts` | Сущность создаётся без `companyId`, warning; без `taxId` — lookup не вызывается | [авто] |
| `findCompanyByTaxId` нормализация | `tests/server-crm.test.ts` | Стрипает не-цифры (`RQ_INN`), при дублях min ID, пустой→null | [авто] |
| Живой поиск компании по taxId | Портал: фильтр `RQ_INN` + `ENTITY_TYPE_ID=4` | Отдаёт `ENTITY_ID` для BY-УНП / RU-ИНН | [нужен живой портал] |
| НДС не в портале → аборт | `tests/crmSyncCore.test.ts` | Ошибка в чат, `created=false`, `entityId=0`; смешанные — аборт всего документа (нет потери строк) | [авто] |
| `priceIncludesVat` undefined при НДС>0 | `tests/crmSyncCore.test.ts` | Жёсткая ошибка «Не определено, включён ли НДС»; без НДС undefined → OK | [авто] |
| `vatRate=0` не в портале / NaN-ставка | `tests/crmSyncCore.test.ts`, `tests/vat.test.ts` | Жёсткая ошибка (0% ≠ «Без НДС»); `matchVatRate` NaN → null → ошибка | [авто] |
| Валюта не в портале | `tests/crmSyncCore.test.ts` | «Валюта X отсутствует», не создана, `notifySuccess` не вызван | [авто] |
| Товар по name/article | `tests/productLookup.test.ts` | `by='name'` игнорирует article; `by='article'`: `%PROPERTY_<id>` (order ID ASC) сужает → точная сверка `articleMatches`; отсекает ложные `A-10`⊄`{A-100}`; оба варианта (text/string); нечисловое поле → пропуск; фолбэк NAME | [авто] |
| Товар не найден skip/create | `tests/crmSyncCore.test.ts` | `skip-warn` пропуск+warning; `create` зовёт `createProduct`, null→«произвольная позиция» | [авто] |
| Единица/отриц. значения/пустой items | `tests/crmSyncCore.test.ts`, `tests/units.test.ts` | Единица не сопоставлена → WARNING+дефолт; отриц. price/qty→clamp 0+warning; пустой items→create без `setRows` | [авто] |
| `ownerTypeCode`/`buildProductRow` | `tests/server-crm.test.ts` | 2→D,7→Q,31→SI,≥1000→`T<id>`; `taxIncluded` Y/N; `productId` опускается | [авто] |
| Живая проверка productrow.set / SI / T<id> | Портал: смарт-процесс + `crm.item.productrow.set` | НДС 1-в-1, ownerType корректен | [нужен живой портал] |
| Сумма сделки не 0 без торгового учёта | Портал без каталога → создать сделку с позициями | `opportunity` = нашей сумме (не 0), `isManualOpportunity=Y` держится; header == Σ строк | [нужен живой портал] |
| Поиск по артикулу на портале | ✅ **проверено вживую 2026-07-09** (свойство создано на iblock 25) | exact-фильтр не находит мультиартикул → нужен `%LIKE`; оба варианта (построчно/через `;`) найдены; ложные отсечены; символьный код НЕ фильтрует → только числовой `PROPERTY_<id>` | ✅ |
| Ручной override цели | `tests/crmSyncCore.test.ts`, `tests/routing.test.ts` | Роут в др. entityType, `stageId`/`categoryId` прокидываются | [авто] |
| Чат: нейтрализация BB / капы / ссылки | `tests/chatNotify.test.ts` | `neutralizeBb` фолдит `[`/`]`; warnings кап 10, message кап 20; `entityLink` 2/7/иное | [авто] |
| Чат: `sendChatMessage` / сбой notifySuccess | `tests/chatNotify.test.ts`, `tests/crmSyncCore.test.ts` | Пустой→null, нечисловой→null, успех→id>0 `URL_PREVIEW='N'`; сбой notifySuccess → warning, не падение | [авто] |
| Чат ошибок в `liveDeps.reportErrors` | Код-ревью `liveDeps.ts` | `METRICS.errors` инкрементнут, ошибка чата глотается | [вручную] |
| Живая доставка в чат (scope `im`) | Портал: `im.message.add` в notify/error чат | Success/error реально отправлены | [нужен живой портал] |
| `handleCrmSyncJob` статусы | `tests/queueHandlers.test.ts` | Нет документа→`error` без run; успех→`done` с JSON; жёсткая ошибка→`error`; терминал→`deleteDocument`, сбой очистки не валит | [авто] |
| Гонка create↔recordResult | Код-ревью `crmSyncCore.ts:118-140` | Известный риск редкого дубля (не атомарны) — зафиксировать как ограничение | [вручную] |
| Кэш RestCall / портал без токена | Код-ревью `liveDeps.ts`, `need()` | null и rejected вычищаются из кэша; `need()` бросает «портал не авторизован» | [вручную] |
| Диск + настраиваемое дело (ядро) | `tests/diskActivity.test.ts` | `buildConfigurableActivity` (капы, `safeRelativePath`); `pickCommonStorage`/`monthlySubfolderName`/`ensureSubfolder`/`uploadFile` | [авто] |
| Диск/дело НЕ проведены в пайплайн | grep `server/queue/` пуст | Реальная загрузка на диск и `crm.activity.configurable.add` не подключены | [нужен живой портал] |
| Сквозная проверка | Живой портал (mapping) → документ через extract→agent→crm-sync | Сущность с компанией/валютой/строками (НДС 1-в-1), success-чат; при отсутствии ставки/валюты — error-чат; дубль-загрузка идемпотентна | ✅ **пройдено вживую 2026-07-09** (засеянный портал + DeepSeek): компания по RQ_INN, opportunity, персист позиций, файл на Диск, дело (todo+file), чат. Осталось: `configurable.add` в OAuth-контексте, идемпотентность дубля |

### Очереди (BullMQ/Redis)

Топология (`server/queue/topology.ts`): 4 очереди `b24-events`/`file-extract`/`agent-run`/`crm-sync`; конвейер `file-extract`→`agent-run`→`crm-sync` (события B24 в этом воркере не крутятся).

| Проверка | Действие | Ожидаемо | Метка |
|---|---|---|---|
| `parseRedisUrl` | `tests/queueConnection.test.ts` | `redis://host`→6379; парсит user/password; битый→null | [авто] |
| `readQueueCounts` | `tests/queueStats.test.ts` | Агрегирует 4 очереди в порядке `Object.values(QUEUES)`; NaN→0; бросающий reader→нули (не роняет) | [авто] |
| `handleFileExtractJob` | `tests/pipelineHandlers.test.ts` | Текст→markExtracting+saveText+enqueue; пустой→failJob; >500000→failJob без усечения; бросок→failJob | [авто] |
| `handleAgentRunJob` | `tests/pipelineHandlers.test.ts` | Нет текста/null→failJob; enqueue crm-sync ДО удаления текста; `manualOverride` в signals; routing-текст режется `MAX_ROUTING_TEXT`=131072; сбой delete не блокирует | [авто] |
| `handleCrmSyncJob` | `tests/queueHandlers.test.ts` | Норм→`done`; нет документа→`error` без run; жёсткая ошибка→`error`; идемпотентный→`done` `created:false`; сбой `deleteDocument` не роняет | [авто] |
| Детерминизм `makeJobId` и др. | — | Прямого юнит-теста нет — предложить добавить | [вручную] |
| Без `REDIS_URL` | `pnpm dev`, дёрнуть продюсер | `queueEnabled()`=false, `getQueue()`→null, продюсеры no-op, воркеры не стартуют | [вручную] |
| Redis поднят | `docker compose up redis`, старт бэкенда | Лог `[queue] started 3 pipeline workers`; concurrency extract=4/agent=2/crm=4 | [вручную] |
| Ретраи инфра-сбоя | Джоба с падающим транспортом | `attempts:3`, backoff 5000ms; после — `onExhausted`: `setJobStatus 'error'` + extract `cleanupUpload` | [вручную] |
| Джоба без memberId/jobId | — | `onExhausted` тихо выходит, не бросает | [вручную] |
| Дедуп повторной доставки | enqueue дважды с тем же ключом | Вторая не создаёт дубль | [вручную] |
| Redis падает во время подсчёта | `GET /api/ops/queues` | Нули для очереди, ответ 200 не 500 | [вручную] |
| Крайние случаи запуска | prerender / исключение `startWorkers` | Плагин выходит сразу; ошибка логируется, процесс не падает | [вручную] |
| `/api/queues` токеном | `curl -H "X-Check-Token: <B24_APPLICATION_TOKEN>"` | 200; токен только заголовком; без/неверный→403 (`opsTokenOk`, ядро в `tests/operatorSession.test.ts`) | [вручную] + [авто] |
| `/api/ops/queues` сессией | `curl --cookie <op>` | 200; нет/просрочена→401 (`operatorAllowed`) | [вручную] + [авто] |
| Страница `/queues` | `pnpm generate && pnpm screenshot`, открыть | `noindex`; 4 карточки с русскими лейблами, счётчики, прогресс-бар; истёкший cookie→`/login`; сервис недоступен→amber; пусто→«Нет данных» | [вручную] |
| Отказ Redis на проде | — | Продюсеры событий — синхронный фолбэк в БД; конвейерные джобы не ставятся | [вручную] |
| Джоба без токена портала | — | `restResolver` кэширует только не-null; `need()` бросает «портал не авторизован»→ретрай | [вручную] |
| DoS-гарды payload | Проверить содержимое джобы | `MAX_DOCUMENT_TEXT`/`MAX_ROUTING_TEXT` — громкий отказ, raw-текст сверх границы не кладётся | [вручную] |
| Живой `agent-run`→`crm-sync` | Реальный прогон | Требует ключа агента и записи в CRM | [нужен LLM-ключ] + [нужен живой портал] |

### События установки/удаления Б24

Приём вебхуков `ONAPPINSTALL`/`ONAPPUNINSTALL` на `POST /api/b24/events`, верификация `application_token` (fail-closed, constant-time). Файлы: `server/api/b24/events.post.ts`, `server/utils/{b24EventsHandler,tokenStore,nodeFileIO,secretCrypto}.ts`, `app/utils/b24Events.ts`. Примечание: `app/pages/install.vue` в редизайне отсутствует — install-flow не реализован, вебхук-приём самодостаточен.

| Проверка | Действие | Ожидаемо | Метка |
|---|---|---|---|
| Парсинг PHP-скобочной формы | `tests/b24Events.test.ts` → `parseBracketForm` | Вложенный объект, `event`/`member_id`/`application_token` извлечены | [авто] |
| Prototype-pollution / edge парсинга | `tests/b24Events.test.ts` | `__proto__` игнорируется; `+`→пробел, пустое тело, битый `%` не бросает | [авто] |
| `extractEvent`/`safeEqual` | `tests/b24Events.test.ts` | Нормализация формы; constant-time, fail-closed на длине/пустом | [авто] |
| `decideB24Event` статусы | `tests/b24Events.test.ts` | 400 нет event/member; 503 нет ожид. токена; 403 mismatch; 200 register/unregister; чужое событие→ignore | [авто] |
| `saveToken` write-once | `tests/server-glue.test.ts` | `ON CONFLICT (member_id)` + `COALESCE(NULLIF(...))`; `getToken`/`getApplicationToken` null при отсутствии | [авто] |
| `deletePortal` порядок очистки | `tests/server-glue.test.ts` | `portal_tokens, job_result, metrics_counter, import_job, import_text, import_doc`, `params=['m1']` | [авто] |
| Register | `curl -X POST` ONAPPINSTALL с env-токеном | 200 `{ok:true}`; строка в `portal_tokens`, refresh зашифрован | [вручную] |
| TOFU: чужой токен при установленном портале | Повторный POST с другим токеном | 403 `action:'ignore'` (сверка со stored, не env) | [вручную] |
| Unregister | POST ONAPPUNINSTALL с верным токеном | 200; `deletePortal` + `purgePortalFiles` снёс каталог | [вручную] |
| Нет ожидаемого токена | Валидный POST, app_token пуст в env и БД | 503 `{ok:false}` | [вручную] |
| БД недоступна | Валидное register/unregister при `dbEnabled()=false` | 503 `{error:'no database'}` — событие не теряется молча | [вручную] |
| Тело без event/member | `curl -d 'auth[application_token]=x'` | 400 `action:'ignore'`, ничего не пишется | [вручную] |
| Неизвестное событие | POST `ONCRMDEALADD` с верным токеном | 200 `action:'ignore'`, БД не трогается | [вручную] |
| Write-once на повторный install | POST с новыми access/refresh, пустым app_token | `application_token` не перезаписан, остальное обновлено | [вручную] |
| Шифрование refresh | `decryptSecret(blob, B24_TOKEN_ENC_KEY)` | Исходный refresh; blob `iv:tag:ciphertext` base64; пустой refresh не шифруется | [вручную] |
| Неверная длина `B24_TOKEN_ENC_KEY` | register с не-32-байтовым ключом | `decodeKey` бросает; стартовая валидация env ловит заранее | [вручную] |
| SSRF `client_endpoint` | Значение из события | Убедиться, что REST-цепочка валидирует endpoint (на приёме гварда нет) | [вручную] |
| Дубликат домена | Переустановка | `getMemberIdByDomain` → минимальный `member_id` детерминированно | [вручную] |
| Пробел покрытия роута | Ревизия `events.post.ts`, `secretCrypto`, `purgePortalFiles` | Интеграционного теста роута нет; round-trip шифра/malformed blob без vitest — кандидаты добавить | [вручную] |
| Реальная доставка токена подписи | Установка/удаление в тестовом портале (`B24_HOOK`) | Подлинный `application_token` + OAuth-креды — только вживую | [нужен живой портал] |

### Настройки портала (маппинг)

`server/utils/appSettings.ts` (`readMapping`/`writeMapping`, ключ `procure_mapping`), `app/utils/portalSettings.ts`, `app/types/mapping.ts`, роуты `server/api/settings.{get,post}.ts` (фрейм-токен через `frameAuth.ts`), клиент `useSettings.ts`. Файла `settingsHandler.ts` нет.

| Проверка | Действие | Ожидаемо | Метка |
|---|---|---|---|
| Прогон | `pnpm test:unit` → `portalSettings`/`appSettings`/`frameAuth` | Зелёные | [авто] |
| Пустой/битый вход | `parsePortalSettings(null)`/`('nope')` | `defaultMapping()` (article text, product article/skip-warn, units defaultCode 796, saveFile true, defaultTarget entityTypeId 2) | [авто] |
| Полный валидный объект | Article/product/units | Значения приняты; ключи `units.dictionary` в нижнем регистре, нечисловые отброшены | [авто] |
| `entityTypeId ≤0/NaN` | `parsePortalSettings({defaultTarget:{entityTypeId:-1}})` | Фолбэк `{entityTypeId:2}` | [авто] |
| Пустое правило / пустые keywords | `routingRules:[{match:{}}]`; `['ТН','']` | Правило отброшено; пустые keywords отфильтрованы | [авто] |
| `saveFile`/chatId/categoryId/stageId | Разные типы | `saveFile !== false` → true; не-строка chatId опускается; не-finite categoryId опускается; stageId→строка | [авто] |
| `readMapping` из строки/объекта | `tests/appSettings.test.ts` | `app.option.get {option:'procure_mapping'}`; строка распарсена; объект принят напрямую | [авто] |
| `readMapping` невалидный JSON / не задано | `'not json'` / `''` | Safe defaults, не throw | [авто] |
| `writeMapping` нормализует перед записью | Мусорный вход | bad→2, пустое правило отброшено; `app.option.set`; вернул нормализованное | [авто] |
| Роут без токена/домена | curl без `Authorization`/`X-B24-Domain` | 401 «frame auth required» (GET и POST) | [вручную] |
| Схема не Bearer / SSRF-домен | `Basic xxx`; `X-B24-Domain: evil.com` | null → 401 (пропускаются только `*.bitrix24.<tld>`/`oauth.bitrix24.tech`) | [вручную] |
| POST пустое/не-объектное тело | body `{}`/`null`/строка | 400 «mapping required» (не сбрасывает в defaults) | [вручную] |
| POST `body.mapping` или body | `{mapping:{…}}` и `{…}` | Оба варианта берутся | [вручную] |
| REST падает | GET/POST при недоступном B24 | 502 «settings read/save failed» | [нужен живой портал] |
| Полный цикл в iframe | Изменить маппинг → сохранить → перезагрузить | Персистится в `app.option`, читается обратно, изоляция по порталу | [нужен живой портал] |
| Клиент вне фрейма | `useSettings` без frame auth | Инертен, запросы не уходят | [нужен живой портал] |
| Роут-обёртки / UI формы | curl статусов; форма настроек | Юнит-тестов на `defineEventHandler` и UI нет — проверять вручную | [вручную] |
| `TargetEntityKind` ↔ реальные entityTypeId | Портал (deal=2, quote=7, invoice=31, smart-process≥1000) | Согласованность типов | [нужен живой портал] |

### Операторская авторизация

Служебная зона (`/login`, `/queues`, `/api/ops/queues`). Реальный гейт серверный (401/503 + `operatorAllowed`); клиент — только UX. Кука `procure_op` (HttpOnly/SameSite=Lax/Secure, TTL 8ч). Секрет `OPERATOR_SESSION_SECRET` с фолбэком на `B24_TOKEN_ENC_KEY`; пустой `OPERATOR_PASSWORD` ⇒ вход выключен. Замечание: `app/middleware/auth.ts` и `AuthGate` в репозитории ОТСУТСТВУЮТ — защита на серверном 401 + `router.push('/login')` в `onMounted`.

| Проверка | Действие | Ожидаемо | Метка |
|---|---|---|---|
| Прогон ядра | `pnpm test:unit` → `session`/`operatorSession` | Оба файла зелёные | [авто] |
| `resolveAuthConfig`/`checkCredentials` | `tests/session.test.ts` | Пустой env→`{'',''}`, фолбэк на enc-key; верный пароль→true, timingSafeEqual false-path, выключенный вход→false | [авто] |
| `signSession`/`verifySession` | `tests/session.test.ts` | Round-trip; битая подпись/чужой secret/expired/future-dated→invalid; границы (`diff==maxAge`, `issuedAt==now`)→valid | [авто] |
| `operatorAllowed`/`opsTokenOk` | `tests/operatorSession.test.ts` | Свежая кука→true; garbage/просроченная/чужой secret→false; пустой ожидаемый токен fail-closed→false | [авто] |
| Login успех | `curl -XPOST /api/auth/login -d '{"password":"hunter2"}'` | 200 + `Set-Cookie procure_op HttpOnly SameSite=Lax Secure Max-Age=28800` | [вручную] |
| Login неверный пароль | Тот же curl с чужим паролем | ~400мс задержка, 401 «неверный пароль», без куки | [вручную] |
| Вход выключен / нет секрета | Login без `OPERATOR_PASSWORD` / без секрета | 503 «вход оператора отключён» / 503 | [вручную] |
| Session get | GET `/api/auth/session` без/с кукой | `{authenticated:false/true, enabled:true}` | [вручную] |
| Logout | POST `/api/auth/logout` | 200 + истёкший `procure_op`; повторный session→`authenticated:false` | [вручную] |
| Подделка/обрезка куки | GET session с битой кукой | `authenticated:false` (HMAC не сходится) | [вручную] |
| Body без password | `{}`/не-JSON | 401 (не 500) | [вручную] |
| `/api/ops/queues` гейт | GET без/с/просроченной кукой | 401 «unauthorized» / 200 `{queues:[…]}` / 401 | [вручную] |
| `/api/queues` гейт | GET с верным/неверным `X-Check-Token` | 200 / 403 «forbidden»; при незаданном токене — 403 fail-closed | [вручную] |
| UI login submit / выключен / уже авторизован | `/login` | «Вход…»→`/queues`; при ошибке красный `{{error}}`; жёлтый баннер при `enabled=false`; авто-redirect авторизованного | [вручную] |
| UI queues без сессии / истёкший cookie / сбой | `/queues` | Redirect `/login` (данные не грузятся); 401 при «Обновить»→`/login`; не-401→баннер «Сервис недоступен»; «Выйти»→logout→`/login` | [вручную] |
| `noindex` на служебных | `pnpm generate`, смотреть HTML | `/login` и `/queues` несут `<meta robots noindex>` | [авто-визуально/вручную] |
| Общий прогон | `pnpm check` | Весь набор зелёный | [авто] |
| Секрет-фолбэк | Только `B24_TOKEN_ENC_KEY` задан | Вход и подпись куки работают на нём | [вручную] |
| Тайминг-атака | Пароли равной/разной длины | timingSafeEqual / ранний return false | [авто] |
| Edge-лимит брутфорса (nginx `limit_req`) | — | В репозитории не реализован (nginx.conf нет), только прод-требование `docs/AUTH.md` | [нужен живой портал/прод] |

### Деплой и инфраструктура

Файлы: `Dockerfile`, `docker-compose.yml`, `server/api/health.get.ts`, `app/utils/build.ts`, `server/utils/envCheck.ts` (+ плагин), `.github/workflows/{ci,deploy}.yml`. `docker-compose.yml` — dev-only; прод-compose в репозитории нет.

| Проверка | Действие | Ожидаемо | Метка |
|---|---|---|---|
| `healthInfo` билдер | `pnpm test` → `tests/build.test.ts` | `dev`/`undefined`→`{status:'ok',commit:'dev',commitUrl:null}`; sha→`commitUrl=.../commit/<sha>` | [авто] |
| Health-эндпоинт | `curl -s localhost:3000/api/health` | 200 `{status:'ok', commit, commitUrl, time}`, без секретов | [вручную/бинарями] |
| Health commit из build-arg | Сборка `--build-arg COMMIT_SHA=<sha>` | `commit`=sha; без арга→`commit:'dev'`,`commitUrl:null` | [вручную] |
| Docker HEALTHCHECK | `docker inspect --format '{{.State.Health.Status}}'` после start-period 20s | `healthy`; interval 30s timeout 5s; порт не отвечает→`unhealthy` | [вручную/бинарями] |
| `checkBackendEnv` чистый env | `tests/envCheck.test.ts` | Ключ 32Б, DATABASE_URL, реальный app-token, client, redis → `errors:[]`, `warnings:[]` | [авто] |
| `checkBackendEnv` негатив | `tests/envCheck.test.ts` | 16-байт ключ→ошибка `got 16`; нет DATABASE_URL→ошибка; `CHANGE_ME`→ошибка placeholder | [авто] |
| `checkBackendEnv` warnings | `tests/envCheck.test.ts` | Пустые client id/secret→warning; пустой REDIS_URL→warning; слабый/фолбэк operator-секрет→warning | [авто] |
| Битый env на старте | Запуск с не-base64/16-байт ключом | `[env] ERROR:`/`[env] warning:` в логах, процесс НЕ падает (no-op при prerender); плейсхолдеры `'',change_me,todo,xxx,...` case-insensitive | [вручную] |
| Docker multi-stage сборка | `docker build --target backend -t procure-ai .` | Проходит; stage backend ставит poppler-utils, libreoffice, tesseract + rus/bel/kaz, fonts-dejavu | [вручную/бинарями] |
| Бинарники в образе | `pdftotext -v` / `tesseract --list-langs` / `libreoffice --version` | Присутствуют; языки tesseract rus/bel/kaz/eng | [вручную/бинарями] |
| Метаданные образа | `docker inspect procure-ai` | `NODE_ENV=production`, `UPLOAD_DIR=/data/uploads`, `EXPOSE 3000`, `CMD node .output/server/index.mjs` | [вручную] |
| frozen-lockfile защита | Рассинхрон `pnpm-lock.yaml` | `docker build` падает на `pnpm install --frozen-lockfile` | [вручную] |
| compose dev-стек | `docker compose up -d` | Поднимаются backend (`mem_limit 2g`, том uploads), db (postgres:16), redis:7; логи `[db] schema ensured`, `[queue] started N workers` | [вручную/бинарями] |
| compose без Redis/БД | Старт без `REDIS_URL`/`DATABASE_URL` | Очередь отключена (аплоады→503), хранилище no-op, процесс поднимается, health/лендинг работают | [вручную] |
| compose mem_limit vs бомба | zip/XML/image-бомба через libreoffice/tesseract | `mem_limit: 2g` не даёт OOM хоста, контейнер убивается | [вручную] |
| Ресурсы/OCR-таймаут на минимуме | 2 vCPU, несколько тяжёлых сканов разом | Конкуренция воркера (`server/queue/worker.ts`) ≤ числу ядер и/или `OMP_THREAD_LIMIT` выставлен — иначе OCR ложно упирается в `RUN_TIMEOUT_MS` 90с. См. `09-deploy §Ресурсы воркера` | [вручную/нужен прод] |
| CI job `ci` | PR/пуш в `main` | Порядок install→lint→typecheck→test→generate, Node 22, pnpm-кэш; имя job `ci` (required-check) | [авто/CI] |
| CI job `docker-build` | Тот же триггер | `docker build --target backend` без push, gha-кэш scope=backend | [авто/CI] |
| CI pin actions | Ревизия workflow | Все сторонние actions на commit SHA; `permissions: contents: read` | [вручную] |
| Deploy гейт по CI | Пуш в `main`, CI зелёный/красный | Публикация только при `workflow_run.conclusion=='success'`; красный CI не публикует `:latest` | [нужен GH] |
| Deploy verify-ci на тег/dispatch | Пуш `v*`/dispatch | `gh api` проверяет последний прогон `ci`==success, иначе `exit 1`; теги `latest`+`sha-<sha>` | [нужен GH] |
| Deploy build-args / фолбэк sha | Публикация; `head_sha` пустой/`null` | `COMMIT_SHA` в образ, `push:true`, concurrency cancel-in-progress; фолбэк `github.sha` | [нужен GH] |
| Живой прод-деплой (Watchtower/reverse-proxy) | — | Кодом в репозитории не описан, только `docs/redesign/09` | [нужен прод] |

## Что заблокировано и почему

Проверки, которые нельзя прогнать без внешней зависимости, — сгруппированы по причине блокировки.

**[нужен живой портал] Bitrix24 (env `B24_HOOK`, scopes `crm,catalog,disk,im,placement`):**
- Реальный поиск компании по taxId (`RQ_INN` + `ENTITY_TYPE_ID=4`), подтверждение `ownerType SI`/`T<entityTypeId>` и `crm.item.productrow.set` (НДС 1-в-1) — раздел crm-sync. Article-поиск товара по свойству каталога — ✅ проверен вживую (см. выше).
- Фактическая отправка success/error в чат (`im.message.add`, scope `im`); доставка в `errorChatId`.
- Загрузка исходного файла на Общий диск и `crm.activity.configurable.add` (ядро готово, но не проведено в пайплайн).
- Сквозной путь extract→agent→crm-sync с созданием целевой сущности и идемпотентностью дубль-загрузки.
- upload/status: токен чужого/неустановленного портала (`resolveFrameMember`), happy-path постановки в очередь, изоляция задач между порталами.
- Настройки: полный цикл чтения/записи `app.option` в iframe портала, изоляция по порталу, инертность клиента вне фрейма; 502 при недоступном REST; согласованность `TargetEntityKind` с реальными `entityTypeId`.
- События Б24: подлинная доставка `application_token` и OAuth-кредов при установке/удалении (эмулировать локально curl'ом можно всё, кроме токена подписи).

**[нужен живой портал/прод] Инфраструктура/nginx:**
- Rate-limit демо-endpoint 3/10мин по реальному IP (за nginx-цепочкой XFF); спуфинг XFF.
- Edge-лимит брутфорса логина (`limit_req`) — nginx.conf в репозитории отсутствует, только прод-требование.
- Защита памяти extract (`mem_limit` контейнера) от zip/XML/image-бомб; живой прод-деплой (Watchtower по `:latest`, reverse-proxy).
- Deploy-гейты GHCR (`workflow_run`/`verify-ci`, теги, build-args) — метка **[нужен GH]**.

**[нужен LLM-ключ] Агент-экстрактор (бинарь `AGENT_BIN` + ключ провайдера):**
- Реальный прогон извлечения из ru/be/kk документов (`items` 1-в-1, `taxIdKind`, единый `priceIncludesVat`, ISO-4217).
- Негатив без таблицы / мусор → терминальная ошибка без ретраев.
- Отказ провайдера 429/529 (до 3 попыток с backoff), invalid key (terminal), таймаут `AGENT_TIMEOUT_MS`=120000 (SIGKILL), отсутствие бинаря (ENOENT).
- Реальное извлечение PDF/скан/Excel в полной версии (в демо отсутствует); живой прогон `agent-run` в конвейере очередей.

**[нужен бинарями] Извлечение текста (poppler/libreoffice/tesseract в образе):**
- Цифровой PDF (pdftotext), скан-PDF и изображения (OCR rus/bel/kaz/eng), office-конвертация, cp1251-декод, гард `MAX_DOCUMENT_TEXT` на распознанном тексте, наличие бинарников и языков в образе.

## Автоматизировано

Уже покрыто vitest и гоняется в `pnpm check` (= `lint` + `typecheck` + `test`); быстрый прогон чистого ядра — `pnpm test:unit`. Ключевые файлы по подсистемам:

- **Демо:** `tests/demoExtract.test.ts` (парсинг 9 примеров, `parseNum`, бухгалтерские минусы, edge пустого/безымянного/лимитов), `tests/demoRateLimit.test.ts` (3/10мин, `clientKey` из XFF, `sweep`), `tests/demoUpload.test.ts` (расширения/размер/декод).
- **Лендинг:** `tests/landing.test.ts` (`LANDING_STEPS`/`FEATURES`, `copyrightYears` с клэмпом).
- **Загрузка/extract:** `tests/importUpload.test.ts`, `tests/fileStore.test.ts`, `tests/textExtract.test.ts`, `tests/decodeBytes.test.ts`, `tests/pipelineHandlers.test.ts`, `tests/jobStore.test.ts`, `tests/resolveFrameMember.test.ts`, `tests/frameAuth.test.ts`.
- **Агент:** `tests/runAgent.test.ts`, `tests/extractedDocument.test.ts`, `tests/extractPrompt.test.ts`, `tests/agent.test.ts`, `tests/agentSpawn.test.ts`, `tests/agentRetry.test.ts` (оркестрация, нормализация, санитайз env, `extractJson`, retry-политика, дедлайн-килл).
- **crm-sync:** `tests/crmSyncCore.test.ts`, `tests/server-crm.test.ts`, `tests/productLookup.test.ts`, `tests/vat.test.ts`, `tests/units.test.ts`, `tests/routing.test.ts`, `tests/chatNotify.test.ts`, `tests/queueHandlers.test.ts`, `tests/diskActivity.test.ts` (аборт без потери строк, идемпотентность, товары/единицы, нейтрализация BB, диск/дело-ядро).
- **Очереди:** `tests/queueConnection.test.ts`, `tests/queueStats.test.ts`, `tests/pipelineHandlers.test.ts`, `tests/queueHandlers.test.ts` (парсинг Redis-URL, агрегация счётчиков, порядок enqueue↔delete).
- **События Б24:** `tests/b24Events.test.ts` (скобочная форма, prototype-pollution, `safeEqual`, `decideB24Event`), `tests/server-glue.test.ts` (write-once `saveToken`, порядок `deletePortal`).
- **Настройки:** `tests/portalSettings.test.ts` (`parsePortalSettings`, edge entityTypeId/правил), `tests/appSettings.test.ts` (`readMapping`/`writeMapping`), `tests/frameAuth.test.ts`.
- **Авторизация:** `tests/session.test.ts` (HMAC подпись/проверка, timingSafeEqual, границы TTL), `tests/operatorSession.test.ts` (`operatorAllowed`/`opsTokenOk`).
- **Деплой:** `tests/build.test.ts` (`healthInfo`), `tests/envCheck.test.ts` (`checkBackendEnv` — ошибки/warnings/плейсхолдеры). CI-джобы `ci` и `docker-build` валидируют сборку на каждом PR.

Известные пробелы автопокрытия (кандидаты добавить): детерминизм `makeJobId`/`*JobId`; round-trip `secretCrypto` и `purgePortalFiles`; интеграционные тесты HTTP-роутов (`upload.post`/`status.get`/`events.post`/`settings.*` и `defineEventHandler`-обёртки) — сейчас проверяются только через чистые части и ручной curl.

## Дополнительные проверки (из ревизии полноты)

Пробелы, найденные при ревизии плана — приоритетные к добавлению (сейчас НЕ покрыты).

### Мультитенант-изоляция

| Проверка | Что проверить | Метка |
|---|---|---|
| Изоляция джобы по `member_id` | Джоба `agent-run`/`crm-sync` с подделанным/перепутанным `member_id` в payload пишет строго в свой портал (member_id в теле джобы — доверенный, негативного теста нет) | [вручную/нужен живой портал] |
| Скоуп ключа идемпотентности | Два портала с одинаковым файлом/документом НЕ схлопываются в одну запись (`makeJobId`/`getExisting`/`job_result`/`import_doc` — кросс-портальная коллизия дедупа) | [авто-кандидат] |
| Uninstall при in-flight | После `deletePortal` оставшиеся в Redis джобы портала не пишут в CRM и не висят в ретраях; байты активных загрузок вычищаются (не только по событию) | [вручную] |

### Rate-limit / DoS / стоимость

| Проверка | Что проверить | Метка |
|---|---|---|
| Квота на `/api/import/upload` | Аутентифицированный upload сейчас без лимита на портал → флуд грузит pipeline; ввести/проверить квоту | [вручную] |
| Cost-DoS на LLM | Нет лимита на число документов, уходящих в агент на портал → расход провайдерского ключа | [нужен LLM-ключ] |
| Диск/сироты | `saveUpload` при полном диске; сирота-файл при краше воркера между save и extract | [вручную] |
| Батч B24 REST | `crm.item.productrow.set` при `items` > 50 строк — корректность батчинга | [нужен живой портал] |

### Секреты / OAuth

| Проверка | Что проверить | Метка |
|---|---|---|
| Утечка токенов | `job_result` (JSON `done`), сообщения об ошибках в чат/логи НЕ содержат access/refresh-токенов и, где не нужно, домена | [авто-кандидат] |
| Маскирование в логах | OAuth-токены маскируются в логах старта/ошибок | [вручную] |
| Протухший refresh | Отзыв/протухание refresh при живой джобе → job error, а не бесконечный ретрай | [нужен живой портал] |
| Гонка refresh | Конкурентный refresh двумя воркерами (запись в token store) без потери токена | [вручную] |

### Инъекции / заголовки

| Проверка | Что проверить | Метка |
|---|---|---|
| SQL-инъекция | Негативный тест инъекции через `member_id` / `X-B24-Domain` / содержимое документа (параметризация заявлена) | [авто-кандидат] |
| Framing служебных страниц | `/login`, `/queues` нельзя встроить в чужой iframe (X-Frame-Options/frame-ancestors); in-portal-страницы фреймить B24 — можно | [вручную] |
| Инъекция в поля CRM | Нейтрализация значений из документа (supplier/name) для REST-полей CRM (сейчас проверена только для чата, BB) | [нужен живой портал] |

### Конкуррентность / прочее

| Проверка | Что проверить | Метка |
|---|---|---|
| Параллельная обработка джобы | Идемпотентность под параллелизмом (два воркера, один jobId), а не только последовательный повтор | [вручную] |
| Атомарность create↔recordResult | Дубль-загрузка под конкуренцией не создаёт две сущности | [нужен живой портал] |
| Cookie в dev без HTTPS | Флаг `Secure` → кука не ставится по HTTP; поведение входа оператора в dev | [вручную] |
| Эндпоинт метрик | `metrics_counter` не отдаётся неаутентифицированным эндпоинтом | [вручную] |
