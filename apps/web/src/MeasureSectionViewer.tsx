import { Line, OrbitControls } from "@react-three/drei";
import { Canvas, type ThreeEvent } from "@react-three/fiber";
import type { NormalizedModel, Vec3 } from "@voxelspy/contracts";
import {
  Component,
  useEffect,
  useMemo,
  useState,
  type ErrorInfo,
  type ReactNode,
} from "react";
import {
  Box3,
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Matrix4,
  Vector3,
} from "three";
import { probeWebGLAvailability } from "./capability";

/** One point drawn in the scene: an active (not-yet-kept) measurement point,
 *  a kept measurement's endpoint, or a point taken from a section loop.
 *  `snapKind` drives the marker color, giving the same vertex/edge/face
 *  feedback the textual snap-classification report gives -- see
 *  `MeasureSectionFlow.tsx`'s doc comment for why every point shown here was
 *  produced by an exact engine query, never an approximate on-mesh guess. */
export interface MeasureMarker {
  readonly id: string;
  readonly positionMillimetres: Vec3;
  readonly snapKind: "vertex" | "edge" | "face" | "loop-point";
  readonly emphasis: "active" | "kept";
}

/** One drawn point-to-point line: the active pair being built (once both
 *  points exist), or a previously kept measurement. */
export interface MeasureLineSegment {
  readonly id: string;
  readonly aMillimetres: Vec3;
  readonly bMillimetres: Vec3;
  readonly emphasis: "active" | "kept";
}

/** One section loop's polyline, in the model's own placed frame -- exactly
 *  `SectionLoop.pointsMillimetres` from the latest `sectionModel` result,
 *  passed straight through with no re-computation. */
export interface SectionLoopVisual {
  readonly id: string;
  readonly pointsMillimetres: readonly Vec3[];
  readonly closed: boolean;
  readonly pointsTruncated: boolean;
}

/** A picked ray, in the model's own placed frame (the same frame
 *  `measureOnModel`'s default identity `modelToComparison` expects) -- the
 *  origin-rebasing translation this viewer applies for render precision is
 *  already undone before this callback fires, so a caller can pass it
 *  straight to a `snap-point` query with no further transform. */
export interface PickedRay {
  readonly origin: Vec3;
  readonly direction: Vec3;
}

export interface MeasureSectionViewerProps {
  model: NormalizedModel;
  markers: readonly MeasureMarker[];
  lines: readonly MeasureLineSegment[];
  loops: readonly SectionLoopVisual[];
  onPick: (ray: PickedRay) => void;
  accessibleLabel: string;
}

// ---------------------------------------------------------------------------
// Geometry helpers. Deliberately duplicated from (rather than imported out
// of) MeshHealthViewer.tsx/ClearanceViewer.tsx, matching the precedent both
// already set: neither is in scope to modify for this bead, and this subset
// (single model, no diagnosis overlay, no second part) is small, pure, and
// easy to keep in sync by inspection.
// ---------------------------------------------------------------------------

const identity = new Matrix4();
/** Matches every other viewer's precision-safe rendering span ceiling. */
const MAX_PRECISION_SAFE_RENDER_SPAN_MILLIMETRES = 500_000;

function modelInstances(model: NormalizedModel) {
  const meshById = new Map(model.meshes.map((mesh) => [mesh.id, mesh]));
  if (model.placement.kind === "flat") {
    return model.placement.instances.map((instance) => ({
      id: instance.id,
      mesh: meshById.get(instance.meshId)!,
      matrix: new Matrix4().fromArray(instance.meshToModel),
    }));
  }
  const nodes = new Map(model.placement.nodes.map((node) => [node.id, node]));
  const instances = new Map(
    model.placement.instances.map((instance) => [instance.id, instance]),
  );
  const placed: {
    id: string;
    mesh: NormalizedModel["meshes"][number];
    matrix: Matrix4;
  }[] = [];
  const stack = [...model.placement.rootIds]
    .reverse()
    .map((id) => ({ id, parent: identity }));
  while (stack.length) {
    const current = stack.pop()!;
    const node = nodes.get(current.id);
    if (!node) continue;
    const nodeMatrix = current.parent
      .clone()
      .multiply(new Matrix4().fromArray(node.localToParent));
    for (const instanceId of node.instanceIds) {
      const instance = instances.get(instanceId);
      const mesh = instance && meshById.get(instance.meshId);
      if (instance && mesh)
        placed.push({
          id: instance.id,
          mesh,
          matrix: nodeMatrix
            .clone()
            .multiply(new Matrix4().fromArray(instance.meshToNode)),
        });
    }
    for (let index = node.childIds.length - 1; index >= 0; index -= 1) {
      const childId = node.childIds[index];
      if (childId !== undefined)
        stack.push({ id: childId, parent: nodeMatrix });
    }
  }
  return placed;
}

function toRenderPositions(
  source: Float64Array,
  matrix: Matrix4,
  origin: Vector3,
): Float32Array {
  const positions = new Float32Array(source.length);
  const point = new Vector3();
  for (let index = 0; index < source.length; index += 3) {
    point
      .set(source[index]!, source[index + 1]!, source[index + 2]!)
      .applyMatrix4(matrix)
      .sub(origin);
    positions[index] = point.x;
    positions[index + 1] = point.y;
    positions[index + 2] = point.z;
  }
  return positions;
}

function baseMeshGeometry(
  mesh: NormalizedModel["meshes"][number],
  matrix: Matrix4,
  origin: Vector3,
) {
  const geometry = new BufferGeometry();
  geometry.setAttribute(
    "position",
    new BufferAttribute(
      toRenderPositions(mesh.geometry.positions, matrix, origin),
      3,
    ),
  );
  geometry.setIndex(new BufferAttribute(mesh.geometry.indices, 1));
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  return geometry;
}

function modelBounds(model: NormalizedModel) {
  const bounds = new Box3();
  const point = new Vector3();
  for (const instance of modelInstances(model)) {
    const positions = instance.mesh.geometry.positions;
    for (let index = 0; index < positions.length; index += 3) {
      point
        .set(positions[index]!, positions[index + 1]!, positions[index + 2]!)
        .applyMatrix4(instance.matrix);
      bounds.expandByPoint(point);
    }
  }
  return bounds;
}

function safeBoundsCenter(bounds: Box3) {
  return new Vector3(
    bounds.min.x / 2 + bounds.max.x / 2,
    bounds.min.y / 2 + bounds.max.y / 2,
    bounds.min.z / 2 + bounds.max.z / 2,
  );
}

/** Same rationale `MeshHealthViewer`'s `renderFrameFor` documents: this
 *  viewer's caller only ever uses the default identity `modelToComparison`
 *  (Measure & Section works on one loaded model, with no second-part
 *  placement to compose), so every point this viewer receives -- markers,
 *  lines, loop points -- is already expressed in the same placed frame
 *  `modelBounds` computes here, and needs only the shared origin subtracted
 *  for display. */
function renderFrameFor(model: NormalizedModel) {
  const bounds = modelBounds(model);
  const spans = [
    bounds.max.x - bounds.min.x,
    bounds.max.y - bounds.min.y,
    bounds.max.z - bounds.min.z,
  ];
  const renderable = spans.every(
    (span) =>
      Number.isFinite(span) &&
      span <= MAX_PRECISION_SAFE_RENDER_SPAN_MILLIMETRES,
  );
  const size = renderable ? Math.max(Math.hypot(...spans), 1) : 1;
  return { origin: safeBoundsCenter(bounds), renderable, size };
}

// ---------------------------------------------------------------------------
// Scene content
// ---------------------------------------------------------------------------

class RenderBoundary extends Component<
  { children: ReactNode; fallback: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override componentDidCatch(_error: Error, _info: ErrorInfo) {}
  override render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

const BASE_MESH_COLOR = "#7e9188";
const VERTEX_SNAP_COLOR = "#5b8dee";
const EDGE_SNAP_COLOR = "#c783ff";
const FACE_SNAP_COLOR = "#e0a458";
const LOOP_POINT_COLOR = "#4fd1c5";
const ACTIVE_LINE_COLOR = "#ffe066";
const KEPT_LINE_COLOR = "#9fb0aa";
const SECTION_LOOP_COLOR = "#ef9e43";

function markerColor(kind: MeasureMarker["snapKind"]): string {
  if (kind === "vertex") return VERTEX_SNAP_COLOR;
  if (kind === "edge") return EDGE_SNAP_COLOR;
  if (kind === "loop-point") return LOOP_POINT_COLOR;
  return FACE_SNAP_COLOR;
}

function BaseMesh({
  model,
  origin,
  onPick,
}: {
  model: NormalizedModel;
  origin: Vector3;
  onPick: (ray: PickedRay) => void;
}) {
  const instances = useMemo(
    () =>
      modelInstances(model).map((instance) => ({
        ...instance,
        geometry: baseMeshGeometry(instance.mesh, instance.matrix, origin),
      })),
    [model, origin],
  );
  useEffect(
    () => () => instances.forEach((instance) => instance.geometry.dispose()),
    [instances],
  );
  const pick = (event: ThreeEvent<MouseEvent>) => {
    event.stopPropagation();
    onPick({
      origin: [
        event.ray.origin.x + origin.x,
        event.ray.origin.y + origin.y,
        event.ray.origin.z + origin.z,
      ],
      direction: [
        event.ray.direction.x,
        event.ray.direction.y,
        event.ray.direction.z,
      ],
    });
  };
  return (
    <>
      {instances.map((instance) => (
        <mesh key={instance.id} geometry={instance.geometry} onClick={pick}>
          <meshStandardMaterial
            color={BASE_MESH_COLOR}
            roughness={0.68}
            metalness={0.05}
            transparent
            opacity={0.62}
            side={DoubleSide}
          />
        </mesh>
      ))}
    </>
  );
}

function MarkersOverlay({
  markers,
  origin,
  sceneSize,
}: {
  markers: readonly MeasureMarker[];
  origin: Vector3;
  sceneSize: number;
}) {
  const radius = Math.max(sceneSize * 0.009, 0.06);
  return (
    <>
      {markers.map((marker) => (
        <mesh
          key={marker.id}
          position={[
            marker.positionMillimetres[0] - origin.x,
            marker.positionMillimetres[1] - origin.y,
            marker.positionMillimetres[2] - origin.z,
          ]}
          renderOrder={5}
        >
          <sphereGeometry
            args={[
              marker.emphasis === "active" ? radius * 1.25 : radius,
              12,
              12,
            ]}
          />
          <meshBasicMaterial
            color={markerColor(marker.snapKind)}
            depthTest={false}
            transparent
            opacity={marker.emphasis === "active" ? 1 : 0.85}
          />
        </mesh>
      ))}
    </>
  );
}

function LinesOverlay({
  lines,
  origin,
}: {
  lines: readonly MeasureLineSegment[];
  origin: Vector3;
}) {
  return (
    <>
      {lines.map((line) => (
        <Line
          key={line.id}
          points={[
            [
              line.aMillimetres[0] - origin.x,
              line.aMillimetres[1] - origin.y,
              line.aMillimetres[2] - origin.z,
            ],
            [
              line.bMillimetres[0] - origin.x,
              line.bMillimetres[1] - origin.y,
              line.bMillimetres[2] - origin.z,
            ],
          ]}
          color={
            line.emphasis === "active" ? ACTIVE_LINE_COLOR : KEPT_LINE_COLOR
          }
          lineWidth={line.emphasis === "active" ? 2.4 : 1.6}
          transparent
          opacity={line.emphasis === "active" ? 1 : 0.75}
          depthTest={false}
          renderOrder={4}
        />
      ))}
    </>
  );
}

function SectionLoopsOverlay({
  loops,
  origin,
}: {
  loops: readonly SectionLoopVisual[];
  origin: Vector3;
}) {
  return (
    <>
      {loops.map((loop) => {
        if (loop.pointsMillimetres.length < 2) return null;
        const points: [number, number, number][] = loop.pointsMillimetres.map(
          (point) => [
            point[0] - origin.x,
            point[1] - origin.y,
            point[2] - origin.z,
          ],
        );
        if (loop.closed && !loop.pointsTruncated) points.push(points[0]!);
        return (
          <Line
            key={loop.id}
            points={points}
            color={SECTION_LOOP_COLOR}
            lineWidth={2}
            transparent
            opacity={0.95}
            depthTest={false}
            renderOrder={3}
          />
        );
      })}
    </>
  );
}

function MeasureSectionScene({
  model,
  markers,
  lines,
  loops,
  onPick,
  origin,
  renderable,
  sceneSize,
  accessibleLabel,
}: {
  model: NormalizedModel;
  markers: readonly MeasureMarker[];
  lines: readonly MeasureLineSegment[];
  loops: readonly SectionLoopVisual[];
  onPick: (ray: PickedRay) => void;
  origin: Vector3;
  renderable: boolean;
  sceneSize: number;
  accessibleLabel: string;
}) {
  const [available, setAvailable] = useState(false);
  useEffect(() => setAvailable(probeWebGLAvailability()), []);
  const fallback = (
    <div className="render-fallback" role="status">
      3D measurement preview unavailable. Numeric point entry and the
      measurement and section lists below remain fully accessible and are not a
      degraded substitute for it.
    </div>
  );
  if (!renderable)
    return (
      <div className="render-fallback" role="status">
        3D measurement preview withheld because the model span exceeds the
        precision-safe rendering range. Numeric point entry and the lists below
        remain available.
      </div>
    );
  if (!available) return fallback;
  return (
    <RenderBoundary fallback={fallback}>
      <Canvas
        role="img"
        aria-label={accessibleLabel}
        camera={{
          position: [sceneSize * 0.9, sceneSize * 0.7, sceneSize * 0.9],
          fov: 38,
          near: 0.001,
          far: Math.max(sceneSize * 12, 1_000),
        }}
        frameloop="demand"
        dpr={[1, 1.5]}
        gl={{ antialias: true, powerPreference: "high-performance" }}
        onCreated={({ gl }) =>
          gl.domElement.addEventListener(
            "webglcontextlost",
            (event) => {
              event.preventDefault();
              setAvailable(false);
            },
            { once: true },
          )
        }
      >
        <color attach="background" args={["#111815"]} />
        <ambientLight intensity={1.35} />
        <directionalLight position={[4, 8, 6]} intensity={2.2} />
        <BaseMesh model={model} origin={origin} onPick={onPick} />
        <SectionLoopsOverlay loops={loops} origin={origin} />
        <LinesOverlay lines={lines} origin={origin} />
        <MarkersOverlay
          markers={markers}
          origin={origin}
          sceneSize={sceneSize}
        />
        <OrbitControls
          makeDefault
          enableDamping={false}
          minDistance={0.01}
          maxDistance={1e9}
        />
      </Canvas>
    </RenderBoundary>
  );
}

/**
 * 3D click-to-measure and section preview for `/tools/measure-section/`:
 * draws the loaded model translucently, a clicked point casts a ray through
 * `onPick` (in the model's own placed frame, origin-rebasing already
 * undone -- see `PickedRay`'s doc comment) for the caller to resolve with an
 * exact `snap-point` query, overlaid with every collected/kept measurement
 * marker and line and the latest section's loops. Scoped deliberately small,
 * next to `MeshHealthViewer`/`ClearanceViewer`: one viewport, no synchronized
 * multi-view camera -- `MeasureSectionFlow`'s numeric point entry and
 * textual measurement/section lists are the accessible, always-available
 * equivalent, per this viewer's own `role="img"` accessible name and
 * non-canvas fallbacks above.
 */
export function MeasureSectionViewer({
  model,
  markers,
  lines,
  loops,
  onPick,
  accessibleLabel,
}: MeasureSectionViewerProps) {
  const renderFrame = useMemo(() => renderFrameFor(model), [model]);
  return (
    <div className="measure-section-viewport viewport-canvas">
      <MeasureSectionScene
        model={model}
        markers={markers}
        lines={lines}
        loops={loops}
        onPick={onPick}
        origin={renderFrame.origin}
        renderable={renderFrame.renderable}
        sceneSize={renderFrame.size}
        accessibleLabel={accessibleLabel}
      />
    </div>
  );
}
