export type ThemeName = 'dark' | 'light' | 'contrast'
export type ViewKind = 'baseline' | 'candidate' | 'difference'
export type RegionId = 'mount' | 'notch' | 'bore'

export type CameraState = {
  position: [number, number, number]
  target: [number, number, number]
  zoom: number
  revision: number
}

export type Region = {
  id: RegionId
  rank: number
  label: string
  category: 'added' | 'removed' | 'shifted'
  magnitude: string
  location: [number, number, number]
  summary: string
}

export const regions: Region[] = [
  {
    id: 'mount',
    rank: 1,
    label: 'Upper mount',
    category: 'added',
    magnitude: '+4.8 mm',
    location: [1.55, 0.78, 0],
    summary: 'Candidate material extends beyond the baseline envelope.',
  },
  {
    id: 'notch',
    rank: 2,
    label: 'Lower notch',
    category: 'removed',
    magnitude: '−3.2 mm',
    location: [-1.35, -0.72, 0.38],
    summary: 'Baseline material is absent from the candidate.',
  },
  {
    id: 'bore',
    rank: 3,
    label: 'Center bore',
    category: 'shifted',
    magnitude: '1.6 mm',
    location: [0.1, 0.05, 0.55],
    summary: 'Circular feature centerline differs between versions.',
  },
]

export const initialCamera: CameraState = {
  position: [5.7, 4.2, 6.2],
  target: [0, 0, 0],
  zoom: 1,
  revision: 0,
}

export function framedCamera(regionId: RegionId | 'all', revision: number): CameraState {
  if (regionId === 'all') {
    return { ...initialCamera, revision }
  }
  const region = regions.find((item) => item.id === regionId)!
  const [x, y, z] = region.location
  return {
    position: [x + 2.65, y + 1.9, z + 2.8],
    target: [...region.location],
    zoom: 1.55,
    revision,
  }
}

export function nextRegion(current: RegionId, direction: 1 | -1): RegionId {
  const index = regions.findIndex((region) => region.id === current)
  return regions[(index + direction + regions.length) % regions.length].id
}

export function clampClip(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)))
}
