/**
 * Документ, присланный БРАУЗЕРОМ, для отзыва об упавшем импорте (#506 п.3).
 *
 * ЗАЧЕМ ВТОРОЙ ИСТОЧНИК. Обычный отзыв берёт документ ИЗ ВЛОЖЕНИЯ ДЕЛА (#461) — надёжнее некуда:
 * сервер сам находит дело по маркеру задания и читает байты, странице верить не нужно. Но здесь
 * импорт упал ДО того, как что-то попало в CRM: дела нет, вложения нет, и брать неоткуда. Мы теряли
 * документ ровно в том случае, когда он нужнее всего — без битого файла воспроизвести нечего.
 *
 * ⚠ Это НЕ откат к #349 (когда байты возил браузер всегда). Путь через дело остаётся основным, а
 * этот включается ТОЛЬКО когда дела нет. Приоритет важен: дело — источник, проверенный сервером,
 * а тело запроса контролирует клиент.
 *
 * ⚠ Пределы и приватность ПЕРЕИСПОЛЬЗУЮТСЯ, а не изобретаются: тот же кап размера, тот же общий
 * предел приёмника (#354) и та же обязательная проба приватности (#200) — вердикт трёхзначный,
 * «не удалось проверить» запрещает так же, как «публичный». Иначе опечатка в имени приёмника
 * опубликовала бы реальный счёт клиента.
 */

/**
 * Что прислал браузер. Имя — для человека в приёмнике, байты — base64 внутри JSON.
 *
 * ⚠ Поля намеренно `unknown`: форму тела запроса роут не валидирует, и это осознанно — проверка
 * живёт ЗДЕСЬ, в одном месте с пределами. Пришедшее не объектом даёт `undefined` и обычный промах,
 * а не исключение.
 */
export interface UploadedDoc {
  name?: unknown
  contentBase64?: unknown
}

export interface UploadAttachDeps {
  /** Приёмник подтверждён приватным? Спрашивается ДО загрузки байт (#200). */
  uploadAllowed: () => Promise<boolean>
  /** Общий часовой предел приёмника (#354). */
  checkBudget: () => Promise<{ allowed: boolean, notice?: string }>
  /** Положить байты в приёмник; возвращает адрес файла. */
  commit: (name: string, base64: string) => Promise<string | null>
  maxBytes: number
  /** Текст «отзыв принят, но документ не приложен» — общий для всех причин промаха. */
  missingNotice: string
  /** Куда сообщить КЛАСС промаха (без имени файла — это данные клиента). */
  logMiss?: (miss: string) => void
}

export interface UploadAttachResult {
  fileUrl?: string
  notice?: string
}

/**
 * Законен ли второй источник документа — байты из тела запроса (#506 п.3).
 *
 * ⚠ Вынесено в чистую функцию НЕ ради красоты: внутри `defineEventHandler` это условие было
 * недостижимо тестом, и сторожил его грep по исходнику — а такой гард ловит только удаление строки.
 * Проверяющие показали, что первая редакция условия (`!fileUrl`) вообще не была границей: она
 * истинна и когда дело есть, но не скачалось, и когда `jobId` не прислали вовсе. Теперь решение
 * проверяется поведением.
 *
 * ⚠ Несущее: `miss === 'no-activity'` — это вердикт СЕРВЕРА, сходившего в портал и не нашедшего
 * дела. Любой другой промах значит «дело, возможно, есть» и байтам из тела хода не даёт.
 */
export function shouldAcceptUploadedDoc(state: {
  attachFile: boolean
  fileUrl?: string
  miss?: string
  hasUpload: boolean
}): boolean {
  return state.attachFile && !state.fileUrl && state.miss === 'no-activity' && state.hasUpload
}

/** Сколько знаков имени переносим в приёмник. Длинное имя ничего не добавляет к разбору. */
export const MAX_UPLOAD_NAME = 120

/**
 * Безопасное имя файла для приёмника.
 *
 * ⚠ Имя приходит от клиента и становится ЧАСТЬЮ ПУТИ в репозитории: без чистки `../` увёл бы файл
 * из каталога портала, а слэш создал бы вложенные папки. Оставляем буквы, цифры, точку, дефис и
 * подчёркивание; всё прочее — в подчёркивание.
 */
export function safeUploadName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.trim() : ''
  if (!name) return 'document.bin'
  const flat = name.replace(/[\\/]+/g, '_').replace(/\.{2,}/g, '.')
  const cleaned = flat.replace(/[^\p{L}\p{N}._-]+/gu, '_').replace(/^[._]+/, '')
  // ⚠ Режем ПО СИМВОЛАМ, а не `slice` по единицам UTF-16 (урок #346): срез посреди суррогатной пары
  // даёт битую строку, которая дальше молча ломает кодирование пути в приёмнике.
  return [...(cleaned || 'document.bin')].slice(0, MAX_UPLOAD_NAME).join('')
}

/**
 * Размер декодированных байт по длине base64 — БЕЗ декодирования.
 *
 * ⚠ Считаем до `Buffer.from`, а не после: декодировать сперва означало бы развернуть в память
 * ровно то, что мы собираемся отвергнуть за размер.
 */
export function base64Bytes(b64: string): number {
  const len = b64.length
  if (!len) return 0
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((len * 3) / 4) - pad)
}

/** Похоже ли это на base64 вообще. Мусор отвергаем до проб и пределов — он их только тратит. */
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/

/**
 * Приложить документ, присланный браузером.
 *
 * ⚠ Порядок проверок несущий и стоит именно так: форма → размер → приватность приёмника → общий
 * предел → загрузка. Дешёвое и локальное раньше дорогого и внешнего; проба приватности — ДО любой
 * отправки байт, предел приёмника — до неё же, чтобы отвергнутый по размеру файл не тратил чужую
 * квоту.
 * ⚠ Ошибки не выбрасываются: отзыв ценнее вложения и обязан уйти в любом случае. Промах называется
 * человеку — молчание читалось бы как «документ ушёл».
 */
export async function attachUploadedDoc(doc: UploadedDoc | null | undefined, deps: UploadAttachDeps): Promise<UploadAttachResult> {
  try {
    const b64 = typeof doc?.contentBase64 === 'string' ? doc.contentBase64.trim() : ''
    if (!b64 || !BASE64_RE.test(b64)) {
      deps.logMiss?.('no-bytes')
      return { notice: deps.missingNotice }
    }
    if (base64Bytes(b64) > deps.maxBytes) {
      deps.logMiss?.('too-big')
      return { notice: deps.missingNotice }
    }
    if (!(await deps.uploadAllowed())) {
      deps.logMiss?.('receiver-not-private')
      return { notice: deps.missingNotice }
    }
    const budget = await deps.checkBudget()
    if (!budget.allowed) return { notice: budget.notice ?? deps.missingNotice }

    const url = await deps.commit(safeUploadName(doc?.name), b64)
    if (!url) {
      deps.logMiss?.('commit-failed')
      return { notice: deps.missingNotice }
    }
    return { fileUrl: url }
  } catch {
    deps.logMiss?.('upload-error')
    return { notice: deps.missingNotice }
  }
}
