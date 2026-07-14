import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import { defineVitestProject } from '@nuxt/test-utils/config'

// Two projects (as in the reference client-bank-alfa-by):
//  - `unit`: pure functions in app/utils + server/utils, node env, no Nuxt runtime.
//  - `nuxt`: components/pages via @nuxt/test-utils + happy-dom.
export default defineConfig(async () => ({
  test: {
    projects: [
      {
        resolve: {
          alias: {
            '~': fileURLToPath(new URL('./app', import.meta.url)),
            '~~': fileURLToPath(new URL('.', import.meta.url))
          }
        },
        test: {
          name: 'unit',
          environment: 'node',
          include: ['tests/**/*.test.ts'],
          exclude: ['tests/nuxt/**']
        }
      },
      await defineVitestProject({
        test: {
          name: 'nuxt',
          include: ['tests/nuxt/**/*.test.ts'],
          environment: 'nuxt',
          // Booting the Nuxt test environment cold (alongside the unit project) can exceed
          // the 10s default and flake the whole run — give the setup hook headroom.
          hookTimeout: 60_000,
          testTimeout: 30_000
        }
      })
    ]
  }
}))
