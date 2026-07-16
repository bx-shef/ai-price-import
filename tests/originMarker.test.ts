import { describe, expect, it } from 'vitest'
import {
  DEFAULT_ORIGINATOR,
  originMarkerFields,
  originSearchFilter,
  originStrategy,
  originatorCode,
  xmlIdValue
} from '../server/utils/originMarker'

describe('originMarker — strategy per entity type (live-verified)', () => {
  it('deal/lead/contact/company use origin fields', () => {
    for (const etid of [1, 2, 3, 4]) expect(originStrategy(etid)).toBe('origin')
  })
  it('smart-invoice(31) and dynamic smart-processes(>=1000) use xmlId', () => {
    expect(originStrategy(31)).toBe('xmlId')
    expect(originStrategy(1030)).toBe('xmlId')
    expect(originStrategy(1032)).toBe('xmlId')
  })
  it('quote(7) and other markerless types → none', () => {
    expect(originStrategy(7)).toBe('none')
  })
})

describe('originMarker — originator code', () => {
  it('trims an explicit prefix, else falls back to the repo code', () => {
    expect(originatorCode('  my-app ')).toBe('my-app')
    expect(originatorCode('')).toBe(DEFAULT_ORIGINATOR)
    expect(originatorCode(undefined)).toBe(DEFAULT_ORIGINATOR)
  })
  it('xmlId value namespaces the job id under the originator', () => {
    expect(xmlIdValue('job-1', 'acme')).toBe('acme:job-1')
    expect(xmlIdValue('job-1')).toBe(`${DEFAULT_ORIGINATOR}:job-1`)
  })
})

describe('originMarker — fields written to crm.item.add', () => {
  it('origin type → originId + originatorId', () => {
    expect(originMarkerFields(2, 'job-1', 'acme')).toEqual({ originId: 'job-1', originatorId: 'acme' })
  })
  it('xmlId type → single namespaced xmlId', () => {
    expect(originMarkerFields(31, 'job-1', 'acme')).toEqual({ xmlId: 'acme:job-1' })
    expect(originMarkerFields(1032, 'job-1', 'acme')).toEqual({ xmlId: 'acme:job-1' })
  })
  it('markerless type → empty (no idempotency marker)', () => {
    expect(originMarkerFields(7, 'job-1', 'acme')).toEqual({})
  })
})

describe('originMarker — crm.item.list search filter', () => {
  it('origin type → exact-match on originId AND originatorId (scoped to our marker)', () => {
    expect(originSearchFilter(2, 'job-1', 'acme')).toEqual({ '=originId': 'job-1', '=originatorId': 'acme' })
  })
  it('xmlId type → exact-match on the namespaced xmlId', () => {
    expect(originSearchFilter(31, 'job-1', 'acme')).toEqual({ '=xmlId': 'acme:job-1' })
  })
  it('markerless type → null (no B24 search possible)', () => {
    expect(originSearchFilter(7, 'job-1', 'acme')).toBeNull()
  })
  it('write fields and search filter agree on the same value', () => {
    const fields = originMarkerFields(2, 'j', 'p')
    const filter = originSearchFilter(2, 'j', 'p')
    expect(filter!['=originId']).toBe(fields.originId)
    expect(filter!['=originatorId']).toBe(fields.originatorId)
  })
})
