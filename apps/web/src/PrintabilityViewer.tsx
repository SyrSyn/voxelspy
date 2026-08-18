import { Line, OrbitControls } from "@react-three/drei";
import { Canvas, type ThreeEvent } from "@react-three/fiber";
import {
  flattenedTriangleLocator,
  type IslandComponent,
  type OverhangRegion,
  type PrintabilityAssessment,
  type WallThicknessFinding,
} from "@voxelspy/analysis";
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
 * One selected evidence item, shared between this viewer's overlay
 * highlighting and `PrintabilityFlow`'s textual evidence lists -- selecting
 * an item in either place highlights it in the other, mirroring
 * `MeshHealthSelection` (`MeshHealthViewer.tsx`). `index` is the item's
 * position within the corresponding `PrintabilityAssessment` list (e.g.
 * `assessment.wallThickness.findings[index]`), not a stable cross-request id:
 * `assessPrintability` is deterministic for given input (see its doc
 * comment), so this is stable for the lifetime of one loaded assessment.
 */
export type PrintabilitySelection =
  | { readonly kind: "thin-wall"; readonly index: number }
  | { readonly kind: "overhang"; readonly index: number }
  | { readonly kind: "island"; readonly index: number };

/** Per-check show/hide toggle, so a model with dense overlapping evidence
 *  (e.g. a large flagged overhang region and many islands at once) can be
 *  decluttered -- purely a rendering choice, never a filter on the
 *  underlying `PrintabilityAssessment` data itself. */
export interface PrintabilityVisibleLayers {
  readonly thinWall: boolean;
  readonly overhang: boolean;
  readonly island: boolean;
}

export interface PrintabilityViewerProps {
  model: NormalizedModel;
  assessment: PrintabilityAssessment;
  visibleLayers: PrintabilityVisibleLayers;
  selection: PrintabilitySelection | undefined;
  onSelect: (selection: PrintabilitySelection | undefined) => void;
  accessibleLabel: string;
}

// ---------------------------------------------------------------------------
// Geometry helpers. Deliberately duplicated from (rather than imported out
// of) MeshHealthViewer.tsx/ClearanceViewer.tsx/Workbench.tsx, matching the
// precedent all three already set: none is in scope to modify or reshape for
// this bead, and this subset (single model, identity comparison frame -- the
// same frame `assessPrintability`'s default `modelToComparison` uses) is
// small, pure, and easy to keep in sync by inspection.
// ---------------------------------------------------------------------------

const identity = new Matrix4();
/** Matches MeshHealthViewer.tsx's/ClearanceViewer.tsx's own precision-safe
 *  rendering span ceiling. */
const MAX_PRECISION_SAFE_RENDER_SPAN_MILLIMETRES = 500_000;
/** Render-only safety cap on how many of a *selected* overhang region's
 *  triangles are individually resolved and drawn as exact evidence. This
 *  never truncates the assessment's own reported `areaSquareMillimetres`,
 *  `triangleCount`, or any other reported figure -- those stay exact and
 *  come from `assessPrintability` itself; this only bounds how much geometry
 *  one click builds on the main thread. The region's own bounding box (drawn
 *  regardless of this cap) still represents the whole region. */
const MAX_OVERHANG_HIGHLIGHT_TRIANGLES = 20_000;

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

/** The 12-edge point pairs (`Line`'s `segments` mode) for a bounds box --
 *  duplicated from ClearanceViewer.tsx's own `boxEdgePoints`, used here to
 *  draw an overhang region's or island's `bounds` as a wireframe. */
function boxEdgePoints(min: Vector3, max: Vector3): [number, number, number][] {
  const corners: [number, number, number][] = [
    [min.x, min.y, min.z],
    [max.x, min.y, min.z],
    [max.x, max.y, min.z],
    [min.x, max.y, min.z],
    [min.x, min.y, max.z],
    [max.x, min.y, max.z],
    [max.x, max.y, max.z],
    [min.x, max.y, max.z],
  ];
  const edges: [number, number][] = [
    [0, 1],
    [1, 2],
    [2, 3],
    [3, 0],
    [4, 5],
    [5, 6],
    [6, 7],
    [7, 4],
    [0, 4],
    [1, 5],
    [2, 6],
    [3, 7],
  ];
  const points: [number, number, number][] = [];
  for (const [a, b] of edges) {
    points.push(corners[a]!, corners[b]!);
  }
  return points;
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
const THIN_WALL_COLOR = "#ff5a67";
const THIN_WALL_COLOR_SELECTED = "#ffb0b6";
const OVERHANG_COLOR = "#ef9e43";
const OVERHANG_COLOR_SELECTED = "#ffcf8a";
const ISLAND_COLOR = "#c783ff";
const ISLAND_COLOR_SELECTED = "#e3c4ff";

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

/** Thin-wall findings already carry exact world-space positions
 *  (`positionMillimetres`/`oppositePositionMillimetres`) -- no triangle-index
 *  resolution is needed for this overlay, unlike overhang regions below. */
function ThinWallOverlay({
  findings,
  origin,
  sceneSize,
  selection,
  onSelect,
}: {
  findings: readonly WallThicknessFinding[];
  origin: Vector3;
  sceneSize: number;
  selection: PrintabilitySelection | undefined;
  onSelect: (selection: PrintabilitySelection) => void;
}) {
  const markerRadius = Math.max(sceneSize * 0.006, 0.04);
  return (
    <>
      {findings.map((finding, index) => {
        const isSelected =
          selection?.kind === "thin-wall" && selection.index === index;
        const a: [number, number, number] = [
          finding.positionMillimetres[0] - origin.x,
          finding.positionMillimetres[1] - origin.y,
          finding.positionMillimetres[2] - origin.z,
        ];
        const b: [number, number, number] = [
          finding.oppositePositionMillimetres[0] - origin.x,
          finding.oppositePositionMillimetres[1] - origin.y,
          finding.oppositePositionMillimetres[2] - origin.z,
        ];
        const color = isSelected ? THIN_WALL_COLOR_SELECTED : THIN_WALL_COLOR;
        return (
          <group key={index}>
            <Line
              points={[a, b]}
              color={color}
              lineWidth={isSelected ? 2.4 : 1.4}
              transparent
              opacity={isSelected ? 1 : 0.85}
              depthTest={false}
              onClick={(event: ThreeEvent<MouseEvent>) => {
                event.stopPropagation();
                onSelect({ kind: "thin-wall", index });
              }}
            />
            <mesh
              position={a}
              renderOrder={5}
              onClick={(event: ThreeEvent<MouseEvent>) => {
                event.stopPropagation();
                onSelect({ kind: "thin-wall", index });
              }}
            >
              <sphereGeometry args={[markerRadius, 10, 10]} />
              <meshBasicMaterial color={color} depthTest={false} />
            </mesh>
          </group>
        );
      })}
    </>
  );
}

function OverhangRegionOverlay({
  regions,
  origin,
  selection,
  onSelect,
}: {
  regions: readonly OverhangRegion[];
  origin: Vector3;
  selection: PrintabilitySelection | undefined;
  onSelect: (selection: PrintabilitySelection) => void;
}) {
  return (
    <>
      {regions.map((region, index) => {
        const isSelected =
          selection?.kind === "overhang" && selection.index === index;
        const min = new Vector3(...region.bounds.min).sub(origin);
        const max = new Vector3(...region.bounds.max).sub(origin);
        return (
          <Line
            key={region.id}
            points={boxEdgePoints(min, max)}
            segments
            color={isSelected ? OVERHANG_COLOR_SELECTED : OVERHANG_COLOR}
            lineWidth={isSelected ? 2.4 : 1.6}
            transparent
            opacity={isSelected ? 1 : 0.85}
            depthTest={false}
            onClick={(event: ThreeEvent<MouseEvent>) => {
              event.stopPropagation();
              onSelect({ kind: "overhang", index });
            }}
          />
        );
      })}
    </>
  );
}

/**
 * Exact triangle-level evidence for the *selected* overhang region only,
 * resolved via `flattenedTriangleLocator` -- the supported way to map a
 * reported `triangleIndex` back to drawable world positions (see its own doc
 * comment in `@voxelspy/analysis`), rather than this viewer re-deriving
 * `flattenModel`'s traversal order itself. Bounded to
 * `MAX_OVERHANG_HIGHLIGHT_TRIANGLES` for render cost only -- see that
 * constant's doc comment for why this never affects any reported figure.
 */
function SelectedOverhangTrianglesOverlay({
  model,
  region,
  origin,
}: {
  model: NormalizedModel;
  region: OverhangRegion;
  origin: Vector3;
}) {
  const geometry = useMemo(() => {
    const locator = flattenedTriangleLocator(model);
    const indices = region.triangleIndices.slice(
      0,
      MAX_OVERHANG_HIGHLIGHT_TRIANGLES,
    );
    const positions = new Float32Array(indices.length * 9);
    indices.forEach((triangleIndex, ordinal) => {
      const location = locator.resolve(triangleIndex);
      location.positionsMillimetres.forEach((point, cornerIndex) => {
        const base = ordinal * 9 + cornerIndex * 3;
        positions[base] = point[0] - origin.x;
        positions[base + 1] = point[1] - origin.y;
        positions[base + 2] = point[2] - origin.z;
      });
    });
    const built = new BufferGeometry();
    built.setAttribute("position", new BufferAttribute(positions, 3));
    built.computeBoundingSphere();
    return built;
  }, [model, region, origin]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  return (
    <mesh geometry={geometry} renderOrder={4}>
      <meshBasicMaterial
        color={OVERHANG_COLOR_SELECTED}
        side={DoubleSide}
        transparent
        opacity={0.92}
        depthTest={false}
      />
    </mesh>
  );
}

/** Islands carry no `triangleIndices` (only `bounds` -- see
 *  `IslandComponent`'s doc comment): this overlay is a bounding-box wireframe
 *  only, the same evidence shape `ClearanceViewer.tsx`'s `TightRegionOverlay`
 *  already uses for `ClearanceTightRegion.bounds`. */
function IslandOverlay({
  components,
  origin,
  selection,
  onSelect,
}: {
  components: readonly IslandComponent[];
  origin: Vector3;
  selection: PrintabilitySelection | undefined;
  onSelect: (selection: PrintabilitySelection) => void;
}) {
  return (
    <>
      {components.map((component, index) => {
        const isSelected =
          selection?.kind === "island" && selection.index === index;
        const min = new Vector3(...component.bounds.min).sub(origin);
        const max = new Vector3(...component.bounds.max).sub(origin);
        return (
          <Line
            key={component.id}
            points={boxEdgePoints(min, max)}
            segments
            color={isSelected ? ISLAND_COLOR_SELECTED : ISLAND_COLOR}
            lineWidth={isSelected ? 2.4 : 1.6}
            transparent
            opacity={isSelected ? 1 : 0.85}
            depthTest={false}
            onClick={(event: ThreeEvent<MouseEvent>) => {
              event.stopPropagation();
              onSelect({ kind: "island", index });
            }}
          />
        );
      })}
    </>
  );
}

function PrintabilityScene({
  model,
  assessment,
  visibleLayers,
  selection,
  onSelect,
  origin,
  renderable,
  sceneSize,
  accessibleLabel,
}: {
  model: NormalizedModel;
  assessment: PrintabilityAssessment;
  visibleLayers: PrintabilityVisibleLayers;
  selection: PrintabilitySelection | undefined;
  onSelect: (selection: PrintabilitySelection | undefined) => void;
  origin: Vector3;
  renderable: boolean;
  sceneSize: number;
  accessibleLabel: string;
}) {
  const [available, setAvailable] = useState(false);
  useEffect(() => setAvailable(probeWebGLAvailability()), []);
  const fallback = (
    <div className="render-fallback" role="status">
      3D printability preview unavailable. The disclaimer and every check's
      evidence lists below remain fully accessible and are not a degraded
      substitute for it.
    </div>
  );
  if (!renderable)
    return (
      <div className="render-fallback" role="status">
        3D printability preview withheld because the model span exceeds the
        precision-safe rendering range. The evidence lists below remain
        available.
      </div>
    );
  if (!available) return fallback;
  const selectedOverhangRegion =
    selection?.kind === "overhang"
      ? assessment.overhangs.regions[selection.index]
      : undefined;
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
        {visibleLayers.thinWall && (
          <ThinWallOverlay
            findings={assessment.wallThickness.findings}
            origin={origin}
            sceneSize={sceneSize}
            selection={selection}
            onSelect={onSelect}
          />
        )}
        {visibleLayers.overhang && (
          <OverhangRegionOverlay
            regions={assessment.overhangs.regions}
            origin={origin}
            selection={selection}
            onSelect={onSelect}
          />
        )}
        {visibleLayers.overhang && selectedOverhangRegion && (
          <SelectedOverhangTrianglesOverlay
            model={model}
            region={selectedOverhangRegion}
            origin={origin}
          />
        )}
        {visibleLayers.island && (
          <IslandOverlay
            components={assessment.islands.components}
            origin={origin}
            selection={selection}
            onSelect={onSelect}
          />
        )}
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
 * 3D evidence preview for `/tools/printability/`: draws the model's own mesh
 * translucently, overlaid with thin-wall probe findings, overhang region
 * bounding boxes (with exact triangle-level highlighting for the selected
 * region, via `flattenedTriangleLocator`), and island bounding boxes -- each
 * layer independently toggleable and each item independently selectable,
 * never merged into one combined overlay or one verdict color. Scoped
 * deliberately small, matching `MeshHealthViewer`/`ClearanceViewer`: one
 * model, one viewport, no synchronized multi-view camera. This tool's own
 * textual evidence lists (rendered by `PrintabilityFlow`, passing
 * `selection`/`onSelect` here) remain the accessible, always-available
 * equivalent, per this viewer's own `role="img"` accessible name and
 * non-canvas fallbacks above.
 */
export function PrintabilityViewer({
  model,
  assessment,
  visibleLayers,
  selection,
  onSelect,
  accessibleLabel,
}: PrintabilityViewerProps) {
  const renderFrame = useMemo(() => renderFrameFor(model), [model]);
  return (
    <div className="printability-viewport viewport-canvas">
      <PrintabilityScene
        model={model}
        assessment={assessment}
        visibleLayers={visibleLayers}
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
