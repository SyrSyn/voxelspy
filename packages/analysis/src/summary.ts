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
}

/**
 * Summarizes placed model geometry in the supplied comparison frame.
 *
 * Calculations retain Float64 coordinates throughout. No recentering, repair,
 * tolerance welding, or printability interpretation is performed.
 *
 * This walks the model's own mesh/placement graph directly (rather than
 * `flattenModel`'s typed-array flattening) because it also needs exact
 * shared-edge topology keyed per placed instance, which is summary-specific
 * and not part of the shared flattening path.
 */
export function summarizeModelGeometry(
  model: NormalizedModel,
  modelToComparison: Mat4 = IDENTITY_MAT4,
): ModelPresentationSummary {
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

  const bounds = summarizeBounds(positions);
  const edges = new Map<string, EdgeRecord>();
  const components = new DisjointSet(triangles.length);
  const area = new CompensatedSum();
  const signedVolume = new CompensatedSum();
  let degenerateTriangleCount = 0;

  triangles.forEach((triangle, triangleIndex) => {
    const [first, second, third] = triangle.points;
    const triangleArea = areaOfTriangle(first, second, third);
    area.add(triangleArea);
    if (!(triangleArea > 0) || !Number.isFinite(triangleArea)) {
      degenerateTriangleCount += 1;
    }
    signedVolume.add(dot(first, cross(second, third)) / 6);
    const [firstKey, secondKey, thirdKey] = triangle.vertexKeys;
    addEdge(edges, firstKey, secondKey, triangleIndex);
    addEdge(edges, secondKey, thirdKey, triangleIndex);
    addEdge(edges, thirdKey, firstKey, triangleIndex);
  });

  let boundaryEdgeCount = 0;
  let nonManifoldEdgeCount = 0;
  let inconsistentEdgeCount = 0;
  for (const edge of edges.values()) {
    const [firstTriangle, ...neighbors] = edge.triangleIndices;
    if (firstTriangle !== undefined) {
      for (const neighbor of neighbors) {
        components.union(firstTriangle, neighbor);
      }
    }
    const total = edge.forward + edge.reverse;
    if (total === 1) boundaryEdgeCount += 1;
    else if (total > 2) nonManifoldEdgeCount += 1;
    else if (edge.forward !== 1 || edge.reverse !== 1) {
      inconsistentEdgeCount += 1;
    }
  }

  const topology: TopologySummary = {
    boundaryEdgeCount,
    nonManifoldEdgeCount,
    inconsistentEdgeCount,
    degenerateTriangleCount,
  };
  const volumeReasons: VolumeUnavailableReason[] = [];
  if (triangles.length === 0) volumeReasons.push("empty-geometry");
  if (degenerateTriangleCount > 0) volumeReasons.push("degenerate-triangles");
  if (boundaryEdgeCount > 0) volumeReasons.push("boundary-edges");
  if (nonManifoldEdgeCount > 0) volumeReasons.push("non-manifold-edges");
  if (inconsistentEdgeCount > 0) volumeReasons.push("inconsistent-orientation");

  const signedCubicMillimetres = normalizeZero(signedVolume.value());
  return {
    modelId: model.id,
    vertexCount,
    triangleCount,
    meshCount: model.meshes.length,
    instanceCount: model.placement.instances.length,
    componentCount: components.count(),
    bounds,
    surfaceAreaSquareMillimetres: normalizeZero(area.value()),
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
): void {
  const forward = from <= to;
  const key = forward ? `${from}|${to}` : `${to}|${from}`;
  const edge = edges.get(key) ?? {
    forward: 0,
    reverse: 0,
    triangleIndices: [],
  };
  if (forward) edge.forward += 1;
  else edge.reverse += 1;
  edge.triangleIndices.push(triangleIndex);
  edges.set(key, edge);
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
