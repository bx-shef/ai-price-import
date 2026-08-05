import { readFileSync } from 'node:fs'

// Чтение значения из git-ignored `.env`-файла для живых скриптов.
//
// ⚠ Копий этой функции было ЧЕТЫРЕ (`live-crm-sync`, `sdk-smoke`, `verify-332-live`,
// `verify-idempotency-live`) плюс своя в `testPortal.readHook`, и они разъехались — а разъезд
// здесь не косметика, потому что читается адрес портала и токены:
//   • `verify-idempotency-live` не снимал кавычки вовсе (`startsWith(key + '=')` + `slice`), то
//     есть обычное для `.env` написание `B24_TEST_WEBHOOK="https://…/"` давало адрес с кавычкой
//     внутри — REST отвечал невнятно, и выглядело это поломкой портала, а не парсера;
//   • три копии брали ПЕРВОЕ вхождение, `readHook` — ПОСЛЕДНЕЕ (семантика dotenv). Дописав новый
//     адрес в конец файла, разработчик продолжал ходить на прежний портал одними скриптами и на
//     новый — другими. Это худший из исходов: часть проверок зелена, часть красна, и обе врут;
//   • `export KEY=…` не понимала ни одна.
//
// Здесь — одно поведение: последнее вхождение, снятие кавычек, поддержка `export`.

/**
 * Значение переменной из `.env`-файла.
 *
 * @param {string} file путь к файлу
 * @param {string} key имя переменной
 * @param {{ required?: boolean }} [opts] `required:false` → пустая строка вместо броска
 * @returns {string}
 */
export function readEnvValue(file, key, opts = {}) {
  const required = opts.required !== false
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    if (required) throw new Error(`${file} не найден`)
    return ''
  }
  // ⚠ `[ \t]*`, не `\s*`: `\s` включает перевод строки, и «якорь на начало строки» перестал бы
  // быть правдой. Якорь нужен, чтобы закомментированный `#KEY=старый` и переменная, ЗАКАНЧИВАЮЩАЯСЯ
  // на `KEY`, не подхватывались: и то и другое молча увело бы прогон на прежний портал.
  const re = new RegExp(`^[ \\t]*(?:export[ \\t]+)?${key}=(.*)$`, 'gm')
  let value = null
  for (const m of text.matchAll(re)) value = m[1]
  if (value === null || value.trim() === '') {
    if (required) throw new Error(`${key} не задан в ${file}`)
    return ''
  }
  return value.trim().replace(/^["']|["']$/g, '')
}
