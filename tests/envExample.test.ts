import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// `.env.example` — файл, который копируют целиком. Отсюда ловушка (#305): docker compose считает
// `KEY=` ЗАДАННЫМ пустым значением и перебивает им умолчание. Для ключа, у которого умолчание
// непустое, скопированный пример молча ломает работающую вещь: так прод показывал версию «dev»
// (перебит запечённый в образ sha), а форма заявки на лендинге переставала существовать.
//
// Тест выводит список опасных ключей ИЗ КОДА (`nuxt.config.ts`), а не из своего списка — иначе он
// устарел бы на первом же новом ключе с умолчанием.

const ROOT = new URL('..', import.meta.url).pathname
const read = (p: string) => readFileSync(ROOT + p, 'utf8')

/** Ключи вида `process.env.NUXT_PUBLIC_X || 'непустое'` — умолчание есть, пустое значение его убьёт. */
function keysWithNonEmptyDefault(config: string): string[] {
  const out = new Set<string>()
  for (const m of config.matchAll(/process\.env\.(NUXT_PUBLIC_[A-Z0-9_]+)\s*\|\|\s*'([^']+)'/g)) {
    if (m[1] && m[2]) out.add(m[1])
  }
  return [...out]
}

/** Ключи, присвоенные в примере пустыми (`KEY=` на отдельной строке, не в комментарии). */
function bareEmptyKeys(env: string): Set<string> {
  const out = new Set<string>()
  for (const line of env.split('\n')) {
    const m = /^([A-Z0-9_]+)=\s*$/.exec(line.trim())
    if (m?.[1]) out.add(m[1])
  }
  return out
}

describe('.env.example не гасит непустые умолчания (#305)', () => {
  it('ни один ключ с непустым умолчанием не присвоен пустым', () => {
    const dangerous = keysWithNonEmptyDefault(read('nuxt.config.ts'))
    // Сам разбор должен что-то находить — иначе тест «зелен» просто потому, что ничего не нашёл.
    expect(dangerous.length).toBeGreaterThan(0)
    const empty = bareEmptyKeys(read('.env.example'))
    expect(dangerous.filter(k => empty.has(k))).toEqual([])
  })

  it('sha сборки не задаётся в примере — он запекается в образ', () => {
    // Отдельным правилом: умолчание живёт в runtimeConfig (`commitSha: \'dev\'`), а не в
    // `process.env.… || …`, поэтому разбором выше не ловится.
    expect(bareEmptyKeys(read('.env.example')).has('NUXT_PUBLIC_COMMIT_SHA')).toBe(false)
    expect(read('.env.example')).not.toMatch(/^NUXT_PUBLIC_COMMIT_SHA=/m)
  })
})
