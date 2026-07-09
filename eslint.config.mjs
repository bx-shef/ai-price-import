// @ts-check
import withNuxt from './.nuxt/eslint.config.mjs'

// Stylistic rules (comma-dangle: never, brace-style: 1tbs) are configured via the
// @nuxt/eslint module options in nuxt.config.ts. Legacy code is kept for porting
// and not linted by the new toolchain.
export default withNuxt(
  { ignores: ['legacy/**', 'docs/**'] }
)
