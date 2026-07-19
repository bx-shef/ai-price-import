// b24ui's `useColorMode()` reads color-mode settings from the TOP LEVEL of the app config — the
// module itself only writes `appConfig.b24ui`/`version`, so without these keys `useColorMode()`
// returns a no-op stub and in-portal pages stay locked to light (never getting the `.dark` class).
// `auto` follows the OS / the portal iframe's color scheme on first visit; the choice persists under
// `vueuse-color-scheme` (the composable's default). The public landing pins its own dark shell via
// `data-force-dark` (see app.vue theme-init), so this doesn't repaint it.
export default defineAppConfig({
  colorMode: true,
  colorModeInitialValue: 'auto'
})
