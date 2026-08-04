import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { Scene } from './Scene'
import {
  clampClip,
  framedCamera,
  initialCamera,
  nextRegion,
  regions,
  type CameraState,
  type RegionId,
  type ThemeName,
  type ViewKind,
} from './model'

const views: { kind: ViewKind; eyebrow: string; title: string; summary: string }[] = [
  { kind: 'baseline', eyebrow: 'Reference', title: 'Baseline', summary: 'Captured source geometry' },
  { kind: 'difference', eyebrow: 'Analysis', title: 'Difference', summary: '3 ranked regions' },
  { kind: 'candidate', eyebrow: 'Revision', title: 'Candidate', summary: 'Proposed geometry' },
]

function sameVector(a: number[], b: number[]) {
  return a.every((value, index) => Math.abs(value - b[index]) < 0.0001)
}

function Viewport({
  view,
  camera,
  clip,
  selected,
  onCameraChange,
  onSelect,
}: {
  view: (typeof views)[number]
  camera: CameraState
  clip: number
  selected: RegionId
  onCameraChange: (next: Omit<CameraState, 'revision'>) => void
  onSelect: (id: RegionId) => void
}) {
  const selectedRegion = regions.find((region) => region.id === selected)!
  return (
    <section
      className={`viewport viewport--${view.kind}`}
      aria-labelledby={`${view.kind}-title`}
      data-testid={`${view.kind}-viewport`}
    >
      <header className="viewport__header">
        <div>
          <span className="eyebrow">{view.eyebrow}</span>
          <h2 id={`${view.kind}-title`}>{view.title}</h2>
        </div>
        <span className="viewport__summary">{view.summary}</span>
      </header>
      <div className="viewport__canvas" aria-label={`${view.title} 3D view. Drag to orbit, right-drag to pan, and scroll or pinch to zoom.`}>
        <Scene
          kind={view.kind}
          cameraState={camera}
          clip={clip}
          selected={selected}
          onCameraChange={onCameraChange}
          onSelect={onSelect}
        />
        <div className="viewport__location" aria-live="polite">
          <span aria-hidden="true">◎</span> {selectedRegion.label}
        </div>
      </div>
    </section>
  )
}

function AnalysisPanel({
  selected,
  onSelect,
  headingRef,
}: {
  selected: RegionId
  onSelect: (id: RegionId) => void
  headingRef?: RefObject<HTMLHeadingElement | null>
}) {
  return (
    <aside className="analysis" aria-labelledby="analysis-title">
      <div className="analysis__heading">
        <div>
          <span className="eyebrow">Local evidence</span>
          <h2 id="analysis-title" ref={headingRef} tabIndex={-1}>Ranked regions</h2>
        </div>
        <span className="analysis__count">3</span>
      </div>
      <p className="analysis__disclaimer">Illustrative output from deterministic generated geometry. Not a measurement result.</p>
      <ol className="finding-list">
        {regions.map((region) => (
          <li key={region.id}>
            <button
              className="finding"
              type="button"
              aria-pressed={selected === region.id}
              onClick={() => onSelect(region.id)}
            >
              <span className="finding__rank">{region.rank.toString().padStart(2, '0')}</span>
              <span className={`cue cue--${region.category}`} aria-hidden="true" />
              <span className="finding__copy">
                <strong>{region.label}</strong>
                <small>{region.summary}</small>
              </span>
              <span className="finding__magnitude">{region.magnitude}</span>
            </button>
          </li>
        ))}
      </ol>
      <div className="legend" aria-label="Difference cues">
        <span><i className="cue cue--added" /> Added · solid</span>
        <span><i className="cue cue--removed" /> Removed · hatch</span>
        <span><i className="cue cue--shifted" /> Shifted · ring</span>
      </div>
    </aside>
  )
}

function useCompactLayout() {
  const query = '(max-width: 1040px)'
  const [compact, setCompact] = useState(() => window.matchMedia(query).matches)

  useEffect(() => {
    const media = window.matchMedia(query)
    const update = (event: MediaQueryListEvent) => setCompact(event.matches)
    setCompact(media.matches)
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])

  return compact
}

export function App() {
  const [theme, setTheme] = useState<ThemeName>('dark')
  const [camera, setCamera] = useState<CameraState>(initialCamera)
  const [clip, setClip] = useState(100)
  const [selected, setSelected] = useState<RegionId>('mount')
  const [analysisOpen, setAnalysisOpen] = useState(false)
  const compact = useCompactLayout()
  const analysisHeadingRef = useRef<HTMLHeadingElement>(null)

  const selectedRegion = useMemo(() => regions.find((region) => region.id === selected)!, [selected])

  const updateCamera = useCallback((next: Omit<CameraState, 'revision'>) => {
    setCamera((current) => {
      if (sameVector(current.position, next.position) && sameVector(current.target, next.target) && Math.abs(current.zoom - next.zoom) < 0.0001) {
        return current
      }
      return { ...next, revision: current.revision + 1 }
    })
  }, [])

  const selectAndFrame = useCallback((id: RegionId) => {
    setSelected(id)
    setCamera((current) => framedCamera(id, current.revision + 1))
  }, [])

  const frameAll = useCallback(() => {
    setCamera((current) => framedCamera('all', current.revision + 1))
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLButtonElement) return
      if (event.key === 'ArrowDown' || event.key === ']') {
        event.preventDefault()
        selectAndFrame(nextRegion(selected, 1))
      } else if (event.key === 'ArrowUp' || event.key === '[') {
        event.preventDefault()
        selectAndFrame(nextRegion(selected, -1))
      } else if (event.key.toLowerCase() === 'f') {
        event.preventDefault()
        frameAll()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [frameAll, selectAndFrame, selected])

  useEffect(() => {
    if (compact && analysisOpen) analysisHeadingRef.current?.focus()
  }, [analysisOpen, compact])

  const analysisHidden = compact && !analysisOpen

  return (
    <div className="app" data-theme={theme}>
      <a className="skip-link" href="#comparison">Skip to comparison</a>
      <header className="topbar">
        <div className="brand">
          <span className="brand__mark" aria-hidden="true"><i /><i /><i /></span>
          <div>
            <span className="eyebrow">Comparison study</span>
            <h1>Three-view workbench</h1>
          </div>
        </div>
        <div className="topbar__meta" aria-label="Session status">
          <span><i className="status-dot" /> Local session</span>
          <span>Generated fixture</span>
        </div>
        <div className="theme-switch" role="group" aria-label="Color theme">
          {(['dark', 'light', 'contrast'] as ThemeName[]).map((name) => (
            <button
              key={name}
              type="button"
              aria-label={name === 'contrast' ? 'High contrast' : name[0].toUpperCase() + name.slice(1)}
              aria-pressed={theme === name}
              onClick={() => setTheme(name)}
            >
              <span className="theme-switch__full">{name === 'contrast' ? 'High contrast' : name[0].toUpperCase() + name.slice(1)}</span>
              <span className="theme-switch__short" aria-hidden="true">{name === 'contrast' ? 'HC' : name[0].toUpperCase()}</span>
            </button>
          ))}
        </div>
      </header>

      <nav className="toolbar" aria-label="View controls">
        <div className="toolbar__group">
          <button type="button" onClick={frameAll}>⌗ <span>Fit all</span><kbd>F</kbd></button>
          <button type="button" onClick={() => selectAndFrame(selected)}>◎ <span>Frame selected</span></button>
        </div>
        <label className="clip-control">
          <span>Cross section</span>
          <input
            aria-label="Cross section depth"
            type="range"
            min="0"
            max="100"
            value={clip}
            onChange={(event) => setClip(clampClip(Number(event.currentTarget.value)))}
          />
          <output>{clip === 100 ? 'Off' : `${clip}%`}</output>
        </label>
        <div className="selection-readout" aria-live="polite">
          <span>Selected</span>
          <strong>{selectedRegion.label}</strong>
          <small>{selectedRegion.category} · {selectedRegion.magnitude}</small>
        </div>
        <button className="analysis-toggle" type="button" aria-expanded={analysisOpen} aria-controls="mobile-analysis" onClick={() => setAnalysisOpen((open) => !open)}>
          {analysisOpen ? 'Hide findings' : 'Show findings'}
        </button>
      </nav>

      <main id="comparison" className="workspace">
        <div className="viewport-grid">
          {views.map((view) => (
            <Viewport
              key={view.kind}
              view={view}
              camera={camera}
              clip={clip}
              selected={selected}
              onCameraChange={updateCamera}
              onSelect={selectAndFrame}
            />
          ))}
        </div>
        <div
          id="mobile-analysis"
          className={analysisOpen ? 'analysis-shell analysis-shell--open' : 'analysis-shell'}
          hidden={analysisHidden}
          inert={analysisHidden}
        >
          <AnalysisPanel selected={selected} onSelect={selectAndFrame} headingRef={analysisHeadingRef} />
        </div>
      </main>

      <footer className="statusbar">
        <span><strong>Orbit</strong> drag</span>
        <span><strong>Pan</strong> right-drag</span>
        <span><strong>Zoom</strong> wheel or pinch</span>
        <span><strong>Regions</strong> ↑ ↓ or [ ]</span>
        <span className="statusbar__safe">Models remain in this browser</span>
      </footer>
    </div>
  )
}
