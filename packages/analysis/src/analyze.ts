import {
  analysisRequestSchema,
  analysisResultSchema,
  normalizedModelSchema,
} from "@voxelspy/contracts";
import type {
  AnalysisRequest,
  AnalysisResult,
  Mat4,
  MeshAssessment,
  NormalizedModel,
  Vec3,
} from "@voxelspy/contracts";

import {
  countExpandedGeometry,
  flattenModel,
  pointTriangleDistanceSquared,
  triangleCentroid,
} from "./geometry.js";
import type { FlatGeometry, Triangle } from "./geometry.js";

export interface AnalysisResourceLimits {
  readonly maxExpandedVertices: number;
  readonly maxExpandedTriangles: number;
  readonly maxWorkUnits: number;
  readonly maxMemoryBytes: number;
  readonly maxReportedRegions: number;
}

/** Safety ceilings for this implementation, not release-size claims. */
export const ANALYSIS_LIMITS: AnalysisResourceLimits = Object.freeze({
  maxExpandedVertices: 100_000,
  maxExpandedTriangles: 50_000,
  maxWorkUnits: 2_000_000,
  maxMemoryBytes: 256 * 1024 * 1024,
  maxReportedRegions: 2_048,
});

export const SURFACE_DISTANCE_METHOD = Object.freeze({
  id: "surface-distance",
  version: "1.0.0",
  parameters: Object.freeze({}),
});

export const AXIS_ALIGNED_BOX_METHOD = Object.freeze({
  id: "axis-aligned-box-solid",
  version: "1.0.0",
  parameters: Object.freeze({}),
});

export interface AnalysisMethodCapability {
  readonly id: string;
  readonly version: string;
  readonly resultSemantics:
    "approximate" | "exact-within-validated-preconditions";
  readonly requiredPreconditions: readonly string[];
  readonly parameterShape: Readonly<Record<string, string>>;
}

const METHOD_CAPABILITIES: readonly AnalysisMethodCapability[] = Object.freeze([
  Object.freeze({
    id: SURFACE_DISTANCE_METHOD.id,
    version: SURFACE_DISTANCE_METHOD.version,
    resultSemantics: "approximate" as const,
    requiredPreconditions: Object.freeze([
      "non-empty-triangles",
      "non-degenerate-triangles",
    ]),
    parameterShape: Object.freeze({
      maxRegions: "optional positive integer, at most 2048",
    }),
  }),
  Object.freeze({
    id: AXIS_ALIGNED_BOX_METHOD.id,
    version: AXIS_ALIGNED_BOX_METHOD.version,
    resultSemantics: "exact-within-validated-preconditions" as const,
    requiredPreconditions: Object.freeze([
      "closed",
      "consistently-oriented",
      "axis-aligned-box",
    ]),
    parameterShape: Object.freeze({}),
  }),
]);

export function supportedAnalysisMethods(): readonly AnalysisMethodCapability[] {
  return METHOD_CAPABILITIES;
}

export interface AnalysisInput {
  readonly request: AnalysisRequest;
  readonly baseline: NormalizedModel;
  readonly candidate: NormalizedModel;
}

export function analyzeModelPair(input: AnalysisInput): AnalysisResult {
  const request = analysisRequestSchema.parse(input.request);
  const baseline = normalizedModelSchema.parse(input.baseline);
  const candidate = normalizedModelSchema.parse(input.candidate);

  if (
    baseline.id !== request.baseline.modelId ||
    candidate.id !== request.candidate.modelId
  ) {
    return indeterminate(request, "model-binding-mismatch", [
      "The supplied models do not match the request bindings.",
    ]);
  }

  const capability = METHOD_CAPABILITIES.find(
    ({ id, version }) =>
      id === request.method.id && version === request.method.version,
  );
  if (capability === undefined) {
    return indeterminate(request, "unsupported-method", [
      `Method ${String(request.method.id)} version ${request.method.version} is not supported.`,
    ]);
  }

  const budgetProblem = checkResourceBudget(request, baseline, candidate);
  if (budgetProblem !== undefined) {
    return indeterminate(request, "resource-budget-exceeded", [budgetProblem]);
  }

  let baselineGeometry: FlatGeometry;
  let candidateGeometry: FlatGeometry;
  try {
    baselineGeometry = flattenModel(
      baseline,
      request.baseline.modelToComparison,
    );
    candidateGeometry = flattenModel(
      candidate,
      request.candidate.modelToComparison,
    );
  } catch (error) {
    return indeterminate(request, "comparison-transform-failed", [
      error instanceof Error ? error.message : "Comparison transform failed.",
    ]);
  }

  const validation = [
    assessGeometry(baseline.id, baselineGeometry),
    assessGeometry(candidate.id, candidateGeometry),
  ] as const;

  if (capability.id === SURFACE_DISTANCE_METHOD.id) {
    return analyzeSurfaceDistance(
      request,
      baselineGeometry,
      candidateGeometry,
      validation,
    );
  }
  return analyzeAxisAlignedBoxes(
    request,
    baselineGeometry,
    candidateGeometry,
    validation,
  );
}

function checkResourceBudget(
  request: AnalysisRequest,
  baseline: NormalizedModel,
  candidate: NormalizedModel,
): string | undefined {
  const first = countExpandedGeometry(baseline);
  const second = countExpandedGeometry(candidate);
  const vertices = first.vertices + second.vertices;
  const triangles = first.triangles + second.triangles;
  if (vertices > ANALYSIS_LIMITS.maxExpandedVertices) {
    return `Expanded geometry requires ${vertices} vertices; the implementation ceiling is ${ANALYSIS_LIMITS.maxExpandedVertices}.`;
  }
  if (triangles > ANALYSIS_LIMITS.maxExpandedTriangles) {
    return `Expanded geometry requires ${triangles} triangles; the implementation ceiling is ${ANALYSIS_LIMITS.maxExpandedTriangles}.`;
  }
  const estimatedMemory = vertices * 24 + triangles * 160;
  const memoryBudget = Math.min(
    ANALYSIS_LIMITS.maxMemoryBytes,
    request.executionBudget?.maxMemoryBytes ?? ANALYSIS_LIMITS.maxMemoryBytes,
  );
  if (
    !Number.isSafeInteger(estimatedMemory) ||
    estimatedMemory > memoryBudget
  ) {
    return `Estimated analysis memory is ${estimatedMemory} bytes; the active budget is ${memoryBudget} bytes.`;
  }
  return undefined;
}

function assessGeometry(
  modelId: NormalizedModel["id"],
  geometry: FlatGeometry,
): MeshAssessment {
  const edges = new Map<string, { forward: number; reverse: number }>();
  let degenerateTriangleCount = 0;
  for (const triangle of geometry.triangles) {
    if (!(triangle.area > 0) || !Number.isFinite(triangle.area)) {
      degenerateTriangleCount += 1;
    }
    const [a, b, c] = triangle.vertices;
    addEdge(edges, a, b);
    addEdge(edges, b, c);
    addEdge(edges, c, a);
  }
  let boundaryEdgeCount = 0;
  let nonManifoldEdgeCount = 0;
  let inconsistentEdgeCount = 0;
  for (const edge of edges.values()) {
    const total = edge.forward + edge.reverse;
    if (total === 1) boundaryEdgeCount += 1;
    else if (total > 2) nonManifoldEdgeCount += 1;
    else if (edge.forward !== 1 || edge.reverse !== 1) {
      inconsistentEdgeCount += 1;
    }
  }
  const reasons: string[] = [];
  const preconditions: Array<{
    id: string;
    passed: true;
    details?: Record<string, number>;
  }> = [];
  if (geometry.triangles.length === 0) reasons.push("empty-geometry");
  else preconditions.push({ id: "non-empty-triangles", passed: true });
  if (degenerateTriangleCount > 0) reasons.push("degenerate-triangles");
  else preconditions.push({ id: "non-degenerate-triangles", passed: true });
  if (boundaryEdgeCount > 0) reasons.push("boundary-edges");
  else if (nonManifoldEdgeCount === 0) {
    preconditions.push({ id: "closed", passed: true });
  }
  if (nonManifoldEdgeCount > 0) reasons.push("non-manifold-edges");
  if (inconsistentEdgeCount > 0) reasons.push("inconsistent-orientation");
  else if (nonManifoldEdgeCount === 0) {
    preconditions.push({ id: "consistently-oriented", passed: true });
  }
  return {
    modelId,
    closed: boundaryEdgeCount === 0 && nonManifoldEdgeCount === 0,
    consistentlyOriented:
      inconsistentEdgeCount === 0 && nonManifoldEdgeCount === 0,
    boundaryEdgeCount,
    nonManifoldEdgeCount,
    degenerateTriangleCount,
    reasons,
    preconditions,
  } as MeshAssessment;
}

function addEdge(
  edges: Map<string, { forward: number; reverse: number }>,
  from: number,
  to: number,
): void {
  const lower = Math.min(from, to);
  const upper = Math.max(from, to);
  const key = `${lower}:${upper}`;
  const edge = edges.get(key) ?? { forward: 0, reverse: 0 };
  if (from === lower) edge.forward += 1;
  else edge.reverse += 1;
  edges.set(key, edge);
}

function analyzeSurfaceDistance(
  request: AnalysisRequest,
  baseline: FlatGeometry,
  candidate: FlatGeometry,
  validation: readonly [MeshAssessment, MeshAssessment],
): AnalysisResult {
  const parameterResult = surfaceParameters(request.method.parameters);
  if (typeof parameterResult === "string") {
    return indeterminate(
      request,
      "invalid-method-parameters",
      [parameterResult],
      validation,
    );
  }
  const tolerance = request.tolerance.distanceMillimetres;
  if (tolerance === undefined) {
    return indeterminate(
      request,
      "distance-tolerance-required",
      ["Surface distance requires a distance tolerance in millimetres."],
      validation,
    );
  }
  const invalid = validation.flatMap((assessment) =>
    assessment.reasons.filter(
      (reason) =>
        reason === "empty-geometry" || reason === "degenerate-triangles",
    ),
  );
  if (invalid.length > 0) {
    return indeterminate(
      request,
      "surface-precondition-failed",
      [`Surface distance preconditions failed: ${unique(invalid).join(", ")}.`],
      validation,
    );
  }
  const workUnits = baseline.triangles.length * candidate.triangles.length * 8;
  const workBudget = Math.min(
    ANALYSIS_LIMITS.maxWorkUnits,
    request.executionBudget?.maxWorkUnits ?? ANALYSIS_LIMITS.maxWorkUnits,
  );
  if (!Number.isSafeInteger(workUnits) || workUnits > workBudget) {
    return indeterminate(
      request,
      "resource-budget-exceeded",
      [
        `Surface sampling requires ${workUnits} point-triangle work units; the active budget is ${workBudget}.`,
      ],
      validation,
    );
  }

  try {
    const removed = directionalRegions(
      baseline,
      candidate,
      "removed",
      tolerance,
    );
    const added = directionalRegions(candidate, baseline, "added", tolerance);
    const ranked = [...removed, ...added].sort(compareSurfaceRegion);
    const reported = ranked.slice(0, parameterResult.maxRegions);
    const truncated = reported.length !== ranked.length;
    const warnings = truncated
      ? [
          {
            code: "analysis.region-limit",
            severity: "warning" as const,
            message: `${ranked.length - reported.length} lower-ranked changed regions were omitted by the requested region limit.`,
            details: {
              detectedRegionCount: ranked.length,
              reportedRegionCount: reported.length,
            },
          },
        ]
      : [];
    const metrics: Array<{
      id: string;
      value: number;
      unit: "millimetre" | "square-millimetre" | "ratio" | "count";
    }> = [
      {
        id: "surface.maximum-distance",
        value: ranked.reduce(
          (maximum, region) => Math.max(maximum, region.maximumDistance),
          0,
        ),
        unit: "millimetre",
      },
      {
        id: "surface.changed-area",
        value: ranked.reduce((sum, region) => sum + region.area, 0),
        unit: "square-millimetre",
      },
      {
        id: "surface.changed-region-count",
        value: ranked.length,
        unit: "count",
      },
      {
        id: "surface.reported-region-count",
        value: reported.length,
        unit: "count",
      },
    ];
    const regions = reported.map((region) => {
      const prefix = region.id;
      metrics.push(
        {
          id: `${prefix}.maximum-distance`,
          value: region.maximumDistance,
          unit: "millimetre",
        },
        {
          id: `${prefix}.mean-distance`,
          value: region.meanDistance,
          unit: "millimetre",
        },
        {
          id: `${prefix}.area`,
          value: region.area,
          unit: "square-millimetre",
        },
        {
          id: `${prefix}.triangle-count`,
          value: region.triangleCount,
          unit: "count",
        },
      );
      return {
        id: region.id,
        frame: "comparison" as const,
        category: region.category,
        bounds: region.bounds,
        anchor: region.anchor,
        metricIds: [
          `${prefix}.maximum-distance`,
          `${prefix}.mean-distance`,
          `${prefix}.area`,
          `${prefix}.triangle-count`,
        ],
        warningCodes: [],
      };
    });
    return analysisResultSchema.parse({
      contractVersion: 1,
      requestId: request.requestId,
      baseline: request.baseline,
      candidate: request.candidate,
      warnings,
      outcome: {
        state: "complete",
        semantics: "approximate",
        requestedMethod: request.method,
        effectiveMethod: request.method,
        requestedTolerance: request.tolerance,
        effectiveTolerance: request.tolerance,
        validation,
        metrics,
        regions,
        orderedRegionIds: regions.map(({ id }) => id),
        adjustments: [],
        uncertainty: {
          description:
            "Distances use finite vertex and triangle-centroid samples against the opposite tessellated surface. Extrema between samples can be missed, and results depend on tessellation.",
          parameters: {
            sampling: "vertices-and-triangle-centroids",
            distanceToleranceMillimetres: tolerance,
            maxRegions: parameterResult.maxRegions,
            omittedRegionCount: ranked.length - reported.length,
          },
        },
      },
    });
  } catch (error) {
    return indeterminate(
      request,
      "numeric-range-exceeded",
      [
        error instanceof Error
          ? error.message
          : "Surface distance exceeded the supported numeric range.",
      ],
      validation,
    );
  }
}

interface SurfaceParameters {
  readonly maxRegions: number;
}

function surfaceParameters(
  parameters: Readonly<Record<string, unknown>>,
): SurfaceParameters | string {
  const keys = Object.keys(parameters);
  if (keys.some((key) => key !== "maxRegions")) {
    return "Surface distance received an unknown method parameter.";
  }
  const value = parameters.maxRegions ?? ANALYSIS_LIMITS.maxReportedRegions;
  if (
    !Number.isSafeInteger(value) ||
    typeof value !== "number" ||
    value < 1 ||
    value > ANALYSIS_LIMITS.maxReportedRegions
  ) {
    return `maxRegions must be a positive integer no greater than ${ANALYSIS_LIMITS.maxReportedRegions}.`;
  }
  return { maxRegions: value };
}

interface RankedSurfaceRegion {
  readonly id: string;
  readonly category: "added" | "removed";
  readonly bounds: { readonly min: Vec3; readonly max: Vec3 };
  readonly anchor: Vec3;
  readonly maximumDistance: number;
  readonly meanDistance: number;
  readonly area: number;
  readonly triangleCount: number;
}

function directionalRegions(
  source: FlatGeometry,
  target: FlatGeometry,
  category: "added" | "removed",
  tolerance: number,
): RankedSurfaceRegion[] {
  const deviations = source.triangles.map((triangle) => {
    const samples = [...triangle.points, triangleCentroid(triangle)];
    const distances = samples.map((sample) =>
      distanceToSurface(sample, target.triangles),
    );
    return {
      changed: Math.max(...distances) > tolerance,
      maximum: Math.max(...distances),
      mean: distances.reduce((sum, value) => sum + value, 0) / distances.length,
    };
  });
  const byVertex = new Map<number, number[]>();
  for (const triangle of source.triangles) {
    if (!deviations[triangle.index]?.changed) continue;
    for (const vertex of triangle.vertices) {
      const members = byVertex.get(vertex) ?? [];
      members.push(triangle.index);
      byVertex.set(vertex, members);
    }
  }
  const visited = new Set<number>();
  const regions: RankedSurfaceRegion[] = [];
  for (const seed of source.triangles) {
    if (!deviations[seed.index]?.changed || visited.has(seed.index)) continue;
    const component: Triangle[] = [];
    const stack = [seed.index];
    visited.add(seed.index);
    while (stack.length > 0) {
      const triangleIndex = stack.pop();
      if (triangleIndex === undefined) break;
      const triangle = source.triangles[triangleIndex];
      if (triangle === undefined) continue;
      component.push(triangle);
      for (const vertex of triangle.vertices) {
        for (const neighbor of byVertex.get(vertex) ?? []) {
          if (!visited.has(neighbor)) {
            visited.add(neighbor);
            stack.push(neighbor);
          }
        }
      }
    }
    component.sort((left, right) => left.index - right.index);
    const componentDeviations = component.map(
      (triangle) => deviations[triangle.index]!,
    );
    const bounds = boundsOf(component.flatMap(({ points }) => points));
    const anchorTriangle = component.reduce((best, triangle) =>
      deviations[triangle.index]!.maximum > deviations[best.index]!.maximum
        ? triangle
        : best,
    );
    const serial = String(component[0]!.index).padStart(6, "0");
    regions.push({
      id: `region.surface.${category}.${serial}`,
      category,
      bounds,
      anchor: triangleCentroid(anchorTriangle),
      maximumDistance: Math.max(
        ...componentDeviations.map(({ maximum }) => maximum),
      ),
      meanDistance:
        componentDeviations.reduce((sum, value) => sum + value.mean, 0) /
        componentDeviations.length,
      area: component.reduce((sum, triangle) => sum + triangle.area, 0),
      triangleCount: component.length,
    });
  }
  return regions;
}

function distanceToSurface(
  point: Vec3,
  triangles: readonly Triangle[],
): number {
  let minimumSquared = Number.POSITIVE_INFINITY;
  for (const triangle of triangles) {
    const [a, b, c] = triangle.points;
    minimumSquared = Math.min(
      minimumSquared,
      pointTriangleDistanceSquared(point, a, b, c),
    );
  }
  const distance = Math.sqrt(minimumSquared);
  if (!Number.isFinite(distance)) {
    throw new Error("Surface distance exceeded the supported numeric range.");
  }
  return distance;
}

function compareSurfaceRegion(
  left: RankedSurfaceRegion,
  right: RankedSurfaceRegion,
): number {
  return (
    right.maximumDistance - left.maximumDistance ||
    right.area - left.area ||
    categoryRank(left.category) - categoryRank(right.category) ||
    compareVec3(left.bounds.min, right.bounds.min) ||
    compareText(left.id, right.id)
  );
}

function analyzeAxisAlignedBoxes(
  request: AnalysisRequest,
  baseline: FlatGeometry,
  candidate: FlatGeometry,
  validation: readonly [MeshAssessment, MeshAssessment],
): AnalysisResult {
  if (Object.keys(request.method.parameters).length !== 0) {
    return indeterminate(
      request,
      "invalid-method-parameters",
      ["Axis-aligned box comparison does not accept method parameters."],
      validation,
    );
  }
  const baselineBox = validatedAxisAlignedBox(baseline, validation[0]);
  const candidateBox = validatedAxisAlignedBox(candidate, validation[1]);
  if (baselineBox === undefined || candidateBox === undefined) {
    return indeterminate(
      request,
      "solid-precondition-failed",
      [
        "Exact solid comparison requires each input to be one closed, consistently oriented, indexed axis-aligned box with eight corner vertices and twelve non-degenerate triangles.",
      ],
      validation,
    );
  }
  const exactValidation = validation.map((assessment) => ({
    ...assessment,
    preconditions: [
      ...assessment.preconditions,
      { id: "axis-aligned-box", passed: true as const },
    ],
  })) as [MeshAssessment, MeshAssessment];
  try {
    const cells = symmetricDifferenceCells(baselineBox, candidateBox);
    const baselineVolume = boxVolume(baselineBox);
    const candidateVolume = boxVolume(candidateBox);
    const intersection = intersectionBox(baselineBox, candidateBox);
    const intersectionVolume =
      intersection === undefined ? 0 : boxVolume(intersection);
    const symmetricDifferenceVolume =
      baselineVolume + candidateVolume - 2 * intersectionVolume;
    const values = [
      baselineVolume,
      candidateVolume,
      intersectionVolume,
      symmetricDifferenceVolume,
      ...cells.map(({ volume }) => volume),
    ];
    if (values.some((value) => !Number.isFinite(value))) {
      throw new Error("Solid volume exceeded the supported numeric range.");
    }
    const ranked = cells.sort(
      (left, right) =>
        right.volume - left.volume ||
        categoryRank(left.category) - categoryRank(right.category) ||
        compareVec3(left.bounds.min, right.bounds.min),
    );
    const metrics: Array<{
      id: string;
      value: number;
      unit: "cubic-millimetre" | "count";
    }> = [
      {
        id: "solid.baseline-volume",
        value: baselineVolume,
        unit: "cubic-millimetre",
      },
      {
        id: "solid.candidate-volume",
        value: candidateVolume,
        unit: "cubic-millimetre",
      },
      {
        id: "solid.intersection-volume",
        value: intersectionVolume,
        unit: "cubic-millimetre",
      },
      {
        id: "solid.symmetric-difference-volume",
        value: symmetricDifferenceVolume,
        unit: "cubic-millimetre",
      },
      {
        id: "solid.changed-region-count",
        value: ranked.length,
        unit: "count",
      },
    ];
    const regions = ranked.map((cell, index) => {
      const id = `region.solid.${cell.category}.${String(index).padStart(3, "0")}`;
      const metricId = `${id}.volume`;
      metrics.push({
        id: metricId,
        value: cell.volume,
        unit: "cubic-millimetre",
      });
      return {
        id,
        frame: "comparison" as const,
        category: cell.category,
        bounds: cell.bounds,
        anchor: midpoint(cell.bounds),
        metricIds: [metricId],
        warningCodes: [],
      };
    });
    return analysisResultSchema.parse({
      contractVersion: 1,
      requestId: request.requestId,
      baseline: request.baseline,
      candidate: request.candidate,
      warnings: [],
      outcome: {
        state: "complete",
        semantics: "exact-within-validated-preconditions",
        requestedMethod: request.method,
        effectiveMethod: request.method,
        requestedTolerance: request.tolerance,
        effectiveTolerance: request.tolerance,
        validation: exactValidation,
        metrics,
        regions,
        orderedRegionIds: regions.map(({ id }) => id),
        adjustments: [],
        validatedDomain: {
          id: "axis-aligned-box-domain-v1",
          description:
            "Exact set-volume decomposition for two validated, closed, consistently oriented axis-aligned boxes in the comparison frame.",
          preconditionIds: [
            "closed",
            "consistently-oriented",
            "axis-aligned-box",
          ],
        },
      },
    });
  } catch (error) {
    return indeterminate(
      request,
      "numeric-range-exceeded",
      [
        error instanceof Error
          ? error.message
          : "Solid comparison exceeded the supported numeric range.",
      ],
      exactValidation,
    );
  }
}

interface Bounds {
  readonly min: Vec3;
  readonly max: Vec3;
}

function validatedAxisAlignedBox(
  geometry: FlatGeometry,
  assessment: MeshAssessment,
): Bounds | undefined {
  if (
    geometry.points.length !== 8 ||
    geometry.triangles.length !== 12 ||
    !assessment.closed ||
    !assessment.consistentlyOriented ||
    assessment.degenerateTriangleCount !== 0
  ) {
    return undefined;
  }
  const bounds = boundsOf(geometry.points);
  if (bounds.min.some((value, axis) => value === bounds.max[axis])) {
    return undefined;
  }
  const expected = new Set<string>();
  for (const x of [bounds.min[0], bounds.max[0]]) {
    for (const y of [bounds.min[1], bounds.max[1]]) {
      for (const z of [bounds.min[2], bounds.max[2]]) {
        expected.add(pointKey([x, y, z]));
      }
    }
  }
  const actual = new Set(geometry.points.map(pointKey));
  if (actual.size !== 8 || [...actual].some((point) => !expected.has(point))) {
    return undefined;
  }
  return bounds;
}

interface DifferenceCell {
  readonly category: "added" | "removed";
  readonly bounds: Bounds;
  readonly volume: number;
}

function symmetricDifferenceCells(
  baseline: Bounds,
  candidate: Bounds,
): DifferenceCell[] {
  const axes = [0, 1, 2].map((axis) =>
    uniqueNumbers([
      baseline.min[axis]!,
      baseline.max[axis]!,
      candidate.min[axis]!,
      candidate.max[axis]!,
    ]).sort((left, right) => left - right),
  );
  const cells: DifferenceCell[] = [];
  for (let x = 0; x < axes[0]!.length - 1; x += 1) {
    for (let y = 0; y < axes[1]!.length - 1; y += 1) {
      for (let z = 0; z < axes[2]!.length - 1; z += 1) {
        const bounds: Bounds = {
          min: [axes[0]![x]!, axes[1]![y]!, axes[2]![z]!],
          max: [axes[0]![x + 1]!, axes[1]![y + 1]!, axes[2]![z + 1]!],
        };
        const center = midpoint(bounds);
        const inBaseline = contains(baseline, center);
        const inCandidate = contains(candidate, center);
        if (inBaseline === inCandidate) continue;
        cells.push({
          category: inCandidate ? "added" : "removed",
          bounds,
          volume: boxVolume(bounds),
        });
      }
    }
  }
  return cells;
}

function intersectionBox(first: Bounds, second: Bounds): Bounds | undefined {
  const bounds: Bounds = {
    min: [
      Math.max(first.min[0], second.min[0]),
      Math.max(first.min[1], second.min[1]),
      Math.max(first.min[2], second.min[2]),
    ],
    max: [
      Math.min(first.max[0], second.max[0]),
      Math.min(first.max[1], second.max[1]),
      Math.min(first.max[2], second.max[2]),
    ],
  };
  return bounds.min.some((value, axis) => value >= bounds.max[axis]!)
    ? undefined
    : bounds;
}

function boxVolume(bounds: Bounds): number {
  return (
    (bounds.max[0] - bounds.min[0]) *
    (bounds.max[1] - bounds.min[1]) *
    (bounds.max[2] - bounds.min[2])
  );
}

function contains(bounds: Bounds, point: Vec3): boolean {
  return point.every(
    (value, axis) => value > bounds.min[axis]! && value < bounds.max[axis]!,
  );
}

function midpoint(bounds: Bounds): Vec3 {
  return [
    (bounds.min[0] + bounds.max[0]) / 2,
    (bounds.min[1] + bounds.max[1]) / 2,
    (bounds.min[2] + bounds.max[2]) / 2,
  ];
}

function boundsOf(points: readonly Vec3[]): Bounds {
  if (points.length === 0) throw new Error("Cannot bound empty geometry.");
  const minimum: Vec3 = [...points[0]!] as Vec3;
  const maximum: Vec3 = [...points[0]!] as Vec3;
  for (const point of points.slice(1)) {
    for (let axis = 0; axis < 3; axis += 1) {
      minimum[axis] = Math.min(minimum[axis]!, point[axis]!);
      maximum[axis] = Math.max(maximum[axis]!, point[axis]!);
    }
  }
  return { min: minimum, max: maximum };
}

function pointKey(point: Vec3): string {
  return `${point[0]},${point[1]},${point[2]}`;
}

function uniqueNumbers(values: readonly number[]): number[] {
  return [...new Set(values)];
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareText);
}

function categoryRank(category: "added" | "removed"): number {
  return category === "added" ? 0 : 1;
}

function compareVec3(left: Vec3, right: Vec3): number {
  return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function indeterminate(
  request: AnalysisRequest,
  code: string,
  reasons: readonly string[],
  validation: readonly MeshAssessment[] = [],
): AnalysisResult {
  return analysisResultSchema.parse({
    contractVersion: 1,
    requestId: request.requestId,
    baseline: request.baseline,
    candidate: request.candidate,
    warnings: [],
    outcome: {
      state: "indeterminate",
      code,
      reasons,
      requestedMethod: request.method,
      requestedTolerance: request.tolerance,
      validation,
    },
  });
}
