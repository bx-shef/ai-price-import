// Проба горизонтального переполнения на узком экране (#523).
//
// ЗАЧЕМ ОТДЕЛЬНЫЙ СКРИПТ. Правило проекта — «никакой горизонтальной прокрутки; длинные строки
// переносятся, а не обрезаются в никуда». Нарушение этого правила НЕ ВИДНО ни в тестах (шаблон
// разметки корректен), ни на скриншоте с первого взгляда: страница не прокручивается, она просто
// обрезает содержимое по краю, и на снимке это читается как «текст вылезает».
//
// Так и был найден дефект, ради которого скрипт написан: внутренний контейнер `B24PageCard` объявлен
// `flex flex-col flex-1` БЕЗ `min-w-0`, а флекс-элемент по умолчанию не может стать уже своего
// содержимого. Одной длинной подписи выбранного значения хватало, чтобы карточка выросла до 518 px
// при экране 375 — вместе со всеми соседними абзацами. Правка — в `app/app.config.ts`.
//
// ⚠ Скрипт НИЧЕГО не чинит и ничего не утверждает про красоту: он отвечает на один вопрос — какой
// элемент задаёт ширину больше экрана. Приём: сузить подозреваемого до 300 px и посмотреть, кто из
// потомков всё равно шире. Это находит именно ВИНОВНИКА, а не всех, кто просто заполняет ширину.
//
//   pnpm generate && pnpm probe:overflow            # /settings и /metrics на 375 px
//   pnpm probe:overflow /app /import --width 320
import { chromium } from 'playwright-core'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveChromium } from './lib/chromium.mjs'
import { resolveSafePath } from './lib/staticPath.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const PUBLIC_DIR = join(ROOT, '.output', 'public')
const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.json': 'application/json', '.woff2': 'font/woff2', '.ico': 'image/x-icon'
}

const args = process.argv.slice(2)
const widthArg = args.indexOf('--width')
const WIDTH = widthArg === -1 ? 375 : Number(args[widthArg + 1]) || 375
// ⚠ Значение `--width` исключается ТОЛЬКО когда флаг есть: при `widthArg === -1` выражение
// `widthArg + 1` даёт 0, и первый переданный маршрут молча выпадал из списка.
const routes = args.filter((a, i) => a.startsWith('/') && (widthArg === -1 || i !== widthArg + 1))
const ROUTES = routes.length ? routes : ['/settings', '/metrics']

const server = createServer(async (req, res) => {
  // ⚠ Замок от обхода каталога — в общей чистой функции, а не строкой здесь. Пока он жил тут,
  // проверить его можно было только текстом, а текст не видит ИНВЕРСИИ: убери один `!` — и обход
  // отдаётся, а обычные пути получают 403. Разбор — в самом модуле.
  const filePath = resolveSafePath(PUBLIC_DIR, req.url || '/')
  if (filePath === null) {
    res.writeHead(403)
    res.end('forbidden')
    return
  }
  try {
    const body = await readFile(filePath)
    res.writeHead(200, { 'content-type': TYPES[extname(filePath)] || 'application/octet-stream' })
    res.end(body)
  } catch {
    res.writeHead(404)
    res.end('not found')
  }
})
// ⚠ Только петлевой адрес. Без хоста Node слушает 0.0.0.0, то есть на время прогона порт виден с
// любой машины, которая видит эту по сети (соседний контейнер, другая джоба раннера) — а отдаёт
// сервер файлы, доступные процессу. Порт эфемерный и в консоль не печатается, но это не защита.
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port

const browser = await chromium.launch({ executablePath: await resolveChromium() })
let offenders = 0
try {
  for (const route of ROUTES) {
    const page = await browser.newPage({ viewport: { width: WIDTH, height: 900 } })
    await page.goto(`http://127.0.0.1:${port}${route.endsWith('/') ? route : `${route}/`}`, { waitUntil: 'networkidle' })
    const found = await page.evaluate((vw) => {
      const wide = [...document.querySelectorAll('body *')].filter(el => el.getBoundingClientRect().width > vw + 1)
      const out = []
      for (const el of wide) {
        // Виновник — тот, кто шире СВОЕГО РОДИТЕЛЯ: остальные просто заполняют навязанную ширину.
        const parent = el.parentElement
        if (parent && el.getBoundingClientRect().width <= parent.getBoundingClientRect().width + 1) continue
        // Сузим виновника и посмотрим, кто внутри не даёт ему сжаться.
        const prev = el.style.width
        el.style.width = '300px'
        const stuck = [...el.querySelectorAll('*')]
          .filter(k => k.getBoundingClientRect().width > 320)
          .filter(k => ![...k.children].some(c => c.getBoundingClientRect().width > 320))
          .slice(0, 3)
          .map(k => ({ tag: k.tagName.toLowerCase(), cls: (k.className || '').toString().slice(0, 80), text: (k.textContent || '').trim().slice(0, 45) }))
        el.style.width = prev
        out.push({
          tag: el.tagName.toLowerCase(),
          cls: (el.className || '').toString().slice(0, 80),
          width: Math.round(el.getBoundingClientRect().width),
          stuck
        })
      }
      return { scrollWidth: document.documentElement.scrollWidth, out: out.slice(0, 8) }
    }, WIDTH)
    await page.close()

    if (!found.out.length) {
      console.log(`\x1b[32m✓\x1b[0m ${route} @ ${WIDTH}px — ничего не выходит за экран`)
      continue
    }
    offenders += found.out.length
    console.error(`\x1b[31m✗\x1b[0m ${route} @ ${WIDTH}px — шире экрана:`)
    for (const o of found.out) {
      console.error(`   ${o.tag}.${o.cls} → ${o.width}px`)
      for (const s of o.stuck) console.error(`     не даёт сжаться: ${s.tag}.${s.cls} «${s.text}»`)
    }
  }
} finally {
  await browser.close()
  server.close()
}
process.exitCode = offenders ? 1 : 0
