// b24ui's `useColorMode()` reads color-mode settings from the TOP LEVEL of the app config — the
// module itself only writes `appConfig.b24ui`/`version`, so without these keys `useColorMode()`
// returns a no-op stub and in-portal pages stay locked to light (never getting the `.dark` class).
// `auto` follows the OS / the portal iframe's color scheme on first visit; the choice persists under
// `vueuse-color-scheme` (the composable's default). The public landing pins its own dark shell via
// `data-force-dark` (see app.vue theme-init), so this doesn't repaint it.
export default defineAppConfig({
  colorMode: true,
  colorModeInitialValue: 'auto',
  /**
   * Правка темы b24ui на УЗКОМ экране (#523, замерено браузером на 375 px).
   *
   * ⚠ Внутренний контейнер `B24PageCard` объявлен `flex flex-col flex-1` без `min-w-0`, а флекс-элемент
   * по умолчанию не может стать уже своего содержимого. Хватало одной длинной подписи выбранного
   * значения («Внести строку как есть, без товара из каталога»), чтобы контейнер вырос до 518 px при
   * экране 375 — и карточка обрезала ВСЁ содержимое, включая соседние абзацы, а страница при этом не
   * прокручивалась. Снаружи это читается как «текст вылезает за край».
   *
   * ⚠ Правка ГЛОБАЛЬНАЯ, а не по месту: карточек в проекте больше десятка, и следующая длинная
   * подпись воспроизвела бы дефект в другом месте. `min-w-0` ничего не ломает на широком экране —
   * он лишь снимает запрет на сжатие.
   */
  b24ui: {
    pageCard: {
      slots: { container: 'min-w-0' }
    }
  }
})
