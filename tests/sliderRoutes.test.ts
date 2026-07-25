import { describe, expect, it } from 'vitest'
import {
  APP_SLIDER_PLACE_SETTINGS,
  APP_SLIDER_PLACE_METRICS,
  APP_SLIDER_ROUTES,
  sliderRouteForPlace
} from '../app/config/b24'

describe('APP_SLIDER_ROUTES / sliderRouteForPlace', () => {
  it('maps each PLACE constant to a non-empty absolute in-app route', () => {
    for (const place of [APP_SLIDER_PLACE_SETTINGS, APP_SLIDER_PLACE_METRICS]) {
      const route = APP_SLIDER_ROUTES[place]
      expect(route).toBeTruthy()
      expect(route.startsWith('/')).toBe(true)
    }
  })
  it('the map keys ARE exactly the PLACE constants (no drift)', () => {
    expect(Object.keys(APP_SLIDER_ROUTES).sort()).toEqual(
      [APP_SLIDER_PLACE_SETTINGS, APP_SLIDER_PLACE_METRICS].sort()
    )
  })
  it('sliderRouteForPlace: known place → route; settings → /settings, metrics → /metrics', () => {
    expect(sliderRouteForPlace(APP_SLIDER_PLACE_SETTINGS)).toBe('/settings')
    expect(sliderRouteForPlace(APP_SLIDER_PLACE_METRICS)).toBe('/metrics')
  })
  it('sliderRouteForPlace: unknown / empty / null / undefined → undefined (no redirect)', () => {
    expect(sliderRouteForPlace('nope')).toBeUndefined()
    expect(sliderRouteForPlace('')).toBeUndefined()
    expect(sliderRouteForPlace(null)).toBeUndefined()
    expect(sliderRouteForPlace(undefined)).toBeUndefined()
  })
})
