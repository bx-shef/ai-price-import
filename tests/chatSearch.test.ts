import { describe, expect, it, vi } from 'vitest'
import {
  chatDialogId,
  normalizeChatSearch,
  normalizeRecentChats,
  searchChats,
  CHAT_SEARCH_LIMIT,
  CHAT_RECENT_LIMIT
} from '../server/utils/chatSearch'

describe('chatDialogId', () => {
  it('builds chat<id> for a positive integer (number or numeric string)', () => {
    expect(chatDialogId(42)).toBe('chat42')
    expect(chatDialogId('42')).toBe('chat42')
  })
  it('rejects non-positive / non-integer / non-numeric ids', () => {
    expect(chatDialogId(0)).toBeNull()
    expect(chatDialogId(-1)).toBeNull()
    expect(chatDialogId(1.5)).toBeNull()
    expect(chatDialogId('abc')).toBeNull()
    expect(chatDialogId(undefined)).toBeNull()
    expect(chatDialogId(null)).toBeNull()
  })
})

describe('normalizeChatSearch (im.search.chat.list → array)', () => {
  it('maps rows to { value: chat<id>, label: name }', () => {
    const out = normalizeChatSearch([
      { id: 10, name: 'Отдел продаж' },
      { id: 11, name: 'Бухгалтерия' }
    ])
    expect(out).toEqual([
      { value: 'chat10', label: 'Отдел продаж' },
      { value: 'chat11', label: 'Бухгалтерия' }
    ])
  })
  it('excludes chats that forbid sending (restrictions.send === false)', () => {
    const out = normalizeChatSearch([
      { id: 10, name: 'Можно', restrictions: { send: true } },
      { id: 11, name: 'Нельзя', restrictions: { send: false } }
    ])
    expect(out).toEqual([{ value: 'chat10', label: 'Можно' }])
  })
  it('drops rows without a usable id or a non-empty title', () => {
    const out = normalizeChatSearch([
      { id: 0, name: 'BadId' },
      { id: 12, name: '   ' },
      { id: 13, name: 'Хороший' }
    ])
    expect(out).toEqual([{ value: 'chat13', label: 'Хороший' }])
  })
  it('returns [] for a non-array result (defensive)', () => {
    expect(normalizeChatSearch(null)).toEqual([])
    expect(normalizeChatSearch({ items: [] })).toEqual([])
  })
})

describe('normalizeRecentChats (im.recent.list → object.items)', () => {
  it('maps group chats via chat_id (fallback id), title', () => {
    const out = normalizeRecentChats({ items: [
      { type: 'chat', chat_id: 20, title: 'Группа' },
      { type: 'chat', id: 21, title: 'Другая' }
    ] })
    expect(out).toEqual([
      { value: 'chat20', label: 'Группа' },
      { value: 'chat21', label: 'Другая' }
    ])
  })
  it('drops 1-1 user dialogs (type === user)', () => {
    const out = normalizeRecentChats({ items: [
      { type: 'user', id: 5, title: 'Иван' },
      { type: 'chat', chat_id: 20, title: 'Группа' }
    ] })
    expect(out).toEqual([{ value: 'chat20', label: 'Группа' }])
  })
  it('returns [] when items is absent or the result is not an object', () => {
    expect(normalizeRecentChats({})).toEqual([])
    expect(normalizeRecentChats(null)).toEqual([])
  })
})

describe('searchChats', () => {
  it('query ≥3 chars → im.search.chat.list (FIND + limit), single page', async () => {
    const call = vi.fn(async () => [{ id: 30, name: 'Найдено' }])
    const page = await searchChats(call, 'про')
    expect(call).toHaveBeenCalledWith('im.search.chat.list', { FIND: 'про', OFFSET: 0, LIMIT: CHAT_SEARCH_LIMIT })
    expect(page).toEqual({ items: [{ value: 'chat30', label: 'Найдено' }], hasMore: false })
  })
  it('empty / short query → im.recent.list (SKIP_DIALOG=Y), single page', async () => {
    const call = vi.fn(async () => ({ items: [{ type: 'chat', chat_id: 40, title: 'Недавний' }] }))
    const page = await searchChats(call, '')
    expect(call).toHaveBeenCalledWith('im.recent.list', { SKIP_DIALOG: 'Y', OFFSET: 0, LIMIT: CHAT_RECENT_LIMIT })
    expect(page).toEqual({ items: [{ value: 'chat40', label: 'Недавний' }], hasMore: false })
  })
  it('trims the query before the ≥3 gate (2 real chars after trim → recent)', async () => {
    const call = vi.fn(async () => ({ items: [] }))
    await searchChats(call, '  ab  ')
    expect(call).toHaveBeenCalledWith('im.recent.list', expect.objectContaining({ SKIP_DIALOG: 'Y' }))
  })
  it('propagates a REST error (route maps it to a status)', async () => {
    const call = vi.fn(async () => {
      throw new Error('QUERY_LIMIT_EXCEEDED')
    })
    await expect(searchChats(call, 'продажи')).rejects.toThrow('QUERY_LIMIT_EXCEEDED')
  })
})
