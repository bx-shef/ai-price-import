import { describe, expect, it } from 'vitest'
import { SETTINGS_RELOAD_COMMAND, buildSettingsReloadEvent, isSettingsReloadCommand } from '../app/utils/settingsSync'

describe('settingsSync', () => {
  it('command constant is reload.options (matches b24-ai-starter)', () => {
    expect(SETTINGS_RELOAD_COMMAND).toBe('reload.options')
  })

  it('buildSettingsReloadEvent shapes the pull.application.event.add params', () => {
    expect(buildSettingsReloadEvent('shef.priceimport')).toEqual({
      COMMAND: 'reload.options',
      PARAMS: { from: 'app.options' },
      MODULE_ID: 'shef.priceimport'
    })
  })

  it('buildSettingsReloadEvent carries a custom `from` source', () => {
    expect(buildSettingsReloadEvent('m', 'settings.page').PARAMS).toEqual({ from: 'settings.page' })
  })

  it('isSettingsReloadCommand recognizes only the reload command', () => {
    expect(isSettingsReloadCommand('reload.options')).toBe(true)
    expect(isSettingsReloadCommand('reload.other')).toBe(false)
    expect(isSettingsReloadCommand(undefined)).toBe(false)
    expect(isSettingsReloadCommand(null)).toBe(false)
    expect(isSettingsReloadCommand('')).toBe(false)
  })
})
