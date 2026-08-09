// @vitest-environment nuxt
import { describe, it, expect, vi } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import SliderProbeLog from '~/components/SliderProbeLog.vue'

// ⚠ Несущая гарантия стенда (#477) — ПОБОЧНЫЙ ЭФФЕКТ, а не форматирование: строка появляется в
// журнале ДО вызова, в состоянии «ждём…», и дополняется после. Чистая `formatProbeEntry` покрыта
// отдельно, но её теста МАЛО: мутация «класть строку в журнал после вызова, а не до» проходила все
// тесты бесследно (найдено разбором) — а это ровно тот дефект, ради устранения которого стенд и
// собран: при записи одной строкой после вызова резолв-на-закрытии неотличим от мгновенного
// возврата.
describe('SliderProbeLog — момент появления строки (#477)', () => {
  it('строка видна в журнале ПОКА вызов ещё не вернулся, и показывает «ждём…»', async () => {
    const wrapper = await mountSuspended(SliderProbeLog)
    const api = wrapper.vm as unknown as { run: (l: string, f: () => Promise<unknown>) => Promise<void> }

    let release: (v: unknown) => void = () => {}
    const pending = new Promise((resolve) => {
      release = resolve
    })

    const running = api.run('11 открыть тест 2', () => pending)
    await wrapper.vm.$nextTick()

    // Вызов ещё НЕ вернулся — и это уже видно на экране.
    expect(wrapper.text()).toContain('11 открыть тест 2')
    expect(wrapper.text()).toContain('ждём…')

    release(true)
    await running
    await wrapper.vm.$nextTick()

    expect(wrapper.text()).not.toContain('ждём…')
    expect(wrapper.text()).toContain('true')
  })

  it('пока замер идёт, второй не начинается — иначе два пути закрытия портят наблюдение', async () => {
    const wrapper = await mountSuspended(SliderProbeLog)
    const api = wrapper.vm as unknown as {
      run: (l: string, f: () => Promise<unknown>) => Promise<void>
      running: boolean
    }

    let release: (v: unknown) => void = () => {}
    const pending = new Promise((resolve) => {
      release = resolve
    })
    const second = vi.fn(() => Promise.resolve(true))

    const first = api.run('12 закрыть (parent)', () => pending)
    await wrapper.vm.$nextTick()
    expect(api.running).toBe(true)

    await api.run('12б закрыть (SDK)', second)
    expect(second).not.toHaveBeenCalled()
    expect(wrapper.text()).not.toContain('12б')

    release(true)
    await first
    expect(api.running).toBe(false)
  })

  it('отказ вызова не роняет журнал и печатается классом, а не текстом исключения', async () => {
    const wrapper = await mountSuspended(SliderProbeLog)
    const api = wrapper.vm as unknown as { run: (l: string, f: () => Promise<unknown>) => Promise<void> }

    await api.run('12 закрыть', () => Promise.reject(new Error('секретная внутренняя строка')))
    await wrapper.vm.$nextTick()

    expect(wrapper.text()).toContain('ОТКАЗ')
    expect(wrapper.text()).not.toContain('секретная внутренняя строка')
  })

  it('до первого нажатия объясняет, что здесь появится', async () => {
    const wrapper = await mountSuspended(SliderProbeLog)
    expect(wrapper.text()).toContain('Нажмите кнопку')
  })
})
