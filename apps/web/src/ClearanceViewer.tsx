import { Line, OrbitControls } from "@react-three/drei";
import { Canvas } from "@react-three/fiber";
import type {
  ClearanceCheckComplete,
  ClearanceTightRegion,
  ClearanceTrianglePair,
} from "@voxelspy/analysis";
import type { Mat4, NormalizedModel } from "@voxelspy/contracts";
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

/** One part's already-imported model plus the deliberate placement transform
 *  the clearance check itself used, so this viewer renders exactly the
 *  frame `checkClearance` measured -- never a different, re-aligned one. */
export interface ClearancePartRender {
  readonly model: NormalizedModel;
  readonly modelToComparison: Mat4;
}

export interface ClearanceViewerProps {
  readonly first: ClearancePartRender;
  readonly second: ClearancePartRender;
  readonly result: ClearanceCheckComplete;
  readonly accessibleLabel: string;
}

// ---------------------------------------------------------------------------
// Geometry helpers. Deliberately duplicated from (rather than imported out
// of) MeshHealthViewer.tsx and Workbench.tsx, matching the precedent both of
// those already set for this codebase: neither is in scope to modify or
// reshape for this bead, both are single-comparison-frame-unaware (a
// clearance check needs each part's own extra `modelToComparison` prefixed
// onto its mesh-local placement, which neither existing viewer applies), and
// this subset is small, pure, and easy to keep in sync by inspection.
// ---------------------------------------------------------------------------

const identity = new Matrix4();
/** Matches Workbench.tsx's and MeshHealthViewer.tsx's own precision-safe
 *  rendering span ceiling. */
const MAX_PRECISION_SAFE_RENDER_SPAN_MILLIMETRES = 500_000;

interface PlacedInstance {
  readonly id: string;
  readonly mesh: NormalizedModel["meshes"][number];
  /** `modelToComparison * meshToModel` (or `* nodeToModel * meshToNode` for
   *  a hierarchical placement) -- the exact matrix `flattenModel` applies to
   *  this instance's vertices in `@voxelspy/analysis`, so a global triangle
   *  index the engine reports (`ClearanceTrianglePair`,
   *  `ClearanceTightRegion.triangleIndices`) can be located back to a real
   *  instance and rendered in the same comparison frame the engine measured. */
  readonly matrix: Matrix4;
}

/**
 * Places every instance of `model` into the shared comparison frame:
 * `modelToComparison` composed with each instance's own mesh-to-model (or
 * node-to-model-then-mesh-to-node) placement, in exactly the traversal order
 * `flattenModel` (`@voxelspy/analysis`) uses to build its per-part flattened
 * triangle list -- flat placement in `placement.instances` order, or a
 * depth-first walk from `placement.rootIds` with children pushed in reverse
 * so they pop in original order. That shared order is what lets
 * `triangleLookupFor` below map a flattened global triangle index back to
 * this exact instance list.
 */
function partInstances(
  model: NormalizedModel,
  modelToComparison: Mat4,
): PlacedInstance[] {
  const outer = new Matrix4().fromArray(modelToComparison as number[]);
  const meshById = new Map(model.meshes.map((mesh) => [mesh.id, mesh]));
  if (model.placement.kind === "flat") {
    return model.placement.instances.map((instance) => ({
      id: instance.id,
      mesh: meshById.get(instance.meshId)!,
      matrix: outer
        .clone()
        .multiply(new Matrix4().fromArray(instance.meshToModel)),
    }));
  }
  const nodes = new Map(model.placement.nodes.map((node) => [node.id, node]));
  const instances = new Map(
    model.placement.instances.map((instance) => [instance.id, instance]),
  );
  const placed: PlacedInstance[] = [];
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
          matrix: outer
            .clone()
            .multiply(
              nodeMatrix
                .clone()
                .multiply(new Matrix4().fromArray(instance.meshToNode)),
            ),
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

interface TriangleLookup {
  locate(
    globalTriangleIndex: number,
  ): { instance: PlacedInstance; localTriangleIndex: number } | undefined;
}

/** Builds the global-triangle-index -> (instance, local triangle) map for
 *  one part, from the same instance order `partInstances` returns -- see
 *  its doc comment for why that order matches `flattenModel`'s. */
function triangleLookupFor(
  instances: readonly PlacedInstance[],
): TriangleLookup {
  const startIndex: number[] = [];
  let total = 0;
  for (const instance of instances) {
    startIndex.push(total);
    total += instance.mesh.geometry.indices.length / 3;
  }
  return {
    locate(globalTriangleIndex) {
      let low = 0;
      let high = instances.length - 1;
      let found = -1;
      while (low <= high) {
        const mid = (low + high) >> 1;
        if (startIndex[mid]! <= globalTriangleIndex) {
          found = mid;
          low = mid + 1;
        } else {
          high = mid - 1;
        }
      }
      if (found === -1) return undefined;
      const instance = instances[found]!;
      const localTriangleIndex = globalTriangleIndex - startIndex[found]!;
      if (localTriangleIndex >= instance.mesh.geometry.indices.length / 3)
        return undefined;
      return { instance, localTriangleIndex };
    },
  };
}

/** The three placed corners (comparison frame, minus `origin`) of one
 *  instance's local triangle, for interference-pair highlighting. */
function triangleCorners(
  instance: PlacedInstance,
  localTriangleIndex: number,
  origin: Vector3,
): [Vector3, Vector3, Vector3] {
  const indices = instance.mesh.geometry.indices;
  const positions = instance.mesh.geometry.positions;
  const base = localTriangleIndex * 3;
  return [indices[base]!, indices[base + 1]!, indices[base + 2]!].map(
    (vertexIndex) =>
      new Vector3(
        positions[vertexIndex * 3]!,
        positions[vertexIndex * 3 + 1]!,
        positions[vertexIndex * 3 + 2]!,
      )
        .applyMatrix4(instance.matrix)
        .sub(origin),
  ) as [Vector3, Vector3, Vector3];
}

function toRenderPositions(
  source: Float64Array,
  matrix: Matrix4,
  origin: Vector3,
): Float32Array {
  const out = new Float32Array(source.length);
  const point = new Vector3();
  for (let index = 0; index < source.length; index += 3) {
    point
      .set(source[index]!, source[index + 1]!, source[index + 2]!)
      .applyMatrix4(matrix)
      .sub(origin);
    out[index] = point.x;
    out[index + 1] = point.y;
    out[index + 2] = point.z;
  }
  return out;
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

function expandBoundsByInstances(
  bounds: Box3,
  instances: readonly PlacedInstance[],
) {
  const point = new Vector3();
  for (const instance of instances) {
    const positions = instance.mesh.geometry.positions;
    for (let index = 0; index < positions.length; index += 3) {
      point
        .set(positions[index]!, positions[index + 1]!, positions[index + 2]!)
        .applyMatrix4(instance.matrix);
      bounds.expandByPoint(point);
    }
  }
}

function safeBoundsCenter(bounds: Box3) {
  return new Vector3(
    bounds.min.x / 2 + bounds.max.x / 2,
    bounds.min.y / 2 + bounds.max.y / 2,
    bounds.min.z / 2 + bounds.max.z / 2,
  );
}

function renderFrameFor(
  firstInstances: readonly PlacedInstance[],
  secondInstances: readonly PlacedInstance[],
) {
  const bounds = new Box3();
  expandBoundsByInstances(bounds, firstInstances);
  expandBoundsByInstances(bounds, secondInstances);
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

/** The 12-edge point pairs (`Line`'s `segments` mode: consecutive pairs are
 *  independent segments, not a connected polyline) for a bounds box, used to
 *  draw a tight region's `bounds` as a wireframe. */
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

const FIRST_PART_COLOR = "#5b8dee";
const SECOND_PART_COLOR = "#e0a458";
const TIGHT_REGION_COLOR = "#ef9e43";
const INTERFERENCE_COLOR = "#ff5a67";
const MEASUREMENT_COLOR = "#ffe066";

function PartMesh({
  instances,
  origin,
  color,
}: {
  instances: readonly PlacedInstance[];
  origin: Vector3;
  color: string;
}) {
  const geometries = useMemo(
    () =>
      instances.map((instance) => ({
        id: instance.id,
        geometry: baseMeshGeometry(instance.mesh, instance.matrix, origin),
      })),
    [instances, origin],
  );
  useEffect(
    () => () => geometries.forEach((entry) => entry.geometry.dispose()),
    [geometries],
  );
  return (
    <>
      {geometries.map((entry) => (
        <mesh key={entry.id} geometry={entry.geometry}>
          <meshStandardMaterial
            color={color}
            roughness={0.68}
            metalness={0.05}
            transparent
            opacity={0.55}
            side={DoubleSide}
          />
        </mesh>
      ))}
    </>
  );
}

function ClosestPointOverlay({
  first,
  second,
  origin,
  sceneSize,
}: {
  first: [number, number, number];
  second: [number, number, number];
  origin: Vector3;
  sceneSize: number;
}) {
  const a: [number, number, number] = [
    first[0] - origin.x,
    first[1] - origin.y,
    first[2] - origin.z,
  ];
  const b: [number, number, number] = [
    second[0] - origin.x,
    second[1] - origin.y,
    second[2] - origin.z,
  ];
  const markerRadius = Math.max(sceneSize * 0.008, 0.05);
  return (
    <>
      <Line
        points={[a, b]}
        color={MEASUREMENT_COLOR}
        lineWidth={2.2}
        depthTest={false}
        renderOrder={5}
      />
      <mesh position={a} renderOrder={5}>
        <sphereGeometry args={[markerRadius, 12, 12]} />
        <meshBasicMaterial color={MEASUREMENT_COLOR} depthTest={false} />
      </mesh>
      <mesh position={b} renderOrder={5}>
        <sphereGeometry args={[markerRadius, 12, 12]} />
        <meshBasicMaterial color={MEASUREMENT_COLOR} depthTest={false} />
      </mesh>
    </>
  );
}

function TightRegionOverlay({
  regions,
  origin,
}: {
  regions: readonly ClearanceTightRegion[];
  origin: Vector3;
}) {
  return (
    <>
      {regions.map((region) => {
        const min = new Vector3(...region.bounds.min).sub(origin);
        const max = new Vector3(...region.bounds.max).sub(origin);
        return (
          <Line
            key={region.id}
            points={boxEdgePoints(min, max)}
            segments
            color={TIGHT_REGION_COLOR}
            lineWidth={1.6}
            transparent
            opacity={0.85}
            depthTest={false}
          />
        );
      })}
    </>
  );
}

function InterferenceOverlay({
  pairs,
  firstLookup,
  secondLookup,
  origin,
}: {
  pairs: readonly ClearanceTrianglePair[];
  firstLookup: TriangleLookup;
  secondLookup: TriangleLookup;
  origin: Vector3;
}) {
  const items = useMemo(() => {
    const built: { key: string; geometry: BufferGeometry }[] = [];
    pairs.forEach((pair, index) => {
      const first = firstLookup.locate(pair.firstTriangleIndex);
      const second = secondLookup.locate(pair.secondTriangleIndex);
      for (const [side, located] of [
        ["first", first],
        ["second", second],
      ] as const) {
        if (!located) continue;
        const corners = triangleCorners(
          located.instance,
          located.localTriangleIndex,
          origin,
        );
        const positions = new Float32Array(9);
        corners.forEach((corner, cornerIndex) => {
          positions[cornerIndex * 3] = corner.x;
          positions[cornerIndex * 3 + 1] = corner.y;
          positions[cornerIndex * 3 + 2] = corner.z;
        });
        const geometry = new BufferGeometry();
        geometry.setAttribute("position", new BufferAttribute(positions, 3));
        geometry.computeBoundingSphere();
        built.push({ key: `${side}.${index}`, geometry });
      }
    });
    return built;
  }, [pairs, firstLookup, secondLookup, origin]);
  useEffect(
    () => () => items.forEach((item) => item.geometry.dispose()),
    [items],
  );
  return (
    <>
      {items.map((item) => (
        <mesh key={item.key} geometry={item.geometry} renderOrder={4}>
          <meshBasicMaterial
            color={INTERFERENCE_COLOR}
            side={DoubleSide}
            transparent
            opacity={0.95}
            depthTest={false}
          />
        </mesh>
      ))}
    </>
  );
}

function ClearanceScene({
  first,
  second,
  result,
  origin,
  renderable,
  sceneSize,
  accessibleLabel,
}: {
  first: PlacedInstance[];
  second: PlacedInstance[];
  result: ClearanceCheckComplete;
  origin: Vector3;
  renderable: boolean;
  sceneSize: number;
  accessibleLabel: string;
}) {
  const [available, setAvailable] = useState(false);
  useEffect(() => setAvailable(probeWebGLAvailability()), []);
  const firstLookup = useMemo(() => triangleLookupFor(first), [first]);
  const secondLookup = useMemo(() => triangleLookupFor(second), [second]);
  const fallback = (
    <div className="render-fallback" role="status">
      3D fit preview unavailable. The verdict, distances, and region/
      interference lists above remain fully accessible and are not a degraded
      substitute for it.
    </div>
  );
  if (!renderable)
    return (
      <div className="render-fallback" role="status">
        3D fit preview withheld because the combined span of both parts exceeds
        the precision-safe rendering range. The textual report above remains
        complete.
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
        <PartMesh instances={first} origin={origin} color={FIRST_PART_COLOR} />
        <PartMesh
          instances={second}
          origin={origin}
          color={SECOND_PART_COLOR}
        />
        <ClosestPointOverlay
          first={result.closestPoints.first}
          second={result.closestPoints.second}
          origin={origin}
          sceneSize={sceneSize}
        />
        <TightRegionOverlay
          regions={result.tightRegions.regions}
          origin={origin}
        />
        <InterferenceOverlay
          pairs={result.interference.trianglePairs}
          firstLookup={firstLookup}
          secondLookup={secondLookup}
          origin={origin}
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
 * 3D fit preview for `/tools/clearance-fit/`: both parts placed exactly the
 * way `checkClearance` measured them (each part's own `modelToComparison`
 * honoured, never re-aligned), overlaid with the closest-point measurement
 * line, every ranked tight region's bounding box, and every reported
 * interfering triangle pair. Scoped deliberately small, next to
 * `MeshHealthViewer`: one viewport, no selection state, no cross-section --
 * the textual fit report (rendered by `ClearanceFlow`) is the accessible,
 * always-available equivalent, per this viewer's own `role="img"` accessible
 * name and non-canvas fallbacks above.
 */
export function ClearanceViewer({
  first,
  second,
  result,
  accessibleLabel,
}: ClearanceViewerProps) {
  const firstInstances = useMemo(
    () => partInstances(first.model, first.modelToComparison),
    [first.model, first.modelToComparison],
  );
  const secondInstances = useMemo(
    () => partInstances(second.model, second.modelToComparison),
    [second.model, second.modelToComparison],
  );
  const renderFrame = useMemo(
    () => renderFrameFor(firstInstances, secondInstances),
    [firstInstances, secondInstances],
  );
  return (
    <div className="clearance-viewport viewport-canvas">
      <ClearanceScene
        first={firstInstances}
        second={secondInstances}
        result={result}
        origin={renderFrame.origin}
        renderable={renderFrame.renderable}
        sceneSize={renderFrame.size}
        accessibleLabel={accessibleLabel}
      />
    </div>
  );
}
