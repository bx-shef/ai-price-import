// @vitest-environment nuxt
import { describe, expect, it } from 'vitest'
import { useImport } from '~/composables/useImport'

// Память файлов страницы (#349): единственная копия документа после того, как сервер удалил свою.
// Тестировщик отметил её как непокрытую — а это тот слой, от которого зависит, будет ли у 👎 файл.
// Логика чистая (Map + счётчик байт), но живёт в composable, поэтому тест в nuxt-проекте.

/** Файл заданного размера — содержимое неважно, важен `size`. */
const file = (name: string, bytes: number) => new File([new Uint8Array(bytes)], name)

describe('память файлов страницы', () => {
  it('помнит файл по заданию и отдаёт его обратно', () => {
    const { rememberFile, fileFor } = useImport()
    const f = file('счёт.pdf', 10)
    rememberFile('job-1', f)
    expect(fileFor('job-1')).toBe(f)
    expect(fileFor('job-нет')).toBeUndefined()
  })

  it('повторный вызов с тем же заданием не задваивает учёт байт', () => {
    // Иначе повтор отправки «съедал» бы кап и вытеснял чужие файлы досрочно.
    const { rememberFile, fileFor } = useImport()
    const f = file('a.pdf', 1000)
    rememberFile('job-1', f)
    rememberFile('job-1', file('другой.pdf', 1000))
    expect(fileFor('job-1')).toBe(f) // первая копия остаётся, вторая игнорируется
  })

  it('кап по суммарному объёму вытесняет самые старые, свежий остаётся', () => {
    // Пачка из десяти 20-мегабайтных сканов иначе пришпилила бы 200 МБ в памяти вкладки.
    const { rememberFile, fileFor } = useImport()
    const big = 25 * 1024 * 1024 // три таких заведомо больше капа в 60 МБ
    rememberFile('old', file('old.pdf', big))
    rememberFile('mid', file('mid.pdf', big))
    rememberFile('new', file('new.pdf', big))
    expect(fileFor('new'), 'последний файл обязан остаться').toBeDefined()
    expect(fileFor('old'), 'самый старый должен был вытесниться').toBeUndefined()
  })

  it('удаление строки освобождает её файл — иначе память держала бы то, что уже не оценить', () => {
    const { rememberFile, fileFor, track, removeJob } = useImport()
    track('job-1', 'счёт.pdf')
    rememberFile('job-1', file('счёт.pdf', 10))
    removeJob('job-1')
    expect(fileFor('job-1')).toBeUndefined()
  })

  it('очистка списка освобождает файлы завершённых заданий', () => {
    const { jobs, rememberFile, fileFor, track, clearList } = useImport()
    track('job-done', 'готово.pdf')
    rememberFile('job-done', file('готово.pdf', 10))
    const row = jobs.value.find(j => j.jobId === 'job-done')!
    jobs.value = [{ ...row, status: 'done' }] // терминальный статус — строку можно убрать
    clearList()
    expect(fileFor('job-done')).toBeUndefined()
  })

  it('незавершённое задание переживает очистку вместе со своим файлом', () => {
    // «Убрать завершённые» не должно отнимать файл у задания, которое ещё разбирается.
    const { rememberFile, fileFor, track, clearList } = useImport()
    track('job-running', 'идёт.pdf')
    rememberFile('job-running', file('идёт.pdf', 10))
    clearList()
    expect(fileFor('job-running')).toBeDefined()
  })
})
