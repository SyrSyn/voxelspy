import { OrbitControls } from "@react-three/drei";
import { Canvas, useThree } from "@react-three/fiber";
import type {
  AnalysisResult,
  NormalizedModel,
  RegionId,
} from "@voxelspy/contracts";
import {
  Component,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
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
  Plane,
  Vector3,
} from "three";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import type {
  ModelComparisonPresentationSummary,
  NumericDelta,
} from "@voxelspy/analysis";
import { summarizeModelComparisonAsync } from "./summary-worker-client";

type ViewKind = "baseline" | "difference" | "candidate";
type CameraState = {
  position: [number, number, number];
  target: [number, number, number];
  revision: number;
};
type CompleteOutcome = Extract<
  AnalysisResult["outcome"],
  { state: "complete" }
>;
type ChangeRegion = CompleteOutcome["regions"][number];
type AnalysisMetric = CompleteOutcome["metrics"][number];

export interface WorkbenchSessionPanelProps {
  onSave: () => void;
  status: "idle" | "saving" | "error";
  error?: string | undefined;
}

export interface WorkbenchProps {
  baseline: NormalizedModel;
  candidate: NormalizedModel;
  analysis: AnalysisResult;
  onReset?: () => void;
  title?: string;
  label?: string;
  headerAction?: ReactNode;
  variant?: "default" | "sample";
  enableKeyboardShortcuts?: boolean;
  sessionPanel?: WorkbenchSessionPanelProps;
}

const identity = new Matrix4();
const MAX_PRECISION_SAFE_RENDER_SPAN_MILLIMETRES = 500_000;
const semanticColors = {
  added: "#35d07f",
  removed: "#ff5a67",
  deviation: "#c783ff",
} as const;
const modelPalettes = {
  neutral: {
    label: "Neutral",
    baseline: "#7e9188",
    candidate: "#a7b3ad",
    differenceBaseline: "#87918c",
    differenceCandidate: "#c0c7c3",
  },
  blueprint: {
    label: "Blueprint",
    baseline: "#3274c8",
    candidate: "#78aaf0",
    differenceBaseline: "#627587",
    differenceCandidate: "#b1bdc8",
  },
  clay: {
    label: "Warm clay",
    baseline: "#a96045",
    candidate: "#dda27f",
    differenceBaseline: "#806f68",
    differenceCandidate: "#c7bbb5",
  },
  contrast: {
    label: "High contrast",
    baseline: "#5d70dd",
    candidate: "#f1c75b",
    differenceBaseline: "#69717d",
    differenceCandidate: "#d5d7db",
  },
} as const;
type ModelPaletteId = keyof typeof modelPalettes;

function modelInstances(
  model: NormalizedModel,
  modelToComparison: Matrix4 = identity,
) {
  const meshById = new Map(model.meshes.map((mesh) => [mesh.id, mesh]));
  if (model.placement.kind === "flat") {
    return model.placement.instances.map((instance) => ({
      id: instance.id,
      mesh: meshById.get(instance.meshId)!,
      matrix: modelToComparison
        .clone()
        .multiply(new Matrix4().fromArray(instance.meshToModel)),
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
    .map((id) => ({ id, parent: modelToComparison }));
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

function geometryFor(
  mesh: NormalizedModel["meshes"][number],
  matrix: Matrix4,
  origin: Vector3,
) {
  const geometry = new BufferGeometry();
  const positions = toRenderPositions(mesh.geometry.positions, matrix, origin);
  geometry.setAttribute("position", new BufferAttribute(positions, 3));
  geometry.setIndex(new BufferAttribute(mesh.geometry.indices, 1));
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  return geometry;
}

export function toRenderPositions(
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

function modelBounds(model: NormalizedModel, modelToComparison = identity) {
  const bounds = new Box3();
  const point = new Vector3();
  for (const instance of modelInstances(model, modelToComparison)) {
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

function renderFrameFor(
  baseline: NormalizedModel,
  candidate: NormalizedModel,
  baselineToComparison = identity,
  candidateToComparison = identity,
) {
  const bounds = modelBounds(baseline, baselineToComparison).union(
    modelBounds(candidate, candidateToComparison),
  );
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
  return { bounds, origin: safeBoundsCenter(bounds), renderable, size };
}

function initialCameraFor(size: number): CameraState {
  return {
    position: [size * 0.8, size * 0.62, size * 0.82],
    target: [0, 0, 0],
    revision: 0,
  };
}

function hasWebGL() {
  if (typeof document === "undefined") return false;
  try {
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
    context?.getExtension("WEBGL_lose_context")?.loseContext();
    return context !== null;
  } catch {
    return false;
  }
}

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

function CameraBridge({
  state,
  publish,
}: {
  state: CameraState;
  publish: (state: Omit<CameraState, "revision">) => void;
}) {
  const controls = useRef<OrbitControlsImpl>(null);
  const interacting = useRef(false);
  const { camera, invalidate } = useThree();
  useEffect(() => {
    if (!controls.current || interacting.current) return;
    camera.position.set(...state.position);
    controls.current.target.set(...state.target);
    camera.updateProjectionMatrix();
    controls.current.update();
    invalidate();
  }, [camera, invalidate, state]);
  const send = () => {
    if (!controls.current) return;
    publish({
      position: camera.position.toArray() as [number, number, number],
      target: controls.current.target.toArray() as [number, number, number],
    });
  };
  return (
    <OrbitControls
      ref={controls}
      makeDefault
      enableDamping={false}
      minDistance={0.01}
      maxDistance={1e9}
      onStart={() => {
        interacting.current = true;
      }}
      onChange={() => {
        if (interacting.current) send();
      }}
      onEnd={() => {
        send();
        interacting.current = false;
      }}
    />
  );
}

const ModelMeshes = memo(function ModelMeshes({
  model,
  color,
  opacity = 1,
  wireframe = false,
  clippingPlanes,
  origin,
  modelToComparison,
}: {
  model: NormalizedModel;
  color: string;
  opacity?: number;
  wireframe?: boolean;
  clippingPlanes: Plane[];
  origin: Vector3;
  modelToComparison: Matrix4;
}) {
  const instances = useMemo(
    () =>
      modelInstances(model, modelToComparison).map((instance) => ({
        ...instance,
        geometry: geometryFor(instance.mesh, instance.matrix, origin),
      })),
    [model, modelToComparison, origin],
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
            color={color}
            roughness={0.62}
            metalness={0.08}
            transparent={opacity < 1}
            opacity={opacity}
            wireframe={wireframe}
            clippingPlanes={clippingPlanes}
          />
        </mesh>
      ))}
    </>
  );
});

export function regionSurfaceGeometry(
  model: NormalizedModel,
  modelToComparison: Matrix4,
  triangleIndices: readonly number[],
  origin: Vector3,
) {
  const selected = new Set(triangleIndices);
  const positions: number[] = [];
  const point = new Vector3();
  let triangleIndex = 0;
  for (const instance of modelInstances(model, modelToComparison)) {
    const source = instance.mesh.geometry;
    for (let index = 0; index < source.indices.length; index += 3) {
      if (selected.has(triangleIndex)) {
        for (let corner = 0; corner < 3; corner += 1) {
          const vertex = source.indices[index + corner]! * 3;
          point
            .set(
              source.positions[vertex]!,
              source.positions[vertex + 1]!,
              source.positions[vertex + 2]!,
            )
            .applyMatrix4(instance.matrix)
            .sub(origin);
          positions.push(point.x, point.y, point.z);
        }
      }
      triangleIndex += 1;
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute(
    "position",
    new BufferAttribute(new Float32Array(positions), 3),
  );
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  return geometry;
}

function RegionSurfaces({
  analysis,
  baseline,
  candidate,
  baselineToComparison,
  candidateToComparison,
  selected,
  select,
  origin,
  sceneSize,
}: {
  analysis: AnalysisResult;
  baseline: NormalizedModel;
  candidate: NormalizedModel;
  baselineToComparison: Matrix4;
  candidateToComparison: Matrix4;
  selected: RegionId | undefined;
  select: (id: RegionId) => void;
  origin: Vector3;
  sceneSize: number;
}) {
  const surfaces = useMemo(() => {
    if (analysis.outcome.state !== "complete") return [];
    return analysis.outcome.regions.map((region) => {
      if (region.geometry === undefined) return { region };
      const isBaseline = region.geometry.model === "baseline";
      return {
        region,
        geometry: regionSurfaceGeometry(
          isBaseline ? baseline : candidate,
          isBaseline ? baselineToComparison : candidateToComparison,
          region.geometry.triangleIndices,
          origin,
        ),
      };
    });
  }, [
    analysis,
    baseline,
    baselineToComparison,
    candidate,
    candidateToComparison,
    origin,
  ]);
  useEffect(
    () => () =>
      surfaces.forEach((surface) => {
        surface.geometry?.dispose();
      }),
    [surfaces],
  );
  if (analysis.outcome.state !== "complete") return null;
  return (
    <>
      {surfaces.map(({ region, geometry }) => {
        const color = semanticColors[region.category];
        const isSelected = selected === region.id;
        if (
          geometry !== undefined &&
          geometry.getAttribute("position").count > 0
        ) {
          return (
            <mesh
              key={region.id}
              geometry={geometry}
              renderOrder={isSelected ? 4 : 3}
              onClick={(event) => {
                event.stopPropagation();
                select(region.id);
              }}
            >
              <meshStandardMaterial
                color={color}
                emissive={color}
                emissiveIntensity={isSelected ? 0.28 : 0.1}
                roughness={0.58}
                metalness={0.04}
                side={DoubleSide}
                transparent
                opacity={isSelected ? 1 : 0.78}
                polygonOffset
                polygonOffsetFactor={-1}
                polygonOffsetUnits={-1}
              />
            </mesh>
          );
        }
        const anchor = new Vector3(...region.anchor).sub(origin);
        return (
          <mesh
            key={region.id}
            position={anchor}
            onClick={(event) => {
              event.stopPropagation();
              select(region.id);
            }}
          >
            <sphereGeometry
              args={[
                Math.max(sceneSize * (isSelected ? 0.018 : 0.012), 0.01),
                16,
                12,
              ]}
            />
            <meshBasicMaterial color={color} depthTest={false} />
          </mesh>
        );
      })}
    </>
  );
}

function Scene({
  kind,
  baseline,
  candidate,
  analysis,
  camera,
  clip,
  selected,
  publish,
  select,
  origin,
  renderable,
  sceneSize,
  palette,
  baselineToComparison,
  candidateToComparison,
}: WorkbenchProps & {
  kind: ViewKind;
  camera: CameraState;
  clip: number;
  selected: RegionId | undefined;
  publish: (state: Omit<CameraState, "revision">) => void;
  select: (id: RegionId) => void;
  origin: Vector3;
  renderable: boolean;
  sceneSize: number;
  palette: (typeof modelPalettes)[ModelPaletteId];
  baselineToComparison: Matrix4;
  candidateToComparison: Matrix4;
}) {
  const [available, setAvailable] = useState(false);
  useEffect(() => setAvailable(hasWebGL()), []);
  const bounds = useMemo(() => {
    const value = modelBounds(baseline, baselineToComparison).union(
      modelBounds(candidate, candidateToComparison),
    );
    value.min.sub(origin);
    value.max.sub(origin);
    return value;
  }, [
    baseline,
    baselineToComparison,
    candidate,
    candidateToComparison,
    origin,
  ]);
  const clipPlane = useMemo(() => {
    if (clip >= 100) return [];
    const min = bounds.min.x;
    const max = bounds.max.x;
    return [new Plane(new Vector3(-1, 0, 0), min + (clip / 100) * (max - min))];
  }, [bounds, clip]);
  const fallback = (
    <div className="render-fallback" role="status">
      3D preview unavailable. Imported details and ranked findings remain
      accessible.
    </div>
  );
  if (!renderable)
    return (
      <div className="render-fallback" role="status">
        3D preview withheld because the model span exceeds the precision-safe
        rendering range. Import and analysis evidence remain available.
      </div>
    );
  if (!available) return fallback;
  return (
    <RenderBoundary fallback={fallback}>
      <Canvas
        camera={{
          position: camera.position,
          fov: 38,
          near: 0.001,
          far: Math.max(sceneSize * 12, 1_000),
        }}
        frameloop="demand"
        dpr={[1, 1.5]}
        gl={{
          antialias: true,
          localClippingEnabled: true,
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
      >
        <color attach="background" args={["#111815"]} />
        <ambientLight intensity={1.35} />
        <directionalLight position={[4, 8, 6]} intensity={2.2} />
        {kind === "baseline" && (
          <ModelMeshes
            model={baseline}
            color={palette.baseline}
            clippingPlanes={clipPlane}
            origin={origin}
            modelToComparison={baselineToComparison}
          />
        )}
        {kind === "candidate" && (
          <ModelMeshes
            model={candidate}
            color={palette.candidate}
            clippingPlanes={clipPlane}
            origin={origin}
            modelToComparison={candidateToComparison}
          />
        )}
        {kind === "difference" && (
          <>
            <ModelMeshes
              model={baseline}
              color={palette.differenceBaseline}
              opacity={0.24}
              wireframe
              clippingPlanes={clipPlane}
              origin={origin}
              modelToComparison={baselineToComparison}
            />
            <ModelMeshes
              model={candidate}
              color={palette.differenceCandidate}
              opacity={0.58}
              clippingPlanes={clipPlane}
              origin={origin}
              modelToComparison={candidateToComparison}
            />
            <RegionSurfaces
              analysis={analysis}
              baseline={baseline}
              candidate={candidate}
              baselineToComparison={baselineToComparison}
              candidateToComparison={candidateToComparison}
              selected={selected}
              select={select}
              origin={origin}
              sceneSize={sceneSize}
            />
          </>
        )}
        <CameraBridge state={camera} publish={publish} />
      </Canvas>
    </RenderBoundary>
  );
}

function formatMetric(value: number, unit: string) {
  const labels: Record<string, string> = {
    millimetre: "mm",
    "square-millimetre": "mm²",
    "cubic-millimetre": "mm³",
    ratio: "",
    count: "",
  };
  return `${Number.isInteger(value) ? value : value.toPrecision(4)} ${labels[unit] ?? unit}`.trim();
}

function formatRegionMetric(metric: AnalysisMetric) {
  const label = metric.id.endsWith("maximum-distance")
    ? "Max"
    : metric.id.endsWith("mean-distance")
      ? "Mean"
      : metric.id.endsWith("triangle-count")
        ? "Triangles"
        : metric.id.endsWith("area")
          ? "Area"
          : "Measure";
  return `${label} ${formatMetric(metric.value, metric.unit)}`;
}

function sourceUnitLabel(unit: NormalizedModel["provenance"]["sourceUnit"]) {
  return {
    micrometre: "micrometres",
    millimetre: "millimetres",
    centimetre: "centimetres",
    metre: "metres",
    inch: "inches",
    foot: "feet",
  }[unit];
}

function sourceAxisLabel(axis: NormalizedModel["provenance"]["sourceAxis"]) {
  return axis === "right-handed-z-up"
    ? "right-handed, Z up"
    : "right-handed, Y up";
}

function sourceResolutionLabel(
  resolution: NormalizedModel["provenance"]["sourceResolution"]["unit"],
) {
  return resolution === "declared"
    ? "default"
    : resolution === "user"
      ? "expert selection"
      : "embedded";
}

function transformRows(transform: readonly number[]) {
  return [0, 1, 2, 3].map((row) =>
    [0, 1, 2, 3]
      .map((column) => transform[column * 4 + row] ?? 0)
      .map((value) => (Object.is(value, -0) ? "0" : String(value)))
      .join("  "),
  );
}

function portableValue(value: unknown) {
  return JSON.stringify(value);
}

function conciseNumber(value: number) {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: Math.abs(value) < 10 ? 2 : 1,
  }).format(value);
}

function conciseDelta(delta: NumericDelta, unit = "") {
  if (delta.direction === "unchanged") return "No change";
  const prefix = delta.difference > 0 ? "+" : "";
  return `${prefix}${conciseNumber(delta.difference)}${unit}`;
}

function volumeReasonLabel(reason: string) {
  return (
    {
      "empty-geometry": "empty geometry",
      "degenerate-triangles": "degenerate triangles",
      "boundary-edges": "open boundary edges",
      "non-manifold-edges": "non-manifold edges",
      "inconsistent-orientation": "inconsistent orientation",
    }[reason] ?? reason.replaceAll("-", " ")
  );
}

type GeometrySummaryState =
  | { status: "loading" }
  | { status: "ready"; summary: ModelComparisonPresentationSummary }
  | { status: "error"; message: string };

function GeometrySummary({ state }: { state: GeometrySummaryState }) {
  if (state.status === "loading") {
    return (
      <section
        className="geometry-summary"
        aria-labelledby="geometry-summary-title"
      >
        <h3 id="geometry-summary-title">Geometry</h3>
        <p role="status" aria-live="polite">
          Computing geometry summary…
        </p>
      </section>
    );
  }
  if (state.status === "error") {
    return (
      <section
        className="geometry-summary"
        aria-labelledby="geometry-summary-title"
      >
        <h3 id="geometry-summary-title">Geometry</h3>
        <p role="status" aria-live="polite">
          Geometry summary unavailable: {state.message}
        </p>
      </section>
    );
  }
  return <GeometrySummaryTable summary={state.summary} />;
}

function GeometrySummaryTable({
  summary,
}: {
  summary: ModelComparisonPresentationSummary;
}) {
  const baselineDimensions = summary.baseline.bounds.available
    ? summary.baseline.bounds.dimensionsMillimetres
        .map(conciseNumber)
        .join(" × ")
    : "Unavailable";
  const candidateDimensions = summary.candidate.bounds.available
    ? summary.candidate.bounds.dimensionsMillimetres
        .map(conciseNumber)
        .join(" × ")
    : "Unavailable";
  const dimensionDelta = summary.deltas.dimensionsMillimetres.available
    ? [
        summary.deltas.dimensionsMillimetres.x,
        summary.deltas.dimensionsMillimetres.y,
        summary.deltas.dimensionsMillimetres.z,
      ].every((delta) => delta.direction === "unchanged")
      ? "No change"
      : [
          summary.deltas.dimensionsMillimetres.x,
          summary.deltas.dimensionsMillimetres.y,
          summary.deltas.dimensionsMillimetres.z,
        ]
          .map(
            (delta, index) =>
              `${["X", "Y", "Z"][index]} ${conciseDelta(delta)}`,
          )
          .join(" · ")
    : "Unavailable";
  const baselineVolume = summary.baseline.volume.available
    ? conciseNumber(summary.baseline.volume.absoluteCubicMillimetres)
    : "Not valid";
  const candidateVolume = summary.candidate.volume.available
    ? conciseNumber(summary.candidate.volume.absoluteCubicMillimetres)
    : "Not valid";
  const volumeDelta = summary.deltas.absoluteVolumeCubicMillimetres.available
    ? conciseDelta(summary.deltas.absoluteVolumeCubicMillimetres, " mm³")
    : "Unavailable";
  return (
    <section
      className="geometry-summary"
      aria-labelledby="geometry-summary-title"
    >
      <h3 id="geometry-summary-title">Geometry</h3>
      <div className="geometry-table" role="table">
        <div className="geometry-table-head" role="row">
          <span role="columnheader">Measure</span>
          <span role="columnheader">Reference → revision</span>
          <span role="columnheader">Delta</span>
        </div>
        <div role="row">
          <strong role="rowheader">Size (mm)</strong>
          <span>
            {baselineDimensions} → {candidateDimensions}
          </span>
          <span>{dimensionDelta}</span>
        </div>
        <div role="row">
          <strong role="rowheader">Triangles</strong>
          <span>
            {summary.baseline.triangleCount} → {summary.candidate.triangleCount}
          </span>
          <span>{conciseDelta(summary.deltas.triangleCount)}</span>
        </div>
        <div role="row">
          <strong role="rowheader">Area (mm²)</strong>
          <span>
            {conciseNumber(summary.baseline.surfaceAreaSquareMillimetres)} →{" "}
            {conciseNumber(summary.candidate.surfaceAreaSquareMillimetres)}
          </span>
          <span>
            {conciseDelta(summary.deltas.surfaceAreaSquareMillimetres, " mm²")}
          </span>
        </div>
        <div role="row">
          <strong role="rowheader">Volume (mm³)</strong>
          <span>
            {baselineVolume} → {candidateVolume}
          </span>
          <span>{volumeDelta}</span>
        </div>
      </div>
      {(!summary.baseline.volume.available ||
        !summary.candidate.volume.available) && (
        <p>
          Volume withheld
          {!summary.baseline.volume.available &&
            ` · Ref: ${summary.baseline.volume.reasons
              .map(volumeReasonLabel)
              .join(", ")}`}
          {!summary.candidate.volume.available &&
            ` · Rev: ${summary.candidate.volume.reasons
              .map(volumeReasonLabel)
              .join(", ")}`}
        </p>
      )}
    </section>
  );
}

function ModelEvidence({
  label,
  model,
}: {
  label: "Baseline" | "Candidate";
  model: NormalizedModel;
}) {
  const provenance = model.provenance;
  return (
    <article className="source-card">
      <span className="eyebrow">{label} import</span>
      <h3>{provenance.sourceName}</h3>
      <dl>
        <div>
          <dt>Selected source unit</dt>
          <dd>
            {sourceUnitLabel(provenance.sourceUnit)} ·{" "}
            {sourceResolutionLabel(provenance.sourceResolution.unit)}
          </dd>
        </div>
        <div>
          <dt>Selected source up-axis</dt>
          <dd>
            {sourceAxisLabel(provenance.sourceAxis)} ·{" "}
            {sourceResolutionLabel(provenance.sourceResolution.axis)}
          </dd>
        </div>
        <div>
          <dt>Detected source frame</dt>
          <dd>
            Unit {provenance.detectedSourceUnit}; axis{" "}
            {provenance.detectedSourceAxis}
          </dd>
        </div>
      </dl>
      <details open>
        <summary>Normalization and provenance</summary>
        <p>
          Source to model transform (rows; canonical model frame is millimetres,
          right-handed Z up):
        </p>
        <ol aria-label={`${label} source-to-model transform rows`}>
          {transformRows(provenance.appliedSourceToModel).map((row, index) => (
            <li key={index}>
              <code>{row}</code>
            </li>
          ))}
        </ol>
        <dl>
          <div>
            <dt>Format</dt>
            <dd>{provenance.formatId}</dd>
          </div>
          <div>
            <dt>Importer</dt>
            <dd>
              {provenance.importerId} {provenance.importerVersion}
            </dd>
          </div>
          {provenance.sourceDigest && (
            <div>
              <dt>Source SHA-256</dt>
              <dd>
                <code>
                  {provenance.sourceDigest.value.match(/.{1,8}/gu)?.join(" ")}
                </code>
              </dd>
            </div>
          )}
        </dl>
      </details>
      <section aria-labelledby={`${label.toLocaleLowerCase("en-US")}-warnings`}>
        <h4 id={`${label.toLocaleLowerCase("en-US")}-warnings`}>
          Import warnings
        </h4>
        {model.warnings.length === 0 ? (
          <p>No import warnings.</p>
        ) : (
          <ul>
            {model.warnings.map((warning) => (
              <li key={warning.code}>
                <strong>{warning.code}</strong> ({warning.severity}):{" "}
                {warning.message}
                {warning.location && <> Location: {warning.location}.</>}
                {warning.details && (
                  <code> {portableValue(warning.details)}</code>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section aria-labelledby={`${label.toLocaleLowerCase("en-US")}-notes`}>
        <h4 id={`${label.toLocaleLowerCase("en-US")}-notes`}>Importer notes</h4>
        {provenance.notes.length === 0 ? (
          <p>No importer notes.</p>
        ) : (
          <ul>
            {provenance.notes.map((note, index) => (
              <li key={`${index}-${note}`}>{note}</li>
            ))}
          </ul>
        )}
      </section>
    </article>
  );
}

function AnalysisEvidence({ analysis }: { analysis: AnalysisResult }) {
  const outcome = analysis.outcome;
  return (
    <section className="method-card" aria-labelledby="analysis-evidence-title">
      <div>
        <span className="eyebrow">Method evidence</span>
        <h2 id="analysis-evidence-title">Analysis interpretation</h2>
        <p>
          {outcome.requestedMethod.id} {outcome.requestedMethod.version} ·{" "}
          {outcome.state}
        </p>
      </div>
      <div>
        <h3>Analysis warnings</h3>
        {analysis.warnings.length === 0 ? (
          <p>No analysis warnings.</p>
        ) : (
          <ul>
            {analysis.warnings.map((warning) => (
              <li key={warning.code}>
                <strong>{warning.code}</strong> ({warning.severity}):{" "}
                {warning.message}
                {warning.location && <> Location: {warning.location}.</>}
                {warning.details && (
                  <code> {portableValue(warning.details)}</code>
                )}
              </li>
            ))}
          </ul>
        )}
        {outcome.state === "complete" &&
          outcome.semantics === "approximate" && (
            <section aria-labelledby="analysis-uncertainty-title">
              <h3 id="analysis-uncertainty-title">
                Approximation and uncertainty
              </h3>
              <p>{outcome.uncertainty.description}</p>
              <dl>
                {Object.entries(outcome.uncertainty.parameters).map(
                  ([key, value]) => (
                    <div key={key}>
                      <dt>{key}</dt>
                      <dd>
                        <code>{portableValue(value)}</code>
                      </dd>
                    </div>
                  ),
                )}
              </dl>
            </section>
          )}
        {outcome.state === "complete" && outcome.adjustments.length > 0 && (
          <section aria-labelledby="analysis-adjustments-title">
            <h3 id="analysis-adjustments-title">Analysis adjustments</h3>
            <ul>
              {outcome.adjustments.map((adjustment, index) => (
                <li key={`${adjustment.field}-${index}`}>
                  <strong>{adjustment.field}:</strong> {adjustment.reason}
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </section>
  );
}

export function Workbench({
  baseline,
  candidate,
  analysis,
  onReset,
  title = "Comparison workbench",
  label,
  headerAction,
  variant = "default",
  enableKeyboardShortcuts = true,
  sessionPanel,
}: WorkbenchProps) {
  const baselineToComparison = useMemo(
    () => new Matrix4().fromArray(analysis.baseline.modelToComparison),
    [analysis.baseline.modelToComparison],
  );
  const candidateToComparison = useMemo(
    () => new Matrix4().fromArray(analysis.candidate.modelToComparison),
    [analysis.candidate.modelToComparison],
  );
  const renderFrame = useMemo(
    () =>
      renderFrameFor(
        baseline,
        candidate,
        baselineToComparison,
        candidateToComparison,
      ),
    [baseline, baselineToComparison, candidate, candidateToComparison],
  );
  const { origin } = renderFrame;
  const initial = useMemo(
    () => initialCameraFor(renderFrame.size),
    [renderFrame.size],
  );
  const [camera, setCamera] = useState(initial);
  const [clip, setClip] = useState(100);
  const [paletteId, setPaletteId] = useState<ModelPaletteId>("neutral");
  const [summaryState, setSummaryState] = useState<GeometrySummaryState>({
    status: "loading",
  });
  useEffect(() => {
    // Full-topology summarization (re-transforming every vertex, exact-edge
    // maps, union-find over every triangle) is heavy enough on large models
    // to freeze the render thread for seconds to minutes, so it always runs
    // in a dedicated worker. The AbortController doubles as the stale-result
    // guard: switching to a different baseline/candidate/analysis (or
    // unmounting) aborts the in-flight request below before this effect
    // re-runs, so a late response from a superseded request is dropped
    // instead of overwriting newer state.
    setSummaryState({ status: "loading" });
    const controller = new AbortController();
    summarizeModelComparisonAsync(
      baseline,
      candidate,
      analysis,
      controller.signal,
    )
      .then((summary) => {
        setSummaryState({ status: "ready", summary });
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError")
          return;
        setSummaryState({
          status: "error",
          message:
            error instanceof Error
              ? error.message
              : "Geometry summary unavailable.",
        });
      });
    return () => controller.abort();
  }, [analysis, baseline, candidate]);
  const ordered: RegionId[] =
    analysis.outcome.state === "complete"
      ? analysis.outcome.orderedRegionIds
      : [];
  const [selected, setSelected] = useState<RegionId | undefined>(ordered[0]);
  const regions: Map<RegionId, ChangeRegion> =
    analysis.outcome.state === "complete"
      ? new Map(analysis.outcome.regions.map((region) => [region.id, region]))
      : new Map();
  const metrics: Map<string, AnalysisMetric> =
    analysis.outcome.state === "complete"
      ? new Map(analysis.outcome.metrics.map((metric) => [metric.id, metric]))
      : new Map();
  const publish = useCallback(
    (next: Omit<CameraState, "revision">) =>
      setCamera((current) => ({ ...next, revision: current.revision + 1 })),
    [],
  );
  const select = useCallback(
    (id: RegionId) => {
      setSelected(id);
      if (!renderFrame.renderable) return;
      const region = regions.get(id);
      if (!region) return;
      const size = Math.max(
        ...region.bounds.max.map(
          (value, index) => value - region.bounds.min[index]!,
        ),
        1,
      );
      const anchor: [number, number, number] = [
        region.anchor[0] - origin.x,
        region.anchor[1] - origin.y,
        region.anchor[2] - origin.z,
      ];
      setCamera((current) => ({
        target: anchor,
        position: [
          anchor[0] + size * 2.6,
          anchor[1] + size * 1.8,
          anchor[2] + size * 2.8,
        ],
        revision: current.revision + 1,
      }));
    },
    [origin, regions, renderFrame.renderable],
  );
  useEffect(() => {
    if (!enableKeyboardShortcuts) return;
    const listener = (event: KeyboardEvent) => {
      if (
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLButtonElement ||
        event.target instanceof HTMLSelectElement ||
        event.target instanceof HTMLTextAreaElement ||
        event.target instanceof HTMLAnchorElement ||
        (event.target instanceof HTMLElement &&
          event.target.tagName === "SUMMARY") ||
        ordered.length === 0
      )
        return;
      if (event.key.toLocaleLowerCase("en-US") === "f")
        setCamera((current) => ({
          ...initial,
          revision: current.revision + 1,
        }));
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const current = selected ? ordered.indexOf(selected) : -1;
        const delta = event.key === "ArrowDown" ? 1 : -1;
        select(ordered[(current + delta + ordered.length) % ordered.length]!);
      }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [enableKeyboardShortcuts, initial, ordered, select, selected]);

  const semantics =
    analysis.outcome.state === "complete"
      ? analysis.outcome.semantics.replaceAll("-", " ")
      : "indeterminate";
  const selectedRegion = selected ? regions.get(selected) : undefined;
  const tolerance = analysis.outcome.requestedTolerance.distanceMillimetres;
  const renderViewport = (kind: ViewKind) => (
    <section className={`viewport viewport-${kind}`} key={kind}>
      <header>
        <span>
          {kind === "difference"
            ? "Analysis"
            : kind === "baseline"
              ? "Reference"
              : "Revision"}
        </span>
        <h2>{kind[0]!.toLocaleUpperCase("en-US") + kind.slice(1)}</h2>
      </header>
      <div className="viewport-canvas">
        <Scene
          kind={kind}
          baseline={baseline}
          candidate={candidate}
          analysis={analysis}
          camera={camera}
          clip={clip}
          selected={selected}
          publish={publish}
          select={select}
          origin={origin}
          renderable={renderFrame.renderable}
          sceneSize={renderFrame.size}
          palette={modelPalettes[paletteId]}
          baselineToComparison={baselineToComparison}
          candidateToComparison={candidateToComparison}
        />
        <span className="canvas-scroll-pad" aria-hidden="true">
          <i />
        </span>
      </div>
    </section>
  );
  return (
    <section
      className={`workbench workbench-${variant}`}
      aria-labelledby="workbench-title"
    >
      <header className="workbench-header">
        <div>
          <span className="eyebrow">
            {label ?? `Local analysis · ${semantics}`}
          </span>
          <h1 id="workbench-title">{title}</h1>
        </div>
        <div className="workbench-actions">
          <button
            type="button"
            className="button button-secondary"
            onClick={() =>
              setCamera((current) => ({
                ...initial,
                revision: current.revision + 1,
              }))
            }
          >
            Reset camera {enableKeyboardShortcuts && <kbd>F</kbd>}
          </button>
          {onReset && (
            <button
              type="button"
              className="button button-secondary"
              onClick={onReset}
            >
              New comparison
            </button>
          )}
          {headerAction}
        </div>
      </header>
      {sessionPanel && (
        <div className="session-panel">
          <button
            type="button"
            className="button button-secondary"
            onClick={sessionPanel.onSave}
            disabled={sessionPanel.status === "saving"}
          >
            {sessionPanel.status === "saving"
              ? "Saving session…"
              : "Save session"}
          </button>
          <p className="boundary-note">
            Saving embeds both models&rsquo; original geometry in the downloaded
            file, so sharing a saved session shares that model data.
          </p>
          {sessionPanel.status === "error" && sessionPanel.error && (
            <div className="comparison-error" role="alert">
              <strong>Session could not be saved</strong>
              <p>{sessionPanel.error}</p>
            </div>
          )}
        </div>
      )}
      <div className="workbench-toolbar">
        <div className="toolbar-controls">
          <label>
            Cross section{" "}
            <input
              type="range"
              min="0"
              max="100"
              value={clip}
              onChange={(event) => setClip(Number(event.currentTarget.value))}
            />
            <output>{clip === 100 ? "Off" : `${clip}%`}</output>
          </label>
          <label>
            Model colors
            <select
              value={paletteId}
              onChange={(event) =>
                setPaletteId(event.currentTarget.value as ModelPaletteId)
              }
            >
              {Object.entries(modelPalettes).map(([id, palette]) => (
                <option value={id} key={id}>
                  {palette.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <span>Orbit, pan, and zoom are synchronized across all views.</span>
      </div>
      <div className="workbench-stage">
        {renderViewport("difference")}
        <aside className="evidence-rail" aria-labelledby="findings-title">
          <header className="evidence-summary">
            <span className="eyebrow">Comparison summary</span>
            <h2>
              {analysis.outcome.state === "complete"
                ? "Analyzed"
                : "Needs attention"}
            </h2>
            <p>{semantics}</p>
          </header>
          <dl className="analysis-stats">
            <div>
              <dt>Method</dt>
              <dd>{analysis.outcome.requestedMethod.id}</dd>
            </div>
            <div>
              <dt>Tolerance</dt>
              <dd>
                {tolerance === undefined ? "Configured" : `${tolerance} mm`}
              </dd>
            </div>
            <div>
              <dt>Warnings</dt>
              <dd>{analysis.warnings.length}</dd>
            </div>
            <div>
              <dt>Regions</dt>
              <dd>{ordered.length}</dd>
            </div>
          </dl>
          <div className="change-legend" aria-label="Difference colors">
            <span>
              <i className="legend-added" /> Added
            </span>
            <span>
              <i className="legend-removed" /> Removed
            </span>
            <span>
              <i className="legend-shared" /> Shared
            </span>
            <span>
              <i className="legend-deviation" /> Deviation
            </span>
          </div>
          {selectedRegion && (
            <div className="selected-region" aria-live="polite">
              <span>Selected region</span>
              <strong>{selectedRegion.category}</strong>
              <small>
                {selectedRegion.metricIds
                  .map((metricId) => metrics.get(metricId))
                  .filter((metric) => metric !== undefined)
                  .map(formatRegionMetric)
                  .join(" · ") || "Bounded changed region"}
              </small>
            </div>
          )}
          <div className="findings">
            <header>
              <div>
                <span className="eyebrow">Ranked evidence</span>
                <h2 id="findings-title">Changed regions</h2>
              </div>
              <strong>{ordered.length}</strong>
            </header>
            {analysis.outcome.state === "indeterminate" ? (
              <div className="indeterminate" role="status">
                <h3>Region analysis unavailable</h3>
                <strong>{analysis.outcome.code}</strong>
                {analysis.outcome.reasons.map((reason) => (
                  <p key={reason}>{reason}</p>
                ))}
                {analysis.outcome.code === "resource-budget-exceeded" && (
                  <p>
                    Start a new comparison and raise the Analysis RAM allowance
                    if this device has capacity available.
                  </p>
                )}
              </div>
            ) : ordered.length === 0 ? (
              <p className="empty-findings">
                No bounded regions were emitted at this tolerance. This does not
                prove the models are equivalent.
              </p>
            ) : (
              <ol>
                {ordered.map((id, index) => {
                  const region = regions.get(id)!;
                  return (
                    <li key={id}>
                      <button
                        type="button"
                        aria-pressed={selected === id}
                        onClick={() => select(id)}
                      >
                        <span className="finding-rank">
                          {String(index + 1).padStart(2, "0")}
                        </span>
                        <i className={`finding-cue cue-${region.category}`} />
                        <span>
                          <strong>{region.category}</strong>
                          <small>
                            {region.metricIds
                              .map((metricId) => metrics.get(metricId))
                              .filter((metric) => metric !== undefined)
                              .map(formatRegionMetric)
                              .join(" · ") || "Bounded changed region"}
                          </small>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ol>
            )}
          </div>
          <GeometrySummary state={summaryState} />
        </aside>
        <div className="source-views">
          {renderViewport("baseline")}
          {renderViewport("candidate")}
        </div>
      </div>
      <a className="details-jump" href="#analysis-details">
        View analysis details ↓
      </a>
      <details className="technical-details" id="analysis-details">
        <summary>Analysis details</summary>
        <AnalysisEvidence analysis={analysis} />
      </details>
      <details className="technical-details">
        <summary>Import and provenance details</summary>
        <section aria-labelledby="import-evidence-title">
          <header className="section-heading evidence-heading">
            <span className="eyebrow">Source evidence</span>
            <h2 id="import-evidence-title">Import interpretation</h2>
            <p>
              Source frame, normalization, warnings, and provenance retained for
              this result.
            </p>
          </header>
          <div className="file-grid">
            <ModelEvidence label="Baseline" model={baseline} />
            <ModelEvidence label="Candidate" model={candidate} />
          </div>
        </section>
      </details>
      <footer className="workbench-footer">
        <span>
          <strong>Baseline:</strong> {baseline.provenance.sourceName}
        </span>
        <span>
          <strong>Candidate:</strong> {candidate.provenance.sourceName}
        </span>
        <span>Model data remains in this browser.</span>
      </footer>
    </section>
  );
}
