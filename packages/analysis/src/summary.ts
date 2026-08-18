import {
  IDENTITY_MAT4,
  type AnalysisResult,
  type Mat4,
  type NormalizedModel,
  type Vec3,
} from "@voxelspy/contracts";

import { multiply } from "./geometry.js";

export type DeltaDirection = "increase" | "decrease" | "unchanged";

export interface NumericDelta {
  readonly baseline: number;
  readonly candidate: number;
  /** Candidate minus baseline. */
  readonly difference: number;
  readonly direction: DeltaDirection;
}

export type ModelBoundsSummary =
  | {
      readonly available: true;
      readonly min: Vec3;
      readonly max: Vec3;
      readonly dimensionsMillimetres: Vec3;
    }
  | {
      readonly available: false;
      readonly reason: "no-position-data";
    };

export type VolumeUnavailableReason =
  | "empty-geometry"
  | "degenerate-triangles"
  | "boundary-edges"
  | "non-manifold-edges"
  | "inconsistent-orientation";

export interface TopologySummary {
  readonly boundaryEdgeCount: number;
  readonly nonManifoldEdgeCount: number;
  readonly inconsistentEdgeCount: number;
  readonly degenerateTriangleCount: number;
}

/**
 * A bounded, representative location for one instance of a topology issue,
 * in the same comparison-frame Float64 coordinates as the rest of this
 * module's output. `triangleIndices` are ordinal positions in the walk
 * order this module builds from the model's own mesh/placement traversal
 * (deterministic for a given model, but not necessarily the indexing any
 * particular renderer or importer uses) -- one index for a degenerate
 * triangle, or every triangle usage that shares the located edge.
 */
export interface TopologyExampleLocation {
  readonly positionMillimetres: Vec3;
  readonly triangleIndices: readonly number[];
}

export type ModelVolumeSummary =
  | {
      readonly available: true;
      readonly signedCubicMillimetres: number;
      readonly absoluteCubicMillimetres: number;
      readonly topology: TopologySummary;
    }
  | {
      readonly available: false;
      readonly reasons: readonly VolumeUnavailableReason[];
      readonly topology: TopologySummary;
    };

export interface ModelPresentationSummary {
  readonly modelId: NormalizedModel["id"];
  /** Counts placed mesh instances, including repeated instances of one mesh. */
  readonly vertexCount: number;
  /** Counts placed indexed triangles, including repeated mesh instances. */
  readonly triangleCount: number;
  /** Counts unique mesh records in the normalized model. */
  readonly meshCount: number;
  readonly instanceCount: number;
  /** Counts triangle shells connected through exact shared geometric edges. */
  readonly componentCount: number;
  readonly bounds: ModelBoundsSummary;
  readonly surfaceAreaSquareMillimetres: number;
  readonly volume: ModelVolumeSummary;
}

export type VolumeDelta =
  | ({ readonly available: true } & NumericDelta)
  | {
      readonly available: false;
      readonly unavailableFor: readonly ("baseline" | "candidate")[];
    };

export interface ModelPresentationDeltas {
  readonly vertexCount: NumericDelta;
  readonly triangleCount: NumericDelta;
  readonly meshCount: NumericDelta;
  readonly instanceCount: NumericDelta;
  readonly componentCount: NumericDelta;
  readonly dimensionsMillimetres:
    | {
        readonly available: true;
        readonly x: NumericDelta;
        readonly y: NumericDelta;
        readonly z: NumericDelta;
      }
    | {
        readonly available: false;
        readonly unavailableFor: readonly ("baseline" | "candidate")[];
      };
  readonly surfaceAreaSquareMillimetres: NumericDelta;
  readonly absoluteVolumeCubicMillimetres: VolumeDelta;
}

export type CompactAnalysisSummary =
  | {
      readonly state: "complete";
      readonly changeStatus: "regions-found" | "no-regions";
      readonly semantics:
        "approximate" | "exact-within-validated-preconditions";
      readonly regionCount: number;
      readonly warningCount: number;
      readonly methodId: string;
      readonly methodVersion: string;
    }
  | {
      readonly state: "indeterminate";
      readonly code: string;
      readonly reasons: readonly string[];
      readonly warningCount: number;
      readonly methodId: string;
      readonly methodVersion: string;
    };

export interface ModelComparisonPresentationSummary {
  readonly baseline: ModelPresentationSummary;
  readonly candidate: ModelPresentationSummary;
  readonly deltas: ModelPresentationDeltas;
  readonly analysis: CompactAnalysisSummary;
}

interface TriangleRecord {
  readonly points: readonly [Vec3, Vec3, Vec3];
  readonly vertexKeys: readonly [string, string, string];
}

interface EdgeRecord {
  forward: number;
  reverse: number;
  readonly triangleIndices: number[];
  /** The two endpoint points as first encountered; identical on every later hit, since this key is exact-coordinate. */
  readonly samplePoints: readonly [Vec3, Vec3];
}

interface PlacedGeometry {
  readonly positions: Vec3[];
  readonly triangles: TriangleRecord[];
  readonly vertexCount: number;
  readonly triangleCount: number;
}

export interface TopologyComputation {
  readonly area: number;
  readonly signedVolume: number;
  readonly componentCount: number;
  readonly degenerateTriangleCount: number;
  readonly boundaryEdgeCount: number;
  readonly nonManifoldEdgeCount: number;
  readonly inconsistentEdgeCount: number;
  readonly boundaryEdgeExamples: readonly TopologyExampleLocation[];
  readonly nonManifoldEdgeExamples: readonly TopologyExampleLocation[];
  readonly inconsistentEdgeExamples: readonly TopologyExampleLocation[];
  readonly degenerateTriangleExamples: readonly TopologyExampleLocation[];
}

/**
 * Walks the model's own mesh/placement graph directly (rather than
 * `flattenModel`'s typed-array flattening) because the topology census below
 * needs exact shared-edge keys per placed instance, which is summary-specific
 * and not part of the shared flattening path. Shared by `summarizeModelGeometry`
 * and `summarizeModelGeometryWithEvidence` so there is exactly one
 * implementation of this walk.
 */
function collectPlacedGeometry(
  model: NormalizedModel,
  modelToComparison: Mat4,
): PlacedGeometry {
  const meshes = new Map(model.meshes.map((mesh) => [mesh.id, mesh]));
  const positions: Vec3[] = [];
  const triangles: TriangleRecord[] = [];
  let vertexCount = 0;
  let triangleCount = 0;
  let instanceOrdinal = 0;

  const appendInstance = (
    meshId: NormalizedModel["meshes"][number]["id"],
    instanceToModel: Mat4,
  ) => {
    const mesh = meshes.get(meshId);
    if (mesh === undefined) return;
    const transform = multiply(modelToComparison, instanceToModel);
    const transformed: Vec3[] = [];
    const instanceKey = `instance-${instanceOrdinal}`;
    instanceOrdinal += 1;

    for (let index = 0; index < mesh.geometry.positions.length; index += 3) {
      const point = transformPoint(transform, [
        mesh.geometry.positions[index]!,
        mesh.geometry.positions[index + 1]!,
        mesh.geometry.positions[index + 2]!,
      ]);
      transformed.push(point);
      positions.push(point);
    }
    vertexCount += transformed.length;
    triangleCount += mesh.geometry.indices.length / 3;

    for (let index = 0; index < mesh.geometry.indices.length; index += 3) {
      const first = transformed[mesh.geometry.indices[index]!]!;
      const second = transformed[mesh.geometry.indices[index + 1]!]!;
      const third = transformed[mesh.geometry.indices[index + 2]!]!;
      triangles.push({
        points: [first, second, third],
        vertexKeys: [
          `${instanceKey}:${pointKey(first)}`,
          `${instanceKey}:${pointKey(second)}`,
          `${instanceKey}:${pointKey(third)}`,
        ],
      });
    }
  };

  if (model.placement.kind === "flat") {
    for (const instance of model.placement.instances) {
      appendInstance(instance.meshId, instance.meshToModel);
    }
  } else {
    const nodes = new Map(model.placement.nodes.map((node) => [node.id, node]));
    const instances = new Map(
      model.placement.instances.map((instance) => [instance.id, instance]),
    );
    const stack = [...model.placement.rootIds]
      .reverse()
      .map((id) => ({ id, parentToModel: IDENTITY_MAT4 }));
    while (stack.length > 0) {
      const current = stack.pop()!;
      const node = nodes.get(current.id);
      if (node === undefined) continue;
      const nodeToModel = multiply(current.parentToModel, node.localToParent);
      for (const instanceId of node.instanceIds) {
        const instance = instances.get(instanceId);
        if (instance !== undefined) {
          appendInstance(
            instance.meshId,
            multiply(nodeToModel, instance.meshToNode),
          );
        }
      }
      for (let index = node.childIds.length - 1; index >= 0; index -= 1) {
        const childId = node.childIds[index];
        if (childId !== undefined) {
          stack.push({ id: childId, parentToModel: nodeToModel });
        }
      }
    }
  }

  return { positions, triangles, vertexCount, triangleCount };
}

/**
 * Computes area, signed volume, connected components, and the topology
 * census (boundary/non-manifold/inconsistent edges, degenerate triangles)
 * from an already-placed triangle list. `maxExamplesPerKind` bounds how many
 * representative example locations are collected per issue kind (pass `0`
 * to collect none, as `summarizeModelGeometry` does); example collection
 * never changes any count, only how much of it is illustrated.
 *
 * Example ordering is deterministic: triangles are walked in `triangles`'
 * own (already-deterministic) order, and edges are walked in `Map`
 * insertion order, which is fixed by that same triangle walk.
 */
function computeTopology(
  triangles: readonly TriangleRecord[],
  maxExamplesPerKind: number,
): TopologyComputation {
  const edges = new Map<string, EdgeRecord>();
  const components = new DisjointSet(triangles.length);
  const area = new CompensatedSum();
  const signedVolume = new CompensatedSum();
  let degenerateTriangleCount = 0;
  const degenerateTriangleExamples: TopologyExampleLocation[] = [];

  triangles.forEach((triangle, triangleIndex) => {
    const [first, second, third] = triangle.points;
    const triangleArea = areaOfTriangle(first, second, third);
    area.add(triangleArea);
    if (!(triangleArea > 0) || !Number.isFinite(triangleArea)) {
      degenerateTriangleCount += 1;
      pushExample(
        degenerateTriangleExamples,
        maxExamplesPerKind,
        centroidOf(first, second, third),
        [triangleIndex],
      );
    }
    signedVolume.add(dot(first, cross(second, third)) / 6);
    const [firstKey, secondKey, thirdKey] = triangle.vertexKeys;
    addEdge(edges, firstKey, secondKey, triangleIndex, first, second);
    addEdge(edges, secondKey, thirdKey, triangleIndex, second, third);
    addEdge(edges, thirdKey, firstKey, triangleIndex, third, first);
  });

  let boundaryEdgeCount = 0;
  let nonManifoldEdgeCount = 0;
  let inconsistentEdgeCount = 0;
  const boundaryEdgeExamples: TopologyExampleLocation[] = [];
  const nonManifoldEdgeExamples: TopologyExampleLocation[] = [];
  const inconsistentEdgeExamples: TopologyExampleLocation[] = [];
  for (const edge of edges.values()) {
    const [firstTriangle, ...neighbors] = edge.triangleIndices;
    if (firstTriangle !== undefined) {
      for (const neighbor of neighbors) {
        components.union(firstTriangle, neighbor);
      }
    }
    const total = edge.forward + edge.reverse;
    if (total === 1) {
      boundaryEdgeCount += 1;
      pushExample(
        boundaryEdgeExamples,
        maxExamplesPerKind,
        midpointOf(edge.samplePoints[0], edge.samplePoints[1]),
        edge.triangleIndices,
      );
    } else if (total > 2) {
      nonManifoldEdgeCount += 1;
      pushExample(
        nonManifoldEdgeExamples,
        maxExamplesPerKind,
        midpointOf(edge.samplePoints[0], edge.samplePoints[1]),
        edge.triangleIndices,
      );
    } else if (edge.forward !== 1 || edge.reverse !== 1) {
      inconsistentEdgeCount += 1;
      pushExample(
        inconsistentEdgeExamples,
        maxExamplesPerKind,
        midpointOf(edge.samplePoints[0], edge.samplePoints[1]),
        edge.triangleIndices,
      );
    }
  }

  return {
    area: area.value(),
    signedVolume: signedVolume.value(),
    componentCount: components.count(),
    degenerateTriangleCount,
    boundaryEdgeCount,
    nonManifoldEdgeCount,
    inconsistentEdgeCount,
    boundaryEdgeExamples,
    nonManifoldEdgeExamples,
    inconsistentEdgeExamples,
    degenerateTriangleExamples,
  };
}

function buildPresentationSummary(
  model: NormalizedModel,
  placed: PlacedGeometry,
  topo: TopologyComputation,
): ModelPresentationSummary {
  const bounds = summarizeBounds(placed.positions);
  const topology: TopologySummary = {
    boundaryEdgeCount: topo.boundaryEdgeCount,
    nonManifoldEdgeCount: topo.nonManifoldEdgeCount,
    inconsistentEdgeCount: topo.inconsistentEdgeCount,
    degenerateTriangleCount: topo.degenerateTriangleCount,
  };
  const volumeReasons: VolumeUnavailableReason[] = [];
  if (placed.triangles.length === 0) volumeReasons.push("empty-geometry");
  if (topo.degenerateTriangleCount > 0) {
    volumeReasons.push("degenerate-triangles");
  }
  if (topo.boundaryEdgeCount > 0) volumeReasons.push("boundary-edges");
  if (topo.nonManifoldEdgeCount > 0) volumeReasons.push("non-manifold-edges");
  if (topo.inconsistentEdgeCount > 0) {
    volumeReasons.push("inconsistent-orientation");
  }

  const signedCubicMillimetres = normalizeZero(topo.signedVolume);
  return {
    modelId: model.id,
    vertexCount: placed.vertexCount,
    triangleCount: placed.triangleCount,
    meshCount: model.meshes.length,
    instanceCount: model.placement.instances.length,
    componentCount: topo.componentCount,
    bounds,
    surfaceAreaSquareMillimetres: normalizeZero(topo.area),
    volume:
      volumeReasons.length === 0
        ? {
            available: true,
            signedCubicMillimetres,
            absoluteCubicMillimetres: Math.abs(signedCubicMillimetres),
            topology,
          }
        : { available: false, reasons: volumeReasons, topology },
  };
}

/**
 * Summarizes placed model geometry in the supplied comparison frame.
 *
 * Calculations retain Float64 coordinates throughout. No recentering, repair,
 * tolerance welding, or printability interpretation is performed.
 */
export function summarizeModelGeometry(
  model: NormalizedModel,
  modelToComparison: Mat4 = IDENTITY_MAT4,
): ModelPresentationSummary {
  const placed = collectPlacedGeometry(model, modelToComparison);
  const topo = computeTopology(placed.triangles, 0);
  return buildPresentationSummary(model, placed, topo);
}

/**
 * Same computation as `summarizeModelGeometry` -- this performs exactly one
 * walk of the model's placed geometry, not a second implementation of the
 * edge census -- additionally returning bounded, deterministic example
 * locations for each topology issue kind. Not part of the package's public
 * surface: intended for `inspectModel` (see `src/inspect.ts`) so the two
 * never diverge.
 */
export function summarizeModelGeometryWithEvidence(
  model: NormalizedModel,
  modelToComparison: Mat4,
  maxExamplesPerKind: number,
): {
  readonly summary: ModelPresentationSummary;
  readonly evidence: TopologyComputation;
} {
  const placed = collectPlacedGeometry(model, modelToComparison);
  const topo = computeTopology(placed.triangles, maxExamplesPerKind);
  return {
    summary: buildPresentationSummary(model, placed, topo),
    evidence: topo,
  };
}

export function summarizeModelComparison(
  baseline: NormalizedModel,
  candidate: NormalizedModel,
  analysis: AnalysisResult,
): ModelComparisonPresentationSummary {
  if (
    analysis.baseline.modelId !== baseline.id ||
    analysis.candidate.modelId !== candidate.id
  ) {
    throw new TypeError(
      "Analysis bindings must match the baseline and candidate models",
    );
  }
  const baselineSummary = summarizeModelGeometry(
    baseline,
    analysis.baseline.modelToComparison,
  );
  const candidateSummary = summarizeModelGeometry(
    candidate,
    analysis.candidate.modelToComparison,
  );
  return {
    baseline: baselineSummary,
    candidate: candidateSummary,
    deltas: summarizeDeltas(baselineSummary, candidateSummary),
    analysis: summarizeAnalysis(analysis),
  };
}

function summarizeDeltas(
  baseline: ModelPresentationSummary,
  candidate: ModelPresentationSummary,
): ModelPresentationDeltas {
  const unavailableBounds: ("baseline" | "candidate")[] = [];
  if (!baseline.bounds.available) unavailableBounds.push("baseline");
  if (!candidate.bounds.available) unavailableBounds.push("candidate");
  const unavailableVolume: ("baseline" | "candidate")[] = [];
  if (!baseline.volume.available) unavailableVolume.push("baseline");
  if (!candidate.volume.available) unavailableVolume.push("candidate");
  return {
    vertexCount: numericDelta(baseline.vertexCount, candidate.vertexCount),
    triangleCount: numericDelta(
      baseline.triangleCount,
      candidate.triangleCount,
    ),
    meshCount: numericDelta(baseline.meshCount, candidate.meshCount),
    instanceCount: numericDelta(
      baseline.instanceCount,
      candidate.instanceCount,
    ),
    componentCount: numericDelta(
      baseline.componentCount,
      candidate.componentCount,
    ),
    dimensionsMillimetres:
      baseline.bounds.available && candidate.bounds.available
        ? {
            available: true,
            x: numericDelta(
              baseline.bounds.dimensionsMillimetres[0],
              candidate.bounds.dimensionsMillimetres[0],
            ),
            y: numericDelta(
              baseline.bounds.dimensionsMillimetres[1],
              candidate.bounds.dimensionsMillimetres[1],
            ),
            z: numericDelta(
              baseline.bounds.dimensionsMillimetres[2],
              candidate.bounds.dimensionsMillimetres[2],
            ),
          }
        : { available: false, unavailableFor: unavailableBounds },
    surfaceAreaSquareMillimetres: numericDelta(
      baseline.surfaceAreaSquareMillimetres,
      candidate.surfaceAreaSquareMillimetres,
    ),
    absoluteVolumeCubicMillimetres:
      baseline.volume.available && candidate.volume.available
        ? {
            available: true,
            ...numericDelta(
              baseline.volume.absoluteCubicMillimetres,
              candidate.volume.absoluteCubicMillimetres,
            ),
          }
        : { available: false, unavailableFor: unavailableVolume },
  };
}

function summarizeAnalysis(analysis: AnalysisResult): CompactAnalysisSummary {
  const outcome = analysis.outcome;
  if (outcome.state === "indeterminate") {
    return {
      state: "indeterminate",
      code: outcome.code,
      reasons: [...outcome.reasons],
      warningCount: analysis.warnings.length,
      methodId: outcome.requestedMethod.id,
      methodVersion: outcome.requestedMethod.version,
    };
  }
  return {
    state: "complete",
    changeStatus: outcome.regions.length === 0 ? "no-regions" : "regions-found",
    semantics: outcome.semantics,
    regionCount: outcome.regions.length,
    warningCount: analysis.warnings.length,
    methodId: outcome.effectiveMethod.id,
    methodVersion: outcome.effectiveMethod.version,
  };
}

function summarizeBounds(points: readonly Vec3[]): ModelBoundsSummary {
  if (points.length === 0)
    return { available: false, reason: "no-position-data" };
  const min: Vec3 = [
    Number.POSITIVE_INFINITY,
    Number.POSITIVE_INFINITY,
    Number.POSITIVE_INFINITY,
  ];
  const max: Vec3 = [
    Number.NEGATIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ];
  for (const point of points) {
    for (let axis = 0; axis < 3; axis += 1) {
      min[axis] = Math.min(min[axis]!, point[axis]!);
      max[axis] = Math.max(max[axis]!, point[axis]!);
    }
  }
  return {
    available: true,
    min,
    max,
    dimensionsMillimetres: [
      normalizeZero(max[0] - min[0]),
      normalizeZero(max[1] - min[1]),
      normalizeZero(max[2] - min[2]),
    ],
  };
}

function numericDelta(baseline: number, candidate: number): NumericDelta {
  const difference = normalizeZero(candidate - baseline);
  return {
    baseline,
    candidate,
    difference,
    direction:
      difference > 0 ? "increase" : difference < 0 ? "decrease" : "unchanged",
  };
}

function transformPoint(matrix: readonly number[], point: Vec3): Vec3 {
  return [
    matrix[0]! * point[0] +
      matrix[4]! * point[1] +
      matrix[8]! * point[2] +
      matrix[12]!,
    matrix[1]! * point[0] +
      matrix[5]! * point[1] +
      matrix[9]! * point[2] +
      matrix[13]!,
    matrix[2]! * point[0] +
      matrix[6]! * point[1] +
      matrix[10]! * point[2] +
      matrix[14]!,
  ];
}

function areaOfTriangle(first: Vec3, second: Vec3, third: Vec3): number {
  return (
    Math.hypot(...cross(subtract(second, first), subtract(third, first))) / 2
  );
}

function subtract(left: Vec3, right: Vec3): Vec3 {
  return [left[0] - right[0], left[1] - right[1], left[2] - right[2]];
}

function cross(left: Vec3, right: Vec3): Vec3 {
  return [
    left[1] * right[2] - left[2] * right[1],
    left[2] * right[0] - left[0] * right[2],
    left[0] * right[1] - left[1] * right[0],
  ];
}

function dot(left: Vec3, right: Vec3): number {
  return left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
}

function pointKey(point: Vec3): string {
  return point.map((value) => normalizeZero(value).toString()).join(",");
}

function addEdge(
  edges: Map<string, EdgeRecord>,
  from: string,
  to: string,
  triangleIndex: number,
  fromPoint: Vec3,
  toPoint: Vec3,
): void {
  const forward = from <= to;
  const key = forward ? `${from}|${to}` : `${to}|${from}`;
  const edge = edges.get(key) ?? {
    forward: 0,
    reverse: 0,
    triangleIndices: [],
    samplePoints: forward ? [fromPoint, toPoint] : [toPoint, fromPoint],
  };
  if (forward) edge.forward += 1;
  else edge.reverse += 1;
  edge.triangleIndices.push(triangleIndex);
  edges.set(key, edge);
}

/** Appends one bounded, deterministic example; a no-op once `max` is reached. */
function pushExample(
  bucket: TopologyExampleLocation[],
  max: number,
  positionMillimetres: Vec3,
  triangleIndices: readonly number[],
): void {
  if (bucket.length >= max) return;
  bucket.push({ positionMillimetres, triangleIndices: [...triangleIndices] });
}

function midpointOf(first: Vec3, second: Vec3): Vec3 {
  return [
    normalizeZero((first[0] + second[0]) / 2),
    normalizeZero((first[1] + second[1]) / 2),
    normalizeZero((first[2] + second[2]) / 2),
  ];
}

function centroidOf(first: Vec3, second: Vec3, third: Vec3): Vec3 {
  return [
    normalizeZero((first[0] + second[0] + third[0]) / 3),
    normalizeZero((first[1] + second[1] + third[1]) / 3),
    normalizeZero((first[2] + second[2] + third[2]) / 3),
  ];
}

function normalizeZero(value: number): number {
  return Object.is(value, -0) ? 0 : value;
}

class CompensatedSum {
  private sum = 0;
  private compensation = 0;

  add(value: number): void {
    const adjusted = value - this.compensation;
    const next = this.sum + adjusted;
    this.compensation = next - this.sum - adjusted;
    this.sum = next;
  }

  value(): number {
    return this.sum;
  }
}

class DisjointSet {
  private readonly parent: number[];
  private readonly rank: number[];

  constructor(size: number) {
    this.parent = Array.from({ length: size }, (_, index) => index);
    this.rank = new Array<number>(size).fill(0);
  }

  union(first: number, second: number): void {
    const firstRoot = this.find(first);
    const secondRoot = this.find(second);
    if (firstRoot === secondRoot) return;
    if (this.rank[firstRoot]! < this.rank[secondRoot]!) {
      this.parent[firstRoot] = secondRoot;
    } else {
      this.parent[secondRoot] = firstRoot;
      if (this.rank[firstRoot] === this.rank[secondRoot]) {
        this.rank[firstRoot] = this.rank[firstRoot]! + 1;
      }
    }
  }

  count(): number {
    const roots = new Set<number>();
    for (let index = 0; index < this.parent.length; index += 1) {
      roots.add(this.find(index));
    }
    return roots.size;
  }

  private find(value: number): number {
    let root = value;
    while (this.parent[root] !== root) root = this.parent[root]!;
    while (this.parent[value] !== value) {
      const parent = this.parent[value]!;
      this.parent[value] = root;
      value = parent;
    }
    return root;
  }
}
