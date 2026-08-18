import { Line, OrbitControls } from "@react-three/drei";
import { Canvas, type ThreeEvent } from "@react-three/fiber";
import type { MeshHealthDiagnosis } from "@voxelspy/analysis";
import type { NormalizedModel } from "@voxelspy/contracts";
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

/**
 * One selected diagnostic item, shared between this viewer's overlay
 * highlighting and `InspectFlow`'s textual evidence lists -- selecting an
 * item in either place highlights it in the other. `index` is the item's
 * position within the corresponding `MeshHealthDiagnosis` list (e.g.
 * `diagnosis.boundaryLoops.loops[index]`), not a stable cross-request id:
 * `MeshHealthDiagnosis` is deterministic for a given model (see
 * `diagnoseMeshHealth`'s doc comment), so this is stable for the lifetime of
 * one loaded diagnosis.
 */
export type MeshHealthSelection =
  | { readonly kind: "boundary-loop"; readonly index: number }
  | { readonly kind: "non-manifold"; readonly index: number }
  | { readonly kind: "inconsistent-orientation"; readonly index: number }
  | { readonly kind: "degenerate-triangle"; readonly index: number };

export interface MeshHealthViewerProps {
  model: NormalizedModel;
  diagnosis: MeshHealthDiagnosis;
  selection: MeshHealthSelection | undefined;
  onSelect: (selection: MeshHealthSelection | undefined) => void;
  accessibleLabel: string;
}

// ---------------------------------------------------------------------------
// Geometry helpers. Deliberately duplicated from (rather than imported out
// of) Workbench.tsx, matching the precedent already set in InspectFlow.tsx's
// own presentation-helper section: Workbench.tsx is out of scope to modify
// or reshape for this bead, its placement/render-frame helpers are module
// -private, and this subset (single model, no comparison pairing or
// synchronized camera state) is small, pure, and easy to keep in sync by
// inspection.
// ---------------------------------------------------------------------------

const identity = new Matrix4();
/** Matches Workbench.tsx's own precision-safe rendering span ceiling. */
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

/** Same origin-rebasing trick Workbench.tsx's own `toRenderPositions` uses:
 * translate to a nearby origin in Float64 before narrowing to Float32, so a
 * model placed far from the world origin does not lose precision it actually
 * has. */
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

/**
 * `diagnoseMeshHealth`'s `pointsMillimetres`/`endpointsMillimetres`/
 * `positionsMillimetres` are already expressed in the model's own placed
 * frame (the default `modelToComparison` this viewer's caller uses is
 * identity -- there is no second model to align against for a single-model
 * inspection), the same frame `modelBounds` above computes by applying each
 * instance's placement matrix to its mesh-local positions. So overlay points
 * need only the shared origin subtracted, never an additional matrix.
 */
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
const BOUNDARY_LOOP_COLOR = "#ef9e43";
const BOUNDARY_LOOP_COLOR_SELECTED = "#ffcf8a";
const NON_MANIFOLD_COLOR = "#ff5a67";
const NON_MANIFOLD_COLOR_SELECTED = "#ffb0b6";
const INCONSISTENT_COLOR = "#c783ff";
const INCONSISTENT_COLOR_SELECTED = "#e3c4ff";
const DEGENERATE_COLOR = "#ffdf6b";
const DEGENERATE_COLOR_SELECTED = "#fff0ad";

function BaseMesh({
  model,
  origin,
}: {
  model: NormalizedModel;
  origin: Vector3;
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
  return (
    <>
      {instances.map((instance) => (
        <mesh key={instance.id} geometry={instance.geometry}>
          <meshStandardMaterial
            color={BASE_MESH_COLOR}
            roughness={0.68}
            metalness={0.05}
            transparent
            opacity={0.5}
            side={DoubleSide}
          />
        </mesh>
      ))}
    </>
  );
}

/**
 * Boundary loops and edge segments both render with `@react-three/drei`'s
 * `Line` (backed by three-stdlib's fat-line `Line2`/`LineMaterial`) rather
 * than raw three.js `<line>`/`<lineLoop>` JSX: this project's JSX namespace
 * resolves the bare `line` tag against the DOM/SVG `<line>` element instead
 * of three's, so it fails to type-check here even though Workbench.tsx never
 * hits this (it never renders raw line primitives). `Line` also manages its
 * own geometry/material disposal internally (see its source), so these two
 * overlays need no manual disposal effect, unlike `BaseMesh` and
 * `DegenerateTrianglesOverlay` below, which build `BufferGeometry` directly.
 */
function BoundaryLoopsOverlay({
  diagnosis,
  origin,
  selection,
  onSelect,
}: {
  diagnosis: MeshHealthDiagnosis;
  origin: Vector3;
  selection: MeshHealthSelection | undefined;
  onSelect: (selection: MeshHealthSelection) => void;
}) {
  return (
    <>
      {diagnosis.boundaryLoops.loops.map((loop, index) => {
        if (loop.pointsMillimetres.length < 2) return null;
        const points: [number, number, number][] = loop.pointsMillimetres.map(
          (point) => [
            point[0] - origin.x,
            point[1] - origin.y,
            point[2] - origin.z,
          ],
        );
        // A closed loop only renders as a closed ring when its full point
        // list was returned; a truncated one is drawn open, matching
        // `BoundaryLoop.pointsTruncated`'s own documented visual caveat.
        if (loop.closed && !loop.pointsTruncated) points.push(points[0]!);
        const isSelected =
          selection?.kind === "boundary-loop" && selection.index === index;
        return (
          <Line
            key={index}
            points={points}
            color={
              isSelected ? BOUNDARY_LOOP_COLOR_SELECTED : BOUNDARY_LOOP_COLOR
            }
            lineWidth={isSelected ? 2.6 : 1.5}
            transparent
            opacity={isSelected ? 1 : 0.85}
            depthTest={false}
            onClick={(event: ThreeEvent<MouseEvent>) => {
              event.stopPropagation();
              onSelect({ kind: "boundary-loop", index });
            }}
          />
        );
      })}
    </>
  );
}

function EdgeSegmentsOverlay({
  segments,
  kind,
  color,
  colorSelected,
  origin,
  selection,
  onSelect,
}: {
  segments: MeshHealthDiagnosis["nonManifoldEdges"]["segments"];
  kind: "non-manifold" | "inconsistent-orientation";
  color: string;
  colorSelected: string;
  origin: Vector3;
  selection: MeshHealthSelection | undefined;
  onSelect: (selection: MeshHealthSelection) => void;
}) {
  return (
    <>
      {segments.map((segment, index) => {
        const [a, b] = segment.endpointsMillimetres;
        const points: [number, number, number][] = [
          [a[0] - origin.x, a[1] - origin.y, a[2] - origin.z],
          [b[0] - origin.x, b[1] - origin.y, b[2] - origin.z],
        ];
        const isSelected =
          selection?.kind === kind && selection.index === index;
        return (
          <Line
            key={index}
            points={points}
            color={isSelected ? colorSelected : color}
            lineWidth={isSelected ? 2.6 : 1.5}
            transparent
            opacity={isSelected ? 1 : 0.85}
            depthTest={false}
            onClick={(event: ThreeEvent<MouseEvent>) => {
              event.stopPropagation();
              onSelect({ kind, index });
            }}
          />
        );
      })}
    </>
  );
}

function DegenerateTrianglesOverlay({
  triangles,
  origin,
  selection,
  onSelect,
}: {
  triangles: MeshHealthDiagnosis["degenerateTriangles"]["triangles"];
  origin: Vector3;
  selection: MeshHealthSelection | undefined;
  onSelect: (selection: MeshHealthSelection) => void;
}) {
  const items = useMemo(
    () =>
      triangles.map((triangle, index) => {
        const positions = new Float32Array(9);
        triangle.positionsMillimetres.forEach((point, cornerIndex) => {
          positions[cornerIndex * 3] = point[0] - origin.x;
          positions[cornerIndex * 3 + 1] = point[1] - origin.y;
          positions[cornerIndex * 3 + 2] = point[2] - origin.z;
        });
        const geometry = new BufferGeometry();
        geometry.setAttribute("position", new BufferAttribute(positions, 3));
        geometry.computeBoundingSphere();
        return { index, geometry };
      }),
    [triangles, origin],
  );
  useEffect(
    () => () => items.forEach((item) => item.geometry.dispose()),
    [items],
  );
  return (
    <>
      {items.map((item) => {
        const isSelected =
          selection?.kind === "degenerate-triangle" &&
          selection.index === item.index;
        return (
          <mesh
            key={item.index}
            geometry={item.geometry}
            renderOrder={4}
            onClick={(event) => {
              event.stopPropagation();
              onSelect({ kind: "degenerate-triangle", index: item.index });
            }}
          >
            <meshBasicMaterial
              color={isSelected ? DEGENERATE_COLOR_SELECTED : DEGENERATE_COLOR}
              side={DoubleSide}
              transparent
              opacity={isSelected ? 1 : 0.9}
              depthTest={false}
            />
          </mesh>
        );
      })}
    </>
  );
}

function MeshHealthScene({
  model,
  diagnosis,
  selection,
  onSelect,
  origin,
  renderable,
  sceneSize,
  accessibleLabel,
}: {
  model: NormalizedModel;
  diagnosis: MeshHealthDiagnosis;
  selection: MeshHealthSelection | undefined;
  onSelect: (selection: MeshHealthSelection | undefined) => void;
  origin: Vector3;
  renderable: boolean;
  sceneSize: number;
  accessibleLabel: string;
}) {
  const [available, setAvailable] = useState(false);
  useEffect(() => setAvailable(probeWebGLAvailability()), []);
  const fallback = (
    <div className="render-fallback" role="status">
      3D diagnostic preview unavailable. The evidence lists below remain fully
      accessible and are not a degraded substitute for it.
    </div>
  );
  if (!renderable)
    return (
      <div className="render-fallback" role="status">
        3D diagnostic preview withheld because the model span exceeds the
        precision-safe rendering range. The evidence lists below remain
        available.
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
        gl={{
          antialias: true,
          powerPreference: "high-performance",
        }}
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
        onPointerMissed={() => onSelect(undefined)}
      >
        <color attach="background" args={["#111815"]} />
        <ambientLight intensity={1.35} />
        <directionalLight position={[4, 8, 6]} intensity={2.2} />
        <BaseMesh model={model} origin={origin} />
        <BoundaryLoopsOverlay
          diagnosis={diagnosis}
          origin={origin}
          selection={selection}
          onSelect={onSelect}
        />
        <EdgeSegmentsOverlay
          kind="non-manifold"
          segments={diagnosis.nonManifoldEdges.segments}
          color={NON_MANIFOLD_COLOR}
          colorSelected={NON_MANIFOLD_COLOR_SELECTED}
          origin={origin}
          selection={selection}
          onSelect={onSelect}
        />
        <EdgeSegmentsOverlay
          kind="inconsistent-orientation"
          segments={diagnosis.inconsistentOrientationEdges.segments}
          color={INCONSISTENT_COLOR}
          colorSelected={INCONSISTENT_COLOR_SELECTED}
          origin={origin}
          selection={selection}
          onSelect={onSelect}
        />
        <DegenerateTrianglesOverlay
          triangles={diagnosis.degenerateTriangles.triangles}
          origin={origin}
          selection={selection}
          onSelect={onSelect}
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
 * Single-model diagnostic viewer for the Inspect tool: draws the model's own
 * mesh translucently, overlaid with every returned boundary loop,
 * non-manifold edge, inconsistent-orientation edge, and degenerate triangle
 * from one `MeshHealthDiagnosis`. Scoped deliberately small next to
 * `Workbench`: one model, one viewport, no synchronized multi-view camera,
 * no cross-section, no save/export panel -- Inspect's own textual evidence
 * lists (rendered by `InspectFlow`, passing `selection`/`onSelect` here)
 * remain the accessible, always-available equivalent, per this viewer's own
 * `role="img"` accessible name and non-canvas fallbacks below.
 */
export function MeshHealthViewer({
  model,
  diagnosis,
  selection,
  onSelect,
  accessibleLabel,
}: MeshHealthViewerProps) {
  const renderFrame = useMemo(() => renderFrameFor(model), [model]);
  return (
    <div className="mesh-health-viewport viewport-canvas">
      <MeshHealthScene
        model={model}
        diagnosis={diagnosis}
        selection={selection}
        onSelect={onSelect}
        origin={renderFrame.origin}
        renderable={renderFrame.renderable}
        sceneSize={renderFrame.size}
        accessibleLabel={accessibleLabel}
      />
    </div>
  );
}
