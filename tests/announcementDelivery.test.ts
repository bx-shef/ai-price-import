import { describe, expect, it } from 'vitest'
import { deliveryNote, shouldBroadcast } from '../app/utils/announcementDelivery'

// #478. Обе функции жили в разметке и в роуте, и разбор показал цену: условие запуска рассылки не
// покрывал НИ ОДИН тест, а мутация «рассылать и на предпросмотр» превращала каждое нажатие
// «Проверить» в REST-обход всех порталов клиентов.

describe('#478: когда рассылать сигнал', () => {
  it('на публикацию и на снятие — да', () => {
    // Снятие рассылается тоже: иначе снятое продолжало бы висеть у всех, кто держит вкладку
    // открытой, — то есть ровно у тех, ради кого сигнал и заводился.
    expect(shouldBroadcast('publish', 200)).toBe(true)
    expect(shouldBroadcast('clear', 200)).toBe(true)
  })

  it('на ПРЕДПРОСМОТР — нет', () => {
    // ⚠ Самая дорогая мутация из возможных: предпросмотр ничего не меняет, а рассылка по нему
    // дёргала бы все порталы клиентов на каждое нажатие «Проверить».
    expect(shouldBroadcast('preview', 200)).toBe(false)
  })

  it('отвергнутая операция не рассылается', () => {
    // Объявления не создали — сигнал «сходи проверь» отправил бы всех за тем, чего нет.
    for (const status of [400, 409, 413, 500, 503]) {
      expect(shouldBroadcast('publish', status), String(status)).toBe(false)
    }
  })

  it('неизвестное действие не рассылается', () => {
    // ⚠ Список положительный, а не «всё кроме предпросмотра»: отрицательная форма молча включила бы
    // рассылку для любого нового действия, которое здесь однажды появится.
    for (const bad of ['', 'PUBLISH', 'send', null, undefined, 42, {}]) {
      expect(shouldBroadcast(bad, 200), JSON.stringify(bad)).toBe(false)
    }
  })
})

describe('#478: что оператор читает про доставку', () => {
  it('«не начали» и «порталов нет» — РАЗНЫЕ тексты', () => {
    // ⚠ Первое — авария у нас, второе — нормальное состояние молодого сервиса. Слить их в одну
    // ветку значит подсунуть оператору неверный вывод о состоянии сервиса.
    const notStarted = deliveryNote(null)
    const noPortals = deliveryNote({ total: 0, sent: 0, failed: 0, truncated: false })
    expect(notStarted).not.toBe(noPortals)
    expect(notStarted).toContain('не удалось')
    expect(noPortals).toContain('Порталов')
  })

  it('доставлено всем — говорится прямо, а не молчанием', () => {
    // Молчание пришлось бы толковать, а провалившаяся рассылка выглядит ровно как «никто не
    // открывал экран».
    expect(deliveryNote({ total: 3, sent: 3, failed: 0, truncated: false })).toContain('всем порталам (3)')
  })

  it('частичная доставка называет числа и запасной путь', () => {
    const t = deliveryNote({ total: 5, sent: 3, failed: 2, truncated: false })
    expect(t).toContain('3 из 5')
    expect(t).toContain('при следующем открытии экрана')
  })

  it('обрезанная выборка объявляется отдельно', () => {
    for (const r of [
      { total: 9, sent: 9, failed: 0, truncated: true },
      { total: 9, sent: 7, failed: 2, truncated: true }
    ]) {
      expect(deliveryNote(r), JSON.stringify(r)).toContain('Выборка обрезана')
    }
  })
})
