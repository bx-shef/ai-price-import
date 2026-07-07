import { defineConfig } from 'vitest/config'
import { defineVitestProject } from '@nuxt/test-utils/config'

// Two projects (as in the reference client-bank-alfa-by):
//  - `unit`: pure functions in app/utils, node env, no Nuxt runtime.
//  - `nuxt`: components/pages via @nuxt/test-utils + happy-dom.
export default defineConfig(async () => ({
  test: {
    projects: [
      {
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
          environment: 'nuxt'
        }
      })
    ]
  }
}))
