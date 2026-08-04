import { describe, expect, it } from 'vitest'
import { clampClip, framedCamera, nextRegion } from './model'

describe('workbench interaction model', () => {
  it('frames a selected location without changing source coordinates', () => {
    const camera = framedCamera('notch', 9)
    expect(camera.target).toEqual([-1.35, -0.72, 0.38])
    expect(camera.revision).toBe(9)
    expect(camera.zoom).toBeGreaterThan(1)
  })

  it('cycles ranked regions in both directions', () => {
    expect(nextRegion('mount', 1)).toBe('notch')
    expect(nextRegion('mount', -1)).toBe('bore')
  })

  it('clamps clipping input to a safe percentage', () => {
    expect(clampClip(-2)).toBe(0)
    expect(clampClip(43.7)).toBe(44)
    expect(clampClip(101)).toBe(100)
  })
})
