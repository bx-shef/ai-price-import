import { join, normalize, sep } from 'node:path'

/**
 * Resolve a request path inside the build output, or `null` when it escapes.
 *
 * ЗАЧЕМ ОТДЕЛЬНЫЙ МОДУЛЬ. Два скрипта поднимают локальный сервер над `.output/public` — снимки
 * (`screenshot.mjs`) и проба переполнения (`probe-overflow.mjs`). Замок был скопирован в оба руками,
 * и во второй копии его сначала не оказалось вовсе: сырой запрос `GET /../../../../etc/passwd`
 * отдавал файл с кодом 200 (через `fetch` и `curl` это НЕ воспроизводится — они схлопывают `..` на
 * своей стороне, поэтому «не воспроизвелось» тут читается как «уязвимости нет»).
 *
 * ⚠ Но главное не в дублировании. Пока замок жил строкой внутри обработчика, проверить его можно
 * было только текстом — «в исходнике есть `startsWith(PUBLIC_DIR + sep)`». Такая проверка не видит
 * ИНВЕРСИИ: убрать один символ `!` — и безопасные пути получают 403, а обход каталога отдаётся.
 * Гард оставался зелёным, то есть сторожил написание, а не смысл. Вынесенная чистая функция
 * проверяется ПОВЕДЕНИЕМ, и инверсия падает сразу.
 *
 * ⚠ `normalize` до `join`: `path.join` нормализует РЕЗУЛЬТАТ, поэтому `..` из адреса уводит выше
 * базы ещё до проверки. Сравнение с `PUBLIC_DIR + sep` — второй слой: он ловит и то, что нормализация
 * пропустила бы, и соседний каталог с общим префиксом имени (`/out/public-old`).
 */
export function resolveSafePath(publicDir, rawPath) {
  const decoded = safeDecode(rawPath)
  if (decoded === null) return null
  const path = decoded.endsWith('/') ? `${decoded}index.html` : decoded
  const full = join(publicDir, normalize(path))
  if (full !== publicDir && !full.startsWith(publicDir + sep)) return null
  return full
}

/** Percent-decode that doesn't throw: битая последовательность — это отказ, а не падение сервера. */
function safeDecode(rawPath) {
  const path = String(rawPath ?? '/').split('?')[0]
  try {
    return decodeURIComponent(path)
  } catch {
    return null
  }
}
