import { describe, expect, it } from 'vitest'
import { isMissingTargetError } from '../server/utils/targetFallback'

// #492. Функция решает, попадёт документ в CRM запасной сделкой или задание упадёт. Ошибка в сторону
// «упало» стоит повтора; ошибка в сторону «создали» стоит НЕОБРАТИМОЙ карточки в чужой воронке
// клиента, о которой никто не узнает. Отсюда закрытый разрешающий список и тесты ниже.

/** Ошибка в том виде, в каком её бросает наш SDK-транспорт: код и статус отдельными полями. */
const rest = (code: string, text: string, status?: number) =>
  Object.assign(new Error(`${code}: ${text}`), { portalCode: code, portalStatus: status })

describe('isMissingTargetError: решение по машинному коду', () => {
  it.each([
    ['ENTITY_TYPE_NOT_SUPPORTED', true],
    ['CRM_ENTITY_TYPE_NOT_FOUND', true],
    ['ERROR_ENTITY_TYPE_NOT_SUPPORTED', true],
    ['QUERY_LIMIT_EXCEEDED', false],
    ['ACCESS_DENIED', false],
    ['INVALID_ARG_VALUE', false]
  ])('%s → %s', (code, expected) => {
    expect(isMissingTargetError(rest(code, 'что-то'))).toBe(expected)
  })

  it('NOT_FOUND — единственный неоднозначный код: решает текст', () => {
    // По справочнику `crm.item.add` отвечает так на удалённый смарт-процесс — головной случай #488.
    // Голый же NOT_FOUND портал отдаёт на товар, компанию, стадию и файл на Диске.
    expect(isMissingTargetError(rest('NOT_FOUND', 'Смарт-процесс не найден'))).toBe(true)
    expect(isMissingTargetError(rest('NOT_FOUND', 'Товар не найден'))).toBe(false)
    expect(isMissingTargetError(rest('NOT_FOUND', ''))).toBe(false)
  })

  it('401/403 отвергаются даже с «подходящим» кодом — права важнее', () => {
    expect(isMissingTargetError(rest('ENTITY_TYPE_NOT_SUPPORTED', 'нет доступа', 403))).toBe(false)
    expect(isMissingTargetError(rest('ENTITY_TYPE_NOT_SUPPORTED', 'нет доступа', 401))).toBe(false)
  })
})

describe('isMissingTargetError: текст документа не управляет решением (#416-урок)', () => {
  // ⚠ Несущая проверка PR. В `crm.item.add` уходит `title` = имя поставщика ИЗ ДОКУМЕНТА (или имя
  // загруженного файла), и портал вправе процитировать поле в описании ошибки. Если бы решение
  // принималось по тексту, поставщик «ООО not supported» уводил бы чужой документ в запасную сделку
  // вместо честного отказа — и мы бы этого не заметили.
  it('код есть ⇒ текст не смотрим вовсе, даже если он идеально подходит', () => {
    const err = rest('QUERY_LIMIT_EXCEEDED', 'Поле title: ООО «not supported» — сущность CRM не поддерживается')
    expect(isMissingTargetError(err), 'решение обязано принимать код, а не строка из накладной').toBe(false)
  })

  it('код есть и он подходит ⇒ да, независимо от постороннего текста', () => {
    expect(isMissingTargetError(rest('ENTITY_TYPE_NOT_SUPPORTED', 'ООО «Ромашка»'))).toBe(true)
  })
})

describe('isMissingTargetError: запасной путь по тексту, когда кода нет', () => {
  // Не-SDK транспорт, сетевой сбой и старые тесты кода не несут. Путь слабее и потому стоит вторым.
  it.each([
    ['Сущность CRM не поддерживается', true],
    ['Смарт-процесс не найден', true], // ⚠ головной случай #488: СП удалили в CRM
    ['This entity type is not supported', true],
    ['NOT_FOUND', false], // голый NOT_FOUND — самый частый общий код портала
    ['socket hang up', false],
    ['QUERY_LIMIT_EXCEEDED', false]
  ])('%s → %s', (msg, expected) => {
    expect(isMissingTargetError(new Error(msg))).toBe(expected)
  })

  it('отказ прав побеждает совпадение по тексту', () => {
    expect(isMissingTargetError(new Error('403 Forbidden: entity type not supported'))).toBe(false)
    expect(isMissingTargetError(new Error('ACCESS_DENIED: сущность CRM не поддерживается'))).toBe(false)
  })
})
