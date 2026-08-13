// @vitest-environment nuxt
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ANNOUNCEMENT_PULL_COMMAND } from '~/utils/announcementPull'
import { SETTINGS_RELOAD_COMMAND } from '~/utils/settingsSync'

// #478, проводка живого сигнала. Чистое ядро рассылки покрыто отдельно, и этого не хватает: разбор
// перечислил мутации, которые проходили НЕЗАМЕЧЕННЫМИ, и каждая ломает ровно то, ради чего PR
// делался, — подписаться не на ту команду, забыть вызов проверки, выбросить подписку целиком.

const code = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8')
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/^\s*\/\/.*$/gm, '')

describe('#478: подписка на СВОЮ команду', () => {
  it('команды объявления и настроек — разные', () => {
    // ⚠ Одна команда на оба означала бы поход за настройками на каждое объявление и поход за
    // объявлением на каждое сохранение настроек — удвоение обращений к нашему серверу.
    expect(ANNOUNCEMENT_PULL_COMMAND).not.toBe(SETTINGS_RELOAD_COMMAND)
  })

  it('`subscribeAnnouncement` подписана на команду ОБЪЯВЛЕНИЯ, а не настроек', () => {
    // ⚠ Мутация «подставить сюда команду настроек» ловится только так: снаружи обе подписки
    // выглядят одинаково живыми, а реагировать начнут на чужое событие — объявление на сохранение
    // настроек и наоборот.
    const src = code('../../app/composables/useSettingsSync.ts')
    const fn = src.split('function subscribeAnnouncement')[1]?.split('\n  }')[0] ?? ''
    expect(fn, 'функция не найдена — переименовали').not.toBe('')
    expect(fn).toContain('ANNOUNCEMENT_PULL_COMMAND')
    expect(fn).not.toContain('SETTINGS_RELOAD_COMMAND')
  })

  it('клиент pull ОДИН на композабл, а не по одному на подписку', () => {
    // ⚠ Первая редакция строила свой клиент в каждой подписке: на рабочем экране, где подписаны оба
    // канала, это давало ДВА websocket-соединения к одной трубе портала.
    const src = code('../../app/composables/useSettingsSync.ts')
    expect(src.match(/new B24PullClientManager/g) ?? [], 'клиент строится больше одного раза').toHaveLength(1)
  })

  it('строка отказа называет КАНАЛ, а не «настройки»', () => {
    // ⚠ Пока труба обслуживала один механизм, захардкоженный текст был верен. С появлением второго
    // отказ подписки на объявление писал бы «недоступно обновление настроек» — уводил бы отладку к
    // другому механизму.
    const src = code('../../app/composables/useSettingsSync.ts')
    expect(src).not.toContain('живое обновление настроек недоступно')
    expect(src).toContain('${channel}')
  })
})

describe('#478: диалог реагирует на сигнал', () => {
  const dialog = () => code('../../app/components/AnnouncementDialog.vue')

  it('подписка заведена и ВЫЗЫВАЕТ повторную проверку', () => {
    // ⚠ Мутация «забыть скобки» (`void check` вместо `void check()`) внешне неотличима: событие
    // придёт, подписка жива, а проверки не будет.
    // ⚠ Имя стало `live.check()` (#473 п.4): композабл берётся целиком, чтобы предпросмотр мог его
    // НЕ трогать. Проверяем вызов, а не прежнее написание.
    const src = dialog()
    expect(src).toContain('subscribeAnnouncement(')
    expect(src).toMatch(/void live\.check\(\)/)
  })

  it('запрос идёт с разбросом, а не мгновенно у всех разом', () => {
    // ⚠ Сигнал получают ВСЕ сотрудники ВСЕХ порталов одновременно, и запрос за объявлением не
    // бесплатный: он проверяет фрейм-токен, то есть идёт в базу и делает исходящий вызов к порталу.
    // Без разброса штатная публикация сама себе устраивала бы всплеск на самом дорогом пути.
    expect(dialog()).toContain('ANNOUNCEMENT_CHECK_JITTER_MS')
  })

  it('показ при открытии экрана ОСТАЁТСЯ — сигнал его не заменяет', () => {
    // ⚠ Несущее свойство страховки: механизм pull вживую не проверен ни разу, и если канал мёртв,
    // поведение обязано остаться ровно прежним.
    const src = dialog()
    const beforeSubscribe = src.split('subscribeAnnouncement(')[0] ?? ''
    expect(beforeSubscribe, 'проверка при монтировании исчезла').toMatch(/void live\.check\(\)/)
  })
})
