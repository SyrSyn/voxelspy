import { OrbitControls } from '@react-three/drei'
import { Canvas, useThree } from '@react-three/fiber'
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib'
import { Component, memo, useEffect, useMemo, useRef, useState, type ErrorInfo, type ReactNode } from 'react'
import { CylinderGeometry, Plane, Vector3 } from 'three'
import type { CameraState, RegionId, ViewKind } from './model'
import { regions } from './model'

type SceneProps = {
  kind: ViewKind
  cameraState: CameraState
  clip: number
  selected: RegionId
  onCameraChange: (state: Omit<CameraState, 'revision'>) => void
  onSelect: (id: RegionId) => void
}

const palettes = {
  baseline: { body: '#6d8790', edge: '#b7c8cd' },
  candidate: { body: '#7f91a0', edge: '#c8d4d8' },
  difference: { body: '#58666e', edge: '#d5dee1' },
} as const

let cachedWebGLAvailability: boolean | undefined

function canCreateWebGL() {
  if (cachedWebGLAvailability !== undefined) return cachedWebGLAvailability
  try {
    const canvas = document.createElement('canvas')
    const context = canvas.getContext('webgl2') ?? canvas.getContext('webgl')
    cachedWebGLAvailability = context !== null
    context?.getExtension('WEBGL_lose_context')?.loseContext()
  } catch {
    cachedWebGLAvailability = false
  }
  return cachedWebGLAvailability
}

class SceneErrorBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch(_error: Error, _info: ErrorInfo) {
    // The accessible fallback is the error report for this evidence surface.
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}

function cameraSnapshot(camera: { position: Vector3; zoom: number }, controls: OrbitControlsImpl) {
  const round = (value: number) => Number(value.toFixed(4))
  return JSON.stringify({
    position: camera.position.toArray().map(round),
    target: controls.target.toArray().map(round),
    zoom: round(camera.zoom),
  })
}

function CameraBridge({ state, onChange }: { state: CameraState; onChange: SceneProps['onCameraChange'] }) {
  const controlsRef = useRef<OrbitControlsImpl>(null)
  const interactingRef = useRef(false)
  const { camera, gl, invalidate } = useThree()

  const recordCamera = (controls: OrbitControlsImpl | null) => {
    if (!controls) return
    gl.domElement.dataset.renderCamera = cameraSnapshot(camera, controls)
  }

  useEffect(() => {
    const controls = controlsRef.current
    if (!controls || interactingRef.current) return
    camera.position.set(...state.position)
    camera.zoom = state.zoom
    camera.updateProjectionMatrix()
    controls.target.set(...state.target)
    controls.update()
    recordCamera(controls)
    invalidate()
  }, [camera, gl, invalidate, state])

  const publishCamera = (controls: OrbitControlsImpl | null) => {
    if (!controls) return
    recordCamera(controls)
    onChange({
      position: camera.position.toArray() as [number, number, number],
      target: controls.target.toArray() as [number, number, number],
      zoom: camera.zoom,
    })
  }

  return (
    <OrbitControls
      ref={controlsRef}
      makeDefault
      enableDamping={false}
      minDistance={2.4}
      maxDistance={16}
      mouseButtons={{ LEFT: 0, MIDDLE: 1, RIGHT: 2 }}
      onStart={() => { interactingRef.current = true }}
      onChange={() => {
        if (interactingRef.current) publishCamera(controlsRef.current)
      }}
      onEnd={() => {
        publishCamera(controlsRef.current)
        interactingRef.current = false
      }}
    />
  )
}

function RendererProbe({ clip }: { clip: number }) {
  const { gl, scene } = useThree()

  useEffect(() => {
    let materials = 0
    const constants: number[] = []
    scene.traverse((object) => {
      const candidate = (object as typeof object & { material?: unknown }).material
      const entries = Array.isArray(candidate) ? candidate : candidate ? [candidate] : []
      for (const material of entries) {
        const planes = (material as { clippingPlanes?: Plane[] | null }).clippingPlanes ?? []
        if (planes.length > 0) {
          materials += 1
          constants.push(...planes.map((plane) => Number(plane.constant.toFixed(4))))
        }
      }
    })
    gl.domElement.dataset.renderClipping = JSON.stringify({ clip, materials, constants })
  }, [clip, gl, scene])

  return null
}

function SelectionMarker({ selected }: { selected: RegionId }) {
  const region = regions.find((item) => item.id === selected)!
  return (
    <group position={region.location}>
      <mesh>
        <sphereGeometry args={[0.16, 16, 12]} />
        <meshBasicMaterial color="#ffffff" depthTest={false} />
      </mesh>
      <mesh rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[0.28, 0.035, 8, 24]} />
        <meshBasicMaterial color="#141414" depthTest={false} />
      </mesh>
    </group>
  )
}

function BaseBody({ kind, clippingPlanes }: { kind: ViewKind; clippingPlanes: Plane[] }) {
  const palette = palettes[kind]
  const candidate = kind !== 'baseline'
  return (
    <group>
      <mesh castShadow receiveShadow>
        <boxGeometry args={[4.4, 1.5, 2.4, 3, 2, 2]} />
        <meshStandardMaterial color={palette.body} metalness={0.18} roughness={0.54} clippingPlanes={clippingPlanes} />
      </mesh>
      <mesh position={[0.15, 0.72, 0]} castShadow>
        <boxGeometry args={[2.8, 0.64, 1.45]} />
        <meshStandardMaterial color={palette.body} metalness={0.18} roughness={0.54} clippingPlanes={clippingPlanes} />
      </mesh>
      <mesh position={[candidate ? 0.1 : -0.05, 0.1, 0.56]} rotation={[Math.PI / 2, 0, 0]}>
        <primitive object={useMemo(() => new CylinderGeometry(0.44, 0.44, 1.6, 32), [])} attach="geometry" />
        <meshStandardMaterial color="#263238" roughness={0.8} clippingPlanes={clippingPlanes} />
      </mesh>
      <lineSegments>
        <edgesGeometry args={[undefined, 24]} />
        <lineBasicMaterial color={palette.edge} transparent opacity={0.58} />
      </lineSegments>
    </group>
  )
}

function DifferenceRegions({ selected, onSelect, clippingPlanes }: Pick<SceneProps, 'selected' | 'onSelect'> & { clippingPlanes: Plane[] }) {
  return (
    <group>
      <mesh
        position={[1.72, 0.86, 0]}
        scale={selected === 'mount' ? 1.08 : 1}
        onClick={(event) => { event.stopPropagation(); onSelect('mount') }}
      >
        <boxGeometry args={[0.62, 0.68, 1.55]} />
        <meshStandardMaterial color="#f2b84b" roughness={0.6} clippingPlanes={clippingPlanes} />
      </mesh>
      <mesh
        position={[-1.5, -0.71, 0.38]}
        scale={selected === 'notch' ? 1.08 : 1}
        onClick={(event) => { event.stopPropagation(); onSelect('notch') }}
      >
        <boxGeometry args={[0.74, 0.42, 0.68]} />
        <meshStandardMaterial color="#36b9c6" wireframe clippingPlanes={clippingPlanes} />
      </mesh>
      <mesh
        position={[0.1, 0.08, 0.58]}
        rotation={[Math.PI / 2, 0, 0]}
        scale={selected === 'bore' ? 1.08 : 1}
        onClick={(event) => { event.stopPropagation(); onSelect('bore') }}
      >
        <torusGeometry args={[0.54, 0.09, 10, 32]} />
        <meshStandardMaterial color="#ec74a2" roughness={0.38} clippingPlanes={clippingPlanes} />
      </mesh>
    </group>
  )
}

const Model = memo(function Model({ kind, clip, selected, onSelect }: Pick<SceneProps, 'kind' | 'clip' | 'selected' | 'onSelect'>) {
  const clippingPlanes = useMemo(
    () => clip >= 100 ? [] : [new Plane(new Vector3(-1, 0, 0), -3.2 + (clip / 100) * 6.4)],
    [clip],
  )
  return (
    <group rotation={[-0.08, -0.12, 0]}>
      <BaseBody kind={kind} clippingPlanes={clippingPlanes} />
      {kind === 'candidate' && (
        <mesh position={[1.72, 0.86, 0]}>
          <boxGeometry args={[0.62, 0.68, 1.55]} />
          <meshStandardMaterial color="#889da5" clippingPlanes={clippingPlanes} />
        </mesh>
      )}
      {kind === 'difference' && (
        <DifferenceRegions selected={selected} onSelect={onSelect} clippingPlanes={clippingPlanes} />
      )}
      <SelectionMarker selected={selected} />
    </group>
  )
})

function WebGLFallback() {
  return (
    <div className="canvas-fallback" role="status">
      3D preview unavailable. Ranked findings and controls remain accessible.
    </div>
  )
}

export function Scene(props: SceneProps) {
  const [webGLAvailable, setWebGLAvailable] = useState(canCreateWebGL)

  if (!webGLAvailable) return <WebGLFallback />

  const fallback = <WebGLFallback />
  return (
    <SceneErrorBoundary fallback={fallback}>
      <Canvas
        camera={{ position: props.cameraState.position, fov: 38, near: 0.1, far: 100 }}
        dpr={[1, 1.5]}
        frameloop="demand"
        fallback={fallback}
        gl={{ antialias: true, alpha: false, localClippingEnabled: true, powerPreference: 'high-performance' }}
        onCreated={({ gl }) => {
          gl.domElement.addEventListener('webglcontextlost', (event) => {
            event.preventDefault()
            setWebGLAvailable(false)
          }, { once: true })
        }}
        onPointerMissed={() => undefined}
      >
        <color attach="background" args={['#111a1e']} />
        <ambientLight intensity={1.4} />
        <directionalLight position={[4, 8, 5]} intensity={2.1} castShadow={false} />
        <directionalLight position={[-4, -2, -3]} intensity={0.65} />
        <gridHelper args={[12, 24, '#38494f', '#26343a']} position={[0, -1.01, 0]} />
        <Model kind={props.kind} clip={props.clip} selected={props.selected} onSelect={props.onSelect} />
        <RendererProbe clip={props.clip} />
        <CameraBridge state={props.cameraState} onChange={props.onCameraChange} />
      </Canvas>
    </SceneErrorBoundary>
  )
}
