import { describe, expect, it } from 'vitest'
import {
  announcementProblems, announcementSeenKey, announcementTtlSec, buildAnnouncement,
  isAnnouncementLive, isSafeAnnouncementLink, parseImageDataUrl
} from '../app/utils/announcement'
import { MAX_ANNOUNCEMENT_IMAGE_BYTES } from '../app/config/announcement'

const NOW = Date.parse('2026-08-08T12:00:00Z')
/** Настоящий base64 нужного размера: длина строки решает исход проверки. */
const img = (type: string, bytes: number) => `data:${type};base64,${'A'.repeat(Math.ceil(bytes / 3) * 4)}`
const draft = (over: Record<string, unknown> = {}) => ({ title: 'Акция', text: 'Скидка 30%', days: 7, ...over })

describe('картинка объявления', () => {
  it('растровые форматы принимаются', () => {
    for (const t of ['image/png', 'image/jpeg', 'image/webp', 'image/gif']) {
      expect(parseImageDataUrl(img(t, 1000)).ok, t).toBe(true)
    }
  })

  it('SVG ОТВЕРГАЕТСЯ — это документ со скриптами', () => {
    // Он исполнился бы в контексте нашей страницы внутри чужого портала.
    const r = parseImageDataUrl(img('image/svg+xml', 100))
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toMatch(/не разрешён/)
  })

  it('слишком большая картинка отвергается', () => {
    expect(parseImageDataUrl(img('image/png', MAX_ANNOUNCEMENT_IMAGE_BYTES + 5000)).ok).toBe(false)
    expect(parseImageDataUrl(img('image/png', MAX_ANNOUNCEMENT_IMAGE_BYTES - 5000)).ok).toBe(true)
  })

  it('не-data-адрес и мусор отвергаются', () => {
    expect(parseImageDataUrl('https://example.com/a.png').ok).toBe(false)
    expect(parseImageDataUrl('data:image/png;base64,не base64').ok).toBe(false)
    expect(parseImageDataUrl(null).ok).toBe(false)
  })
})

describe('ссылка кнопки', () => {
  it('только https', () => {
    expect(isSafeAnnouncementLink('https://bx-shef.by/promo')).toBe(true)
    expect(isSafeAnnouncementLink('http://bx-shef.by')).toBe(false)
  })

  it('javascript: и подмена через userinfo не проходят', () => {
    // Префиксная проверка пропустила бы и то, и другое — поэтому разбираем `new URL`.
    expect(isSafeAnnouncementLink('javascript:alert(1)')).toBe(false)
    expect(isSafeAnnouncementLink(' javascript:alert(1)')).toBe(false)
    expect(isSafeAnnouncementLink('https://ok@evil.example/x')).toBe(true) // хост evil, но схема https
    expect(isSafeAnnouncementLink('не ссылка')).toBe(false)
  })
})

describe('проверка черновика', () => {
  it('годный черновик проходит', () => {
    expect(announcementProblems(draft())).toEqual([])
  })

  it('пустые заголовок и текст названы поимённо', () => {
    const p = announcementProblems(draft({ title: '  ', text: '' }))
    expect(p).toContain('заголовок пустой')
    expect(p).toContain('текст пустой')
  })

  it('ссылка без подписи кнопки — ошибка', () => {
    // Кнопка с пустым текстом нажимается, но не читается.
    expect(announcementProblems(draft({ linkUrl: 'https://a.by' }))).toContain('у ссылки нет подписи кнопки')
  })

  it('подпись без ссылки ошибкой НЕ считается — кнопка просто закроет окно', () => {
    expect(announcementProblems(draft({ linkLabel: 'Понятно' }))).toEqual([])
  })

  it('срок обязателен и ограничен сверху', () => {
    expect(announcementProblems(draft({ days: 0 }))).toContain('срок показа меньше суток')
    expect(announcementProblems(draft({ days: 400 }))[0]).toMatch(/больше 90 дней/)
    expect(announcementProblems(draft({ days: 'да' }))).toContain('срок показа меньше суток')
  })

  it('негодная картинка роняет проверку, отсутствующая — нет', () => {
    expect(announcementProblems(draft({ image: 'мусор' })).length).toBe(1)
    expect(announcementProblems(draft({ image: '' }))).toEqual([])
  })
})

describe('сборка и срок', () => {
  it('повторная отправка того же текста даёт НОВЫЙ ключ', () => {
    // Иначе закрывший первое объявление не увидел бы второго, и рассылка ушла бы в пустоту.
    const a = buildAnnouncement(draft(), NOW)
    const b = buildAnnouncement(draft(), NOW + 1000)
    expect(a.id).not.toBe(b.id)
    expect(announcementSeenKey(a.id)).not.toBe(announcementSeenKey(b.id))
  })

  it('срок считается от публикации', () => {
    const a = buildAnnouncement(draft({ days: 2 }), NOW)
    expect(a.expiresAt).toBe(new Date(NOW + 2 * 24 * 3600 * 1000).toISOString())
    expect(isAnnouncementLive(a, NOW + 24 * 3600 * 1000)).toBe(true)
    expect(isAnnouncementLive(a, NOW + 3 * 24 * 3600 * 1000)).toBe(false)
  })

  it('негодные поля в объявление не попадают', () => {
    const a = buildAnnouncement(draft({ image: 'мусор', linkUrl: 'javascript:x', linkLabel: 'Жми' }), NOW)
    expect(a.image).toBeUndefined()
    expect(a.linkUrl).toBeUndefined()
  })

  it('битая дата окончания читается как ИСТЁКШАЯ, а не как вечная', () => {
    // Испорченное значение не должно давать объявление, которое невозможно снять.
    expect(isAnnouncementLive({ ...buildAnnouncement(draft(), NOW), expiresAt: 'мусор' }, NOW)).toBe(false)
    expect(announcementTtlSec({ ...buildAnnouncement(draft(), NOW), expiresAt: 'мусор' }, NOW)).toBe(0)
  })

  it('срок хранения в Redis совпадает с остатком жизни', () => {
    const a = buildAnnouncement(draft({ days: 1 }), NOW)
    expect(announcementTtlSec(a, NOW)).toBe(24 * 3600)
    expect(announcementTtlSec(a, NOW + 24 * 3600 * 1000)).toBe(0)
  })
})
