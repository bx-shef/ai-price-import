// @vitest-environment nuxt
import { describe, it, expect } from 'vitest'
import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { ref } from 'vue'
import TargetPicker from '~/components/TargetPicker.vue'

// Portal data mocks. Smart-invoice (31) and the category-less SPA (1044) each have ONE category so the
// stage cascade can address stages; the SPA 1050 has categories → the direction picker shows.
const CATS: Record<number, Array<{ id: number, name: string }>> = {
  2: [{ id: 0, name: 'Общая' }, { id: 5, name: 'Опт' }],
  31: [{ id: 7, name: 'Общая воронка' }],
  1044: [{ id: 3, name: 'Основная' }],
  1050: [{ id: 1, name: 'A' }, { id: 2, name: 'B' }]
}
const STAGES: Array<{ id: string, name: string }> = [{ id: 'NEW', name: 'Новая' }, { id: 'WON', name: 'Успех' }]
// Управляемый флаг доступности смарт-счетов — по умолчанию доступны (как на обычном портале).
const smartInvoiceEnabled = ref(true)
// «Список типов ПОЛУЧЕН». Управляемый, потому что fail-open проверяется именно на `false`: пока
// список не пришёл, ни один смарт-процесс не вправе быть объявлен исчезнувшим.
const typesLoaded = ref(true)
// 1044 = СП без направлений, но со стадиями («Договоры»); 1050 = СП с направлениями.
// ⚠ Список УПРАВЛЯЕМЫЙ: пока портал не ответил, он ПУСТ — и именно в этом состоянии проверяется
// fail-open. С вечно заполненным списком проверка была бы бутафорией: «исчезнувших» типов в нём
// не бывает, поэтому и тревоги нет независимо от гарда.
const smartTypes = ref([
  { entityTypeId: 1044, title: 'Договоры', hasCategories: false, hasStages: true },
  { entityTypeId: 1050, title: 'Заявки', hasCategories: true, hasStages: true }
])

mockNuxtImport('useCrmCategories', () => () => ({ load: async (etid: number) => CATS[etid] ?? [] }))
mockNuxtImport('useCrmStages', () => () => ({ load: async () => STAGES }))
mockNuxtImport('useCrmMode', () => () => ({ leadsEnabled: ref(true), load: async () => {} }))
mockNuxtImport('useCrmTypes', () => () => ({
  types: smartTypes,
  smartInvoiceEnabled,
  // Список типов ПОЛУЧЕН: сторож #269 без этого признака ничего не роняет (#492).
  typesLoaded,
  load: async () => {}
}))

const tick = () => new Promise(r => setTimeout(r))
const clickLabel = async (w: Awaited<ReturnType<typeof mountSuspended>>, label: string) => {
  await w.findAll('button').find((b: { text: () => string }) => b.text() === label)!.trigger('click')
  await tick()
  await tick()
}
const hasDirection = (w: Awaited<ReturnType<typeof mountSuspended>>) => w.find('[aria-label="Направление (воронка)"]').exists()
const hasStage = (w: Awaited<ReturnType<typeof mountSuspended>>) => w.find('[aria-label="Стадия"]').exists()
const lastTarget = (w: Awaited<ReturnType<typeof mountSuspended>>) => {
  const ev = w.emitted('update:target')
  return ev ? ev[ev.length - 1]![0] as Record<string, unknown> : undefined
}

describe('TargetPicker', () => {
  it('lists СПА by name (Договоры/Заявки), no raw «ID типа» input', async () => {
    const w = await mountSuspended(TargetPicker)
    await tick()
    const labels = w.findAll('button').map(b => b.text())
    expect(labels).toEqual(expect.arrayContaining(['Авто (по правилам)', 'Лид', 'Сделка', 'Смарт-счёт', 'Договоры', 'Заявки']))
    expect(w.find('input[type="number"]').exists()).toBe(false) // the B24InputNumber was removed
  })

  it('smart-invoice (31): direction HIDDEN, single category auto-used, stage shown; target has categoryId', async () => {
    const w = await mountSuspended(TargetPicker)
    await clickLabel(w, 'Смарт-счёт')
    expect(hasDirection(w)).toBe(false) // always one direction → hidden
    expect(hasStage(w)).toBe(true)
    expect(lastTarget(w)).toMatchObject({ entityTypeId: 31, categoryId: 7 }) // sole category auto-picked
  })

  it('category-less SPA with stages (Договоры): direction hidden, category auto-picked for stage addressing', async () => {
    const w = await mountSuspended(TargetPicker)
    await clickLabel(w, 'Договоры')
    expect(hasDirection(w)).toBe(false)
    expect(hasStage(w)).toBe(true)
    expect(lastTarget(w)).toMatchObject({ entityTypeId: 1044, categoryId: 3 })
  })

  it('SPA WITH categories (Заявки): direction SHOWN, NOT auto-picked', async () => {
    const w = await mountSuspended(TargetPicker)
    await clickLabel(w, 'Заявки')
    expect(hasDirection(w)).toBe(true)
    expect(lastTarget(w)).toMatchObject({ entityTypeId: 1050 })
    expect(lastTarget(w)!.categoryId).toBeUndefined() // user must choose the direction
  })

  it('deal (2): direction shown', async () => {
    const w = await mountSuspended(TargetPicker)
    await clickLabel(w, 'Сделка')
    expect(hasDirection(w)).toBe(true)
  })
})

describe('TargetPicker: недоступный тип на портале (#269)', () => {
  it('на портале без смарт-счетов вариант не показывается', async () => {
    smartInvoiceEnabled.value = false
    try {
      const w = await mountSuspended(TargetPicker)
      await tick()
      expect(w.findAll('button').some((b: { text: () => string }) => b.text() === 'Смарт-счёт')).toBe(false)
    } finally {
      smartInvoiceEnabled.value = true
    }
  })

  it('сохранённая, но исчезнувшая цель сбрасывается и объясняется — иначе импорт упал бы как раньше', async () => {
    const w = await mountSuspended(TargetPicker, { props: { target: { entityTypeId: 31 } } })
    await tick()
    smartInvoiceEnabled.value = false
    try {
      await tick()
      await tick()
      expect(w.text()).toContain('Выбранный тип записи больше не доступен')
      // Наружу больше не эмитится исчезнувший тип 31.
      expect(lastTarget(w)?.entityTypeId).not.toBe(31)
    } finally {
      smartInvoiceEnabled.value = true
    }
  })
})

// #488. Исчезнувшие направление и стадию раньше дочищали МОЛЧА: поле показывало другое значение без
// объяснения, а следующая пачка уходила не туда, куда человек рассчитывал. Теперь пикер уводит выбор
// в «Авто» и ОБЪЯВЛЯЕТ причину наверх — там её показывают сообщением.
//
// ⚠ Гарантия ПОВЕДЕНЧЕСКАЯ, и это выяснилось разбором: мутации «убрать вызов `failToAuto`» и
// «перенести проверку ПОСЛЕ тихой дочистки» проходили бесследно — про этот путь не было ни одного
// теста, вся гарантия жила в комментариях.
describe('TargetPicker: исчезнувший маршрут объявляется, а не дочищается молча (#488)', () => {
  it('удалённое НАПРАВЛЕНИЕ → «Авто» + событие с причиной', async () => {
    // У сделки на портале направления 0 и 5; сохранено 42 — его удалили.
    const w = await mountSuspended(TargetPicker, { props: { target: { entityTypeId: 2, categoryId: 42 } } })
    await tick()
    await tick()
    expect(w.emitted('invalid')?.[0]?.[0], 'причина не объявлена — человек не узнает, почему сменилась цель').toBe('category')
    expect(lastTarget(w), 'выбор обязан уехать в «Авто»').toBeNull()
  })

  it('удалённая СТАДИЯ → «Авто» + событие с причиной', async () => {
    const w = await mountSuspended(TargetPicker, { props: { target: { entityTypeId: 2, categoryId: 5, stageId: 'GONE' } } })
    await tick()
    await tick()
    expect(w.emitted('invalid')?.[0]?.[0]).toBe('stage')
    expect(lastTarget(w)).toBeNull()
  })

  it('годный маршрут молчит — ложная тревога хуже задержки', async () => {
    const w = await mountSuspended(TargetPicker, { props: { target: { entityTypeId: 2, categoryId: 5, stageId: 'NEW' } } })
    await tick()
    await tick()
    expect(w.emitted('invalid')).toBeUndefined()
  })
})

// #492. Тот же исчезнувший маршрут на ЭКРАНЕ НАСТРОЕК, где «Авто» не предлагается. Там `null`
// означает не «решают правила», а «цель не задана»: сеттер подставит голую сделку, то есть
// смарт-счёт админа молча превратится в сделку, а правило маршрутизации потеряет цель. Молчаливое
// искажение сохранённой настройки портала — та же ошибка, что #488, только дороже.
describe('TargetPicker: на /settings негодный маршрут не обнуляет тип (#492)', () => {
  it('удалённое направление: причина объявлена, ТИП сохранён', async () => {
    const w = await mountSuspended(TargetPicker, {
      props: { target: { entityTypeId: 31, categoryId: 42 }, includeAuto: false }
    })
    await tick()
    await tick()
    expect(w.emitted('invalid')?.[0]?.[0], 'сказать человеку надо и здесь').toBe('category')
    expect(lastTarget(w), 'тип обнулять нельзя — иначе настройка портала испорчена молча')
      .toMatchObject({ entityTypeId: 31 })
  })

  it('пока список типов НЕ получен, смарт-процесс не объявляется исчезнувшим (#500)', async () => {
    // ⚠ Самая дорогая ошибка этого механизма и самая незаметная. Она несимметрична: задержка стоит
    // секунд, а ложная тревога уводит исправный маршрут в «Авто» на ровном месте — и человек об
    // этом узнаёт сообщением, то есть верит. На портале, где список ещё едет, `CHOICES` не содержит
    // ни одного смарт-процесса, и без гарда КАЖДЫЙ сохранённый маршрут в СП объявлялся бы негодным.
    typesLoaded.value = false
    smartTypes.value = []
    try {
      const w = await mountSuspended(TargetPicker, { props: { target: { entityTypeId: 1044 } } })
      await tick()
      // ⚠ Список ДОЛЖЕН измениться, иначе проверка бутафорская: сторож висит на изменении `CHOICES`,
      // и при неподвижном списке он не срабатывает вовсе — тест проходил бы и со снятым гардом.
      // Здесь портал успел ответить про смарт-счета, а список смарт-процессов ещё едет.
      smartInvoiceEnabled.value = false
      await tick()
      await tick()
      expect(w.emitted('invalid'), 'незагруженное прочитано как «не существует»').toBeUndefined()
      expect(w.text()).not.toContain('больше не доступен')
    } finally {
      smartInvoiceEnabled.value = true
      typesLoaded.value = true
      smartTypes.value = [
        { entityTypeId: 1044, title: 'Договоры', hasCategories: false, hasStages: true },
        { entityTypeId: 1050, title: 'Заявки', hasCategories: true, hasStages: true }
      ]
    }
  })

  it('список УЖЕ загружен к моменту открытия — исчезнувшая цель всё равно ловится (#500)', async () => {
    // ⚠ Самый частый случай на практике и самый незаметный. `useCrmTypes` — singleton с модульным
    // кэшем: список грузится один раз на сессию. У второго и последующих пикеров (слайдер настроек,
    // повторное открытие экрана, каждое правило маршрутизации) список готов ДО монтирования и больше
    // не меняется — а ленивый `watch` срабатывает только на изменение. Механизм отрабатывал ровно
    // один раз за сессию, у самого первого пикера, и снаружи выглядел исправным: на первом открытии
    // портала он действительно срабатывал.
    smartInvoiceEnabled.value = false
    try {
      const w = await mountSuspended(TargetPicker, { props: { target: { entityTypeId: 31 } } })
      await tick()
      await tick()
      expect(w.emitted('invalid')?.[0]?.[0], 'исчезнувший тип не пойман при неподвижном списке').toBe('entity')
    } finally {
      smartInvoiceEnabled.value = true
    }
  })

  it('человек выбрал сам — жалоба уходит с экрана (#500)', async () => {
    // Строка описывает ПРОШЛОЕ состояние выбора. Оставшись после нового выбора, она заявляет, что
    // недоступна цель, которую человек только что поставил, — и он идёт чинить исправное.
    const w = await mountSuspended(TargetPicker, { props: { target: { entityTypeId: 2, categoryId: 42 } } })
    await tick()
    await tick()
    expect(w.text()).toContain('удалено в CRM')
    await clickLabel(w, 'Лид')
    expect(w.text(), 'жалоба на прежний выбор пережила новый').not.toContain('удалено в CRM')
  })

  it('в настройках постоянная строка НЕ обещает «Авто» (#500)', async () => {
    // Строка стоит у самого места выбора, и обещание, которого экран не выполняет, здесь читается
    // как «уже почищено, делать нечего».
    const w = await mountSuspended(TargetPicker, {
      props: { target: { entityTypeId: 31, categoryId: 42 }, includeAuto: false }
    })
    await tick()
    await tick()
    expect(w.text()).toContain('удалено в CRM')
    expect(w.text(), 'в настройках цель сохраняется — переключения на «Авто» не было').not.toContain('Авто')
  })

  it('удалённая СУЩНОСТЬ: причина объявлена, ТИП сохранён (#500)', async () => {
    // ⚠ Половина, которой у механизма не было. Прежний сторож исчезнувшей сущности жил отдельно и
    // на этом экране МОЛЧА подменял смарт-счёт админа сделкой — ровно то искажение сохранённой
    // настройки, которое #492 объявил дефектом для направления. Теперь правило одно на все причины.
    const w = await mountSuspended(TargetPicker, {
      props: { target: { entityTypeId: 31 }, includeAuto: false }
    })
    await tick()
    smartInvoiceEnabled.value = false
    try {
      await tick()
      await tick()
      expect(w.emitted('invalid')?.[0]?.[0], 'исчезнувшая сущность обязана объявляться так же, как направление').toBe('entity')
      expect(lastTarget(w), 'тип обнулять нельзя — настройка портала испортится молча')
        .toMatchObject({ entityTypeId: 31 })
    } finally {
      smartInvoiceEnabled.value = true
    }
  })

  it('на экране импорта поведение прежнее — выбор уходит в «Авто»', async () => {
    // Обратная половина: гейт не должен выключить #488 там, где «Авто» есть.
    const w = await mountSuspended(TargetPicker, { props: { target: { entityTypeId: 2, categoryId: 42 } } })
    await tick()
    await tick()
    expect(lastTarget(w)).toBeNull()
  })
})
