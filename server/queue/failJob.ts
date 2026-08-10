import { describePipelineFailure } from '../utils/pipelineFailure'

/**
 * Единая точка, где отказ стадии становится ВИДИМЫМ человеку (#506).
 *
 * ЗАЧЕМ ОТДЕЛЬНЫЙ МОДУЛЬ, А НЕ ДВЕ СТРОКИ В ПРОВОДКЕ. Классификация сперва стояла только на ветке
 * исчерпанных попыток в воркере, и проверяющие нашли дыру: реальные отказы извлечения ловит сам
 * обработчик и клал сюда СЫРУЮ причину — stderr `pdftotext`/`libreoffice` с внутренними путями,
 * ответы базы. Чат от этого спасала грубая заглушка, а экран — ничто. То есть инвариант «наружу
 * только наш текст» был записан в документацию раньше, чем стал правдой.
 *
 * ⚠ Живя двумя одинаковыми строками внутри `liveDeps`, эта логика была НЕДОСТУПНА тестам: проводку
 * там не смонтировать без Redis, портала и очередей. Ровно тот повторяющийся класс дефектов, о
 * котором предупреждает проект, — «чистая функция покрыта, а место её вызова нет». Фабрика с
 * внедрёнными эффектами проверяется фейками.
 */

export interface FailJobEffects {
  /** Записать терминальный статус задания. Текст увидит человек на экране. */
  setStatus: (memberId: string, jobId: string, reason: string) => Promise<void>
  /** Сообщить загрузившему и в чат ошибок. Тот же текст. */
  notify: (memberId: string, jobId: string, reason: string) => Promise<void>
}

/**
 * Build the stage's `failJob`: classify once, deliver the same text everywhere.
 *
 * ⚠ Текст считается ОДИН раз и уходит обоим получателям. Разные тексты на экране и в чате — это
 * два описания одной поломки, между которыми человек будет искать разницу; а главное, сырая
 * причина утекала бы туда, где классификацию забыли применить.
 */
export function createFailJob(effects: FailJobEffects) {
  return async function failJob(memberId: string, jobId: string, reason: string): Promise<void> {
    const human = describePipelineFailure(reason).message
    await effects.setStatus(memberId, jobId, human)
    await effects.notify(memberId, jobId, human)
  }
}
