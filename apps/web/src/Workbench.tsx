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
  Matrix4,
  Plane,
  Vector3,
} from "three";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";

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

export interface WorkbenchProps {
  baseline: NormalizedModel;
  candidate: NormalizedModel;
  analysis: AnalysisResult;
  onReset?: () => void;
}

const identity = new Matrix4();

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
  const stack = model.placement.rootIds.map((id) => ({ id, parent: identity }));
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
    for (const childId of node.childIds)
      stack.push({ id: childId, parent: nodeMatrix });
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

function initialCameraFor(
  baseline: NormalizedModel,
  candidate: NormalizedModel,
): CameraState {
  const bounds = modelBounds(baseline).union(modelBounds(candidate));
  const size = Math.max(bounds.getSize(new Vector3()).length(), 1);
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
}: {
  model: NormalizedModel;
  color: string;
  opacity?: number;
  wireframe?: boolean;
  clippingPlanes: Plane[];
  origin: Vector3;
}) {
  const instances = useMemo(
    () =>
      modelInstances(model).map((instance) => ({
        ...instance,
        geometry: geometryFor(instance.mesh, instance.matrix, origin),
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

function RegionMarkers({
  analysis,
  selected,
  select,
  origin,
}: {
  analysis: AnalysisResult;
  selected: RegionId | undefined;
  select: (id: RegionId) => void;
  origin: Vector3;
}) {
  if (analysis.outcome.state !== "complete") return null;
  return (
    <>
      {analysis.outcome.regions.map((region) => {
        const min = new Vector3(...region.bounds.min);
        const max = new Vector3(...region.bounds.max);
        const size = max.clone().sub(min);
        const center = min.add(max).multiplyScalar(0.5).sub(origin);
        const color =
          region.category === "added"
            ? "#f0ad45"
            : region.category === "removed"
              ? "#43c5d4"
              : "#ed73a5";
        return (
          <mesh
            key={region.id}
            position={center}
            scale={selected === region.id ? 1.08 : 1}
            onClick={(event) => {
              event.stopPropagation();
              select(region.id);
            }}
          >
            <boxGeometry
              args={[
                Math.max(size.x, 0.001),
                Math.max(size.y, 0.001),
                Math.max(size.z, 0.001),
              ]}
            />
            <meshBasicMaterial
              color={color}
              wireframe
              transparent
              opacity={selected === region.id ? 1 : 0.72}
              depthTest={false}
            />
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
}: WorkbenchProps & {
  kind: ViewKind;
  camera: CameraState;
  clip: number;
  selected: RegionId | undefined;
  publish: (state: Omit<CameraState, "revision">) => void;
  select: (id: RegionId) => void;
  origin: Vector3;
}) {
  const [available, setAvailable] = useState(false);
  useEffect(() => setAvailable(hasWebGL()), []);
  const bounds = useMemo(() => {
    const value = modelBounds(baseline).union(modelBounds(candidate));
    value.min.sub(origin);
    value.max.sub(origin);
    return value;
  }, [baseline, candidate, origin]);
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
  if (!available) return fallback;
  return (
    <RenderBoundary fallback={fallback}>
      <Canvas
        camera={{ position: camera.position, fov: 38, near: 0.001, far: 1e12 }}
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
            color="#7e98a0"
            clippingPlanes={clipPlane}
            origin={origin}
          />
        )}
        {kind === "candidate" && (
          <ModelMeshes
            model={candidate}
            color="#90a4aa"
            clippingPlanes={clipPlane}
            origin={origin}
          />
        )}
        {kind === "difference" && (
          <>
            <ModelMeshes
              model={baseline}
              color="#46bdc9"
              opacity={0.38}
              wireframe
              clippingPlanes={clipPlane}
              origin={origin}
            />
            <ModelMeshes
              model={candidate}
              color="#e4a84a"
              opacity={0.65}
              clippingPlanes={clipPlane}
              origin={origin}
            />
            <RegionMarkers
              analysis={analysis}
              selected={selected}
              select={select}
              origin={origin}
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

export function Workbench({
  baseline,
  candidate,
  analysis,
  onReset,
}: WorkbenchProps) {
  const initial = useMemo(
    () => initialCameraFor(baseline, candidate),
    [baseline, candidate],
  );
  const origin = useMemo(
    () =>
      modelBounds(baseline)
        .union(modelBounds(candidate))
        .getCenter(new Vector3()),
    [baseline, candidate],
  );
  const [camera, setCamera] = useState(initial);
  const [clip, setClip] = useState(100);
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
    [origin, regions],
  );
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLButtonElement ||
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
  }, [initial, ordered, select, selected]);

  const semantics =
    analysis.outcome.state === "complete"
      ? analysis.outcome.semantics.replaceAll("-", " ")
      : "indeterminate";
  return (
    <section className="workbench" aria-labelledby="workbench-title">
      <header className="workbench-header">
        <div>
          <span className="eyebrow">Local analysis · {semantics}</span>
          <h1 id="workbench-title">Comparison workbench</h1>
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
            Fit all <kbd>F</kbd>
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
        </div>
      </header>
      <div className="workbench-toolbar">
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
        <span>Orbit, pan, and zoom are synchronized across all views.</span>
      </div>
      <div className="viewport-grid">
        {(["baseline", "difference", "candidate"] as const).map((kind) => (
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
              />
            </div>
          </section>
        ))}
      </div>
      <aside className="findings" aria-labelledby="findings-title">
        <header>
          <div>
            <span className="eyebrow">Ranked evidence</span>
            <h2 id="findings-title">Changed regions</h2>
          </div>
          <strong>{ordered.length}</strong>
        </header>
        {analysis.outcome.state === "indeterminate" ? (
          <div className="indeterminate">
            <h3>Analysis is indeterminate</h3>
            {analysis.outcome.reasons.map((reason) => (
              <p key={reason}>{reason}</p>
            ))}
          </div>
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
                          .map((metric) =>
                            formatMetric(metric.value, metric.unit),
                          )
                          .join(" · ") || "Bounded changed region"}
                      </small>
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        )}
      </aside>
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
