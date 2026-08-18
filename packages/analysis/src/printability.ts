import {
  IDENTITY_MAT4,
  normalizedModelSchema,
  rigidTransformSchema,
} from "@voxelspy/contracts";
import type {
  NormalizedModel,
  RigidTransform,
  Vec3,
} from "@voxelspy/contracts";

import {
  ANALYSIS_LIMITS,
  SAMPLE_SPACING_EDGE_FACTOR,
  WorkBudget,
  WorkBudgetExceeded,
  WorkBudgetInternalError,
  boundsOfTriangles,
  checkExpandedGeometryBudget,
} from "./analyze.js";
import type { Bounds } from "./analyze.js";
import { comparePoints, normalizeZero } from "./chain-tracing.js";
import {
  countExpandedGeometry,
  flattenModel,
  triangleAreaAt,
} from "./geometry.js";
import type { FlatGeometry, WorkUnitCounter } from "./geometry.js";
import { resolveBound } from "./inspect.js";
import {
  canonicalEdgeKey,
  groupTrianglesByExactEdgeConnectivity,
  pointKeyAt,
} from "./region-connectivity.js";
import { TriangleSpatialIndex } from "./spatial-index.js";

export const PRINTABILITY_METHOD_ID = "printability-inspector";
export const PRINTABILITY_METHOD_VERSION = "1.0.0";

/**
 * Carried verbatim on every `PrintabilityAssessment`, so a UI never has to
 * invent its own summary sentence for what this report does and does not
 * claim. This package reports measured evidence about the tessellated
 * surface; it never concludes that a model "will print" -- that conclusion
 * depends on slicer settings, material, and printer calibration this
 * package has no access to and no domain-validated model of.
 */
export const PRINTABILITY_DISCLAIMER =
  "This report is evidence for a human decision, not a printability verdict. It measures the tessellated surface only -- it does not know your slicer settings, material, or printer calibration, and it does not certify that this model will print successfully.";

/** A caller programming error, not a data-driven runtime outcome: invalid ray/vector input (a non-finite or degenerate `overhang.buildDirection`, non-finite or non-positive `buildVolume.dimensionsMillimetres`), or a model with no triangles after flattening. Mirrors `MeasurementInputError` (`src/measure.ts`). */
export class PrintabilityInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrintabilityInputError";
  }
}

/** Thrown when expanded geometry, or a caller-supplied `executionBudget`, cannot accommodate the assessment -- before any O(vertices + triangles) work runs. Mirrors `MeasurementResourceLimitError` (`src/measure.ts`). */
export class PrintabilityResourceLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrintabilityResourceLimitError";
  }
}

const IDENTITY_RIGID: RigidTransform =
  rigidTransformSchema.parse(IDENTITY_MAT4);

// ---------------------------------------------------------------------------
// Wall thickness / thin regions
// ---------------------------------------------------------------------------

/** Default `wallThickness.thinThresholdMillimetres`: an adjustable, arbitrary default (not a printer- or material-specific recommendation) below which a probed thickness is reported as a finding. */
export const DEFAULT_THIN_WALL_THRESHOLD_MILLIMETRES = 0.8;
/** Implementation ceiling on `WallThicknessOptions.thinThresholdMillimetres`. */
export const MAX_THIN_WALL_THRESHOLD_MILLIMETRES = 100_000;
/** Default `wallThickness.maxSampleTriangles`. */
export const DEFAULT_MAX_WALL_THICKNESS_SAMPLE_TRIANGLES = 20_000;
/** Implementation ceiling on `WallThicknessOptions.maxSampleTriangles`. */
export const MAX_WALL_THICKNESS_SAMPLE_TRIANGLES = 200_000;
/** Default `wallThickness.maxFindings`. */
export const DEFAULT_MAX_WALL_THICKNESS_FINDINGS = 50;
/** Implementation ceiling on `WallThicknessOptions.maxFindings`; reuses `ANALYSIS_LIMITS.maxReportedRegions`, the same ceiling `surface-distance`'s `maxRegions` and `checkClearance`'s `maxTightRegions` enforce. */
export const MAX_WALL_THICKNESS_FINDINGS = ANALYSIS_LIMITS.maxReportedRegions;

/** Charged per sampled triangle for centroid/normal/edge-length computation, before its ray cast (itself charged separately by `TriangleSpatialIndex.castRayNearest`). */
const WALL_THICKNESS_SAMPLE_WORK_UNITS = 4;

export interface WallThicknessOptions {
  /** Probed thickness below this is reported as a finding. Bounded by `MAX_THIN_WALL_THRESHOLD_MILLIMETRES`. Defaults to `DEFAULT_THIN_WALL_THRESHOLD_MILLIMETRES`. */
  readonly thinThresholdMillimetres?: number;
  /** How many triangles are probed (one inward ray per sampled triangle, cast from its centroid). Bounded by `MAX_WALL_THICKNESS_SAMPLE_TRIANGLES`. Defaults to `DEFAULT_MAX_WALL_THICKNESS_SAMPLE_TRIANGLES`. */
  readonly maxSampleTriangles?: number;
  /** How many of the thinnest findings are returned. Bounded by `MAX_WALL_THICKNESS_FINDINGS`. Defaults to `DEFAULT_MAX_WALL_THICKNESS_FINDINGS`. */
  readonly maxFindings?: number;
}

export interface WallThicknessFinding {
  readonly positionMillimetres: Vec3;
  readonly triangleIndex: number;
  /** Unit vector: the sampled triangle's inverted (inward-pointing) outward normal -- the direction actually probed. */
  readonly inwardDirection: Vec3;
  readonly thicknessMillimetres: number;
  readonly oppositePositionMillimetres: Vec3;
  readonly oppositeTriangleIndex: number;
}

export interface WallThicknessCheck {
  /**
   * Always `"approximate-directional-probe"`. This measures the distance
   * from a sampled surface point to the first opposite-surface point hit by
   * casting a ray straight in along that point's own inverted normal --
   * NOT the true local minimal thickness, which can be smaller when
   * measured along a different direction (e.g. diagonally through a
   * corner). It is also silent about any surface location that was never
   * sampled (see `unsampledTriangleCount`/`sampleSpacingUpperBoundMillimetres`
   * below) and about any probe whose ray happened to find no opposite
   * surface at all (`missedProbeCount`).
   */
  readonly semantics: "approximate-directional-probe";
  readonly thinThresholdMillimetres: number;
  /** How many triangles were actually probed (one centroid ray each). */
  readonly sampledTriangleCount: number;
  readonly totalTriangleCount: number;
  /** `totalTriangleCount - sampledTriangleCount`: triangles that received no probe at all because the sample budget ran out. A thin feature confined entirely to these triangles is invisible to this check, not merely uncertain. */
  readonly unsampledTriangleCount: number;
  /**
   * An upper bound, in millimetres, on the distance from any point on a
   * SAMPLED triangle to that triangle's own probed centroid (at most
   * two-thirds of that triangle's longest edge -- the same convex-polygon
   * argument behind `surface-distance`'s `SAMPLE_SPACING_EDGE_FACTOR`
   * bound, specialized to a single centroid sample instead of
   * vertices-plus-centroid). This says nothing about `unsampledTriangleCount`
   * triangles, which have no coverage guarantee at all;
   * `Number.POSITIVE_INFINITY` when `sampledTriangleCount` is `0`.
   */
  readonly sampleSpacingUpperBoundMillimetres: number;
  /** Probes whose inward ray found no opposite surface (an open mesh boundary, a degenerate source triangle, or inconsistent winding can each cause this). These sampled locations contribute no finding, honestly, rather than being silently dropped. */
  readonly missedProbeCount: number;
  /** Ascending by `thicknessMillimetres` (thinnest first), bounded by the active `maxFindings`. */
  readonly findings: readonly WallThicknessFinding[];
  /** The true number of below-threshold findings detected, independent of `maxFindings` truncation. */
  readonly findingCount: number;
  readonly truncated: boolean;
}

interface TriangleGeometry {
  readonly centroidX: number;
  readonly centroidY: number;
  readonly centroidZ: number;
  /** Unnormalized `cross(e1, e2)`; its length is `2 * area`. */
  readonly normalX: number;
  readonly normalY: number;
  readonly normalZ: number;
  readonly normalLength: number;
  readonly longestEdgeMillimetres: number;
}

function triangleGeometryAt(
  geometry: FlatGeometry,
  triangleIndex: number,
): TriangleGeometry {
  const base = triangleIndex * 3;
  const indices = geometry.indices;
  const positions = geometry.positions;
  const ia = indices[base]!;
  const ib = indices[base + 1]!;
  const ic = indices[base + 2]!;
  const ax = positions[ia * 3]!;
  const ay = positions[ia * 3 + 1]!;
  const az = positions[ia * 3 + 2]!;
  const bx = positions[ib * 3]!;
  const by = positions[ib * 3 + 1]!;
  const bz = positions[ib * 3 + 2]!;
  const cx = positions[ic * 3]!;
  const cy = positions[ic * 3 + 1]!;
  const cz = positions[ic * 3 + 2]!;
  const e1x = bx - ax;
  const e1y = by - ay;
  const e1z = bz - az;
  const e2x = cx - ax;
  const e2y = cy - ay;
  const e2z = cz - az;
  const normalX = e1y * e2z - e1z * e2y;
  const normalY = e1z * e2x - e1x * e2z;
  const normalZ = e1x * e2y - e1y * e2x;
  const edgeAB = Math.hypot(e1x, e1y, e1z);
  const edgeBC = Math.hypot(cx - bx, cy - by, cz - bz);
  const edgeCA = Math.hypot(ax - cx, ay - cy, az - cz);
  return {
    centroidX: (ax + bx + cx) / 3,
    centroidY: (ay + by + cy) / 3,
    centroidZ: (az + bz + cz) / 3,
    normalX,
    normalY,
    normalZ,
    normalLength: Math.hypot(normalX, normalY, normalZ),
    longestEdgeMillimetres: Math.max(edgeAB, edgeBC, edgeCA),
  };
}

/**
 * Deterministic, evenly-spaced subset of `[0, triangleCount)`, size
 * `min(triangleCount, maxSamples)`: every triangle when the budget covers
 * them all, else a fixed stride walk (`floor(i * triangleCount / maxSamples)`)
 * so the sampled set spreads across the whole triangle order rather than
 * clustering at one end.
 */
function selectSampleTriangles(
  triangleCount: number,
  maxSamples: number,
): Uint32Array {
  if (triangleCount <= maxSamples) {
    const all = new Uint32Array(triangleCount);
    for (let index = 0; index < triangleCount; index += 1) all[index] = index;
    return all;
  }
  const result = new Uint32Array(maxSamples);
  for (let index = 0; index < maxSamples; index += 1) {
    result[index] = Math.floor((index * triangleCount) / maxSamples);
  }
  return result;
}

interface CheckOutcome<T> {
  readonly check: T;
  readonly warnings: PrintabilityWarning[];
}

function computeWallThickness(
  geometry: FlatGeometry,
  index: TriangleSpatialIndex,
  work: WorkUnitCounter,
  options: WallThicknessOptions | undefined,
): CheckOutcome<WallThicknessCheck> {
  const thinThreshold = resolveFiniteRangeBound(
    options?.thinThresholdMillimetres,
    DEFAULT_THIN_WALL_THRESHOLD_MILLIMETRES,
    0,
    MAX_THIN_WALL_THRESHOLD_MILLIMETRES,
    "wallThickness.thinThresholdMillimetres",
  );
  const maxSampleTriangles = resolveBound(
    options?.maxSampleTriangles,
    DEFAULT_MAX_WALL_THICKNESS_SAMPLE_TRIANGLES,
    MAX_WALL_THICKNESS_SAMPLE_TRIANGLES,
    "wallThickness.maxSampleTriangles",
  );
  const maxFindings = resolveBound(
    options?.maxFindings,
    DEFAULT_MAX_WALL_THICKNESS_FINDINGS,
    MAX_WALL_THICKNESS_FINDINGS,
    "wallThickness.maxFindings",
  );

  const triangleCount = geometry.triangleCount;
  const sampleTriangles = selectSampleTriangles(
    triangleCount,
    maxSampleTriangles,
  );
  work.charge(sampleTriangles.length * WALL_THICKNESS_SAMPLE_WORK_UNITS);

  const findings: WallThicknessFinding[] = [];
  let missedProbeCount = 0;
  let maxLongestEdgeSampled = 0;

  for (let ordinal = 0; ordinal < sampleTriangles.length; ordinal += 1) {
    const triangle = sampleTriangles[ordinal]!;
    const geometryAt = triangleGeometryAt(geometry, triangle);
    if (geometryAt.longestEdgeMillimetres > maxLongestEdgeSampled) {
      maxLongestEdgeSampled = geometryAt.longestEdgeMillimetres;
    }
    if (!(geometryAt.normalLength > 0)) {
      // Degenerate (zero-area) source triangle: no defined normal, so no
      // inward direction can be probed from it.
      missedProbeCount += 1;
      continue;
    }
    const inwardX = -geometryAt.normalX / geometryAt.normalLength;
    const inwardY = -geometryAt.normalY / geometryAt.normalLength;
    const inwardZ = -geometryAt.normalZ / geometryAt.normalLength;
    const hit = index.castRayNearest(
      geometryAt.centroidX,
      geometryAt.centroidY,
      geometryAt.centroidZ,
      inwardX,
      inwardY,
      inwardZ,
      work,
      triangle,
    );
    if (hit === undefined) {
      missedProbeCount += 1;
      continue;
    }
    const thickness = hit.t;
    if (thickness < thinThreshold) {
      findings.push({
        positionMillimetres: [
          normalizeZero(geometryAt.centroidX),
          normalizeZero(geometryAt.centroidY),
          normalizeZero(geometryAt.centroidZ),
        ],
        triangleIndex: triangle,
        inwardDirection: [
          normalizeZero(inwardX),
          normalizeZero(inwardY),
          normalizeZero(inwardZ),
        ],
        thicknessMillimetres: thickness,
        oppositePositionMillimetres: [
          normalizeZero(geometryAt.centroidX + inwardX * thickness),
          normalizeZero(geometryAt.centroidY + inwardY * thickness),
          normalizeZero(geometryAt.centroidZ + inwardZ * thickness),
        ],
        oppositeTriangleIndex: hit.triangleIndex,
      });
    }
  }

  findings.sort(
    (left, right) =>
      left.thicknessMillimetres - right.thicknessMillimetres ||
      left.triangleIndex - right.triangleIndex,
  );
  const findingCount = findings.length;
  const reported = findings.slice(0, maxFindings);

  const sampledTriangleCount = sampleTriangles.length;
  const unsampledTriangleCount = triangleCount - sampledTriangleCount;
  const sampleSpacingUpperBoundMillimetres =
    sampledTriangleCount === 0
      ? Number.POSITIVE_INFINITY
      : SAMPLE_SPACING_EDGE_FACTOR * maxLongestEdgeSampled;

  const warnings: PrintabilityWarning[] = [];
  if (unsampledTriangleCount > 0) {
    warnings.push({
      code: "printability.wall-thickness-undersampled",
      severity: "warning",
      message: `${unsampledTriangleCount} of ${triangleCount} triangles were not probed for wall thickness because of the sample budget; a thin feature confined to those triangles could be missed entirely.`,
      details: { unsampledTriangleCount, totalTriangleCount: triangleCount },
    });
  }
  if (missedProbeCount > 0) {
    warnings.push({
      code: "printability.wall-thickness-probe-missed",
      severity: "warning",
      message: `${missedProbeCount} of ${sampledTriangleCount} inward thickness probes found no opposite surface (an open mesh boundary, a degenerate source triangle, or inconsistent winding can each cause this); those sampled locations contribute no finding.`,
      details: { missedProbeCount, sampledTriangleCount },
    });
  }
  if (reported.length < findingCount) {
    warnings.push({
      code: "printability.wall-thickness-finding-limit",
      severity: "info",
      message: `${findingCount - reported.length} additional thin-wall findings were detected but not included in this bounded report.`,
      details: {
        detectedFindingCount: findingCount,
        reportedFindingCount: reported.length,
      },
    });
  }

  return {
    check: {
      semantics: "approximate-directional-probe",
      thinThresholdMillimetres: thinThreshold,
      sampledTriangleCount,
      totalTriangleCount: triangleCount,
      unsampledTriangleCount,
      sampleSpacingUpperBoundMillimetres,
      missedProbeCount,
      findings: reported,
      findingCount,
      truncated: reported.length < findingCount,
    },
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Overhangs
// ---------------------------------------------------------------------------

export const DEFAULT_OVERHANG_THRESHOLD_DEGREES_FROM_VERTICAL = 45;
export const DEFAULT_MAX_OVERHANG_REGIONS = 50;
export const MAX_OVERHANG_REGIONS = ANALYSIS_LIMITS.maxReportedRegions;

const OVERHANG_TRIANGLE_WORK_UNITS = 6;

export interface OverhangOptions {
  /** Defaults to `[0, 0, 1]`. Must be finite and non-degenerate; normalized internally. */
  readonly buildDirection?: Vec3;
  /** Degrees from vertical (`0` = a vertical wall, `90` = a flat downward-facing ceiling); a face is flagged when its own angle from vertical is strictly greater. Must be finite, between 0 and 90. Defaults to `DEFAULT_OVERHANG_THRESHOLD_DEGREES_FROM_VERTICAL`. */
  readonly thresholdDegreesFromVertical?: number;
  /** Bounded by `MAX_OVERHANG_REGIONS`. Defaults to `DEFAULT_MAX_OVERHANG_REGIONS`. */
  readonly maxRegions?: number;
}

export interface OverhangRegion {
  readonly id: string;
  readonly bounds: Bounds;
  /** Centroid of this region's most-overhanging (largest angle-from-vertical) triangle. */
  readonly anchor: Vec3;
  readonly maxAngleFromVerticalDegrees: number;
  readonly areaSquareMillimetres: number;
  readonly triangleCount: number;
  readonly triangleIndices: readonly number[];
}

export interface OverhangCheck {
  /**
   * Always `"exact-for-tessellated-surface"`: each triangle's angle to
   * `buildDirection` is an exact closed-form fact about the triangle's own
   * three vertices (ordinary floating-point arithmetic on exact input
   * coordinates, not a sampled approximation) -- the same "exact for the
   * tessellated mesh, not the original curved geometry it approximates"
   * sense `measureOnModel`'s `semantics: "exact"` results use. This is
   * unlike `wallThickness` above, which samples a bounded subset of
   * surface points.
   */
  readonly semantics: "exact-for-tessellated-surface";
  /** Normalized. */
  readonly buildDirection: Vec3;
  readonly thresholdDegreesFromVertical: number;
  readonly totalSurfaceAreaSquareMillimetres: number;
  readonly overhangAreaSquareMillimetres: number;
  /** `0` when `totalSurfaceAreaSquareMillimetres` is `0`. */
  readonly overhangAreaFraction: number;
  /** Ranked descending by `areaSquareMillimetres`, bounded by the active `maxRegions`. Grouped using the same exact-coordinate edge connectivity `surface-distance` and `checkClearance` use. */
  readonly regions: readonly OverhangRegion[];
  /** The true number of overhang regions found, independent of truncation. */
  readonly detectedRegionCount: number;
  readonly truncated: boolean;
}

function computeOverhangs(
  geometry: FlatGeometry,
  work: WorkUnitCounter,
  options: OverhangOptions | undefined,
): CheckOutcome<OverhangCheck> {
  const rawDirection = options?.buildDirection ?? [0, 0, 1];
  if (!rawDirection.every((value) => Number.isFinite(value))) {
    throw new PrintabilityInputError(
      "overhang.buildDirection must have finite x/y/z components.",
    );
  }
  const rawLength = Math.hypot(...rawDirection);
  if (!(rawLength > 0)) {
    throw new PrintabilityInputError(
      "overhang.buildDirection must be a non-degenerate, finite direction vector.",
    );
  }
  const buildDirection: Vec3 = [
    rawDirection[0] / rawLength,
    rawDirection[1] / rawLength,
    rawDirection[2] / rawLength,
  ];
  const thresholdDegrees = resolveFiniteRangeBound(
    options?.thresholdDegreesFromVertical,
    DEFAULT_OVERHANG_THRESHOLD_DEGREES_FROM_VERTICAL,
    0,
    90,
    "overhang.thresholdDegreesFromVertical",
  );
  const maxRegions = resolveBound(
    options?.maxRegions,
    DEFAULT_MAX_OVERHANG_REGIONS,
    MAX_OVERHANG_REGIONS,
    "overhang.maxRegions",
  );

  const triangleCount = geometry.triangleCount;
  work.charge(triangleCount * OVERHANG_TRIANGLE_WORK_UNITS);

  const flagged = new Uint8Array(triangleCount);
  const angleAt = new Float64Array(triangleCount);
  let totalArea = 0;
  let overhangArea = 0;

  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    const geometryAt = triangleGeometryAt(geometry, triangle);
    const area = geometryAt.normalLength / 2;
    totalArea += area;
    if (!(geometryAt.normalLength > 0)) continue; // degenerate: undefined normal, not classifiable
    const cosTheta =
      (geometryAt.normalX * buildDirection[0] +
        geometryAt.normalY * buildDirection[1] +
        geometryAt.normalZ * buildDirection[2]) /
      geometryAt.normalLength;
    const clamped = Math.max(-1, Math.min(1, cosTheta));
    const angleFromVertical = (Math.acos(clamped) * 180) / Math.PI - 90;
    angleAt[triangle] = angleFromVertical;
    if (angleFromVertical > thresholdDegrees) {
      flagged[triangle] = 1;
      overhangArea += area;
    }
  }

  const components = groupTrianglesByExactEdgeConnectivity(geometry, flagged);
  const regions: OverhangRegion[] = components.map((component) => {
    const bounds = boundsOfTriangles(geometry, component);
    let anchorTriangle = component[0]!;
    let maxAngle = angleAt[component[0]!]!;
    let areaSum = 0;
    for (const triangle of component) {
      areaSum += triangleAreaAt(geometry, triangle);
      const angle = angleAt[triangle]!;
      if (angle > maxAngle) {
        maxAngle = angle;
        anchorTriangle = triangle;
      }
    }
    return {
      id: `printability.overhang.${String(component[0]!).padStart(6, "0")}`,
      bounds,
      anchor: triangleGeometryAtCentroid(geometry, anchorTriangle),
      maxAngleFromVerticalDegrees: maxAngle,
      areaSquareMillimetres: areaSum,
      triangleCount: component.length,
      triangleIndices: component,
    };
  });

  regions.sort(
    (left, right) =>
      right.areaSquareMillimetres - left.areaSquareMillimetres ||
      right.maxAngleFromVerticalDegrees - left.maxAngleFromVerticalDegrees ||
      comparePoints(left.bounds.min, right.bounds.min) ||
      compareText(left.id, right.id),
  );

  const detectedRegionCount = regions.length;
  const reported = regions.slice(0, maxRegions);

  const warnings: PrintabilityWarning[] = [];
  if (reported.length < detectedRegionCount) {
    warnings.push({
      code: "printability.overhang-region-limit",
      severity: "info",
      message: `${detectedRegionCount - reported.length} additional overhang regions were detected but not included in this bounded report.`,
      details: {
        detectedRegionCount,
        reportedRegionCount: reported.length,
      },
    });
  }

  return {
    check: {
      semantics: "exact-for-tessellated-surface",
      buildDirection,
      thresholdDegreesFromVertical: thresholdDegrees,
      totalSurfaceAreaSquareMillimetres: totalArea,
      overhangAreaSquareMillimetres: overhangArea,
      overhangAreaFraction: totalArea > 0 ? overhangArea / totalArea : 0,
      regions: reported,
      detectedRegionCount,
      truncated: reported.length < detectedRegionCount,
    },
    warnings,
  };
}

function triangleGeometryAtCentroid(
  geometry: FlatGeometry,
  triangleIndex: number,
): Vec3 {
  const geometryAt = triangleGeometryAt(geometry, triangleIndex);
  return [
    normalizeZero(geometryAt.centroidX),
    normalizeZero(geometryAt.centroidY),
    normalizeZero(geometryAt.centroidZ),
  ];
}

// ---------------------------------------------------------------------------
// Islands / disconnected shells
// ---------------------------------------------------------------------------

export const DEFAULT_MAX_ISLAND_COMPONENTS = 200;
export const MAX_ISLAND_COMPONENTS = ANALYSIS_LIMITS.maxReportedRegions;

const ISLAND_TRIANGLE_WORK_UNITS = 6;

export interface IslandOptions {
  /** Bounded by `MAX_ISLAND_COMPONENTS`. Defaults to `DEFAULT_MAX_ISLAND_COMPONENTS`. */
  readonly maxComponents?: number;
}

export type IslandVolumeUnavailableReason =
  | "boundary-edges"
  | "non-manifold-edges"
  | "inconsistent-orientation"
  | "degenerate-triangles";

export interface IslandComponent {
  readonly id: string;
  readonly triangleCount: number;
  readonly bounds: Bounds;
  readonly volume:
    | { readonly available: true; readonly cubicMillimetres: number }
    | {
        readonly available: false;
        readonly reasons: readonly IslandVolumeUnavailableReason[];
      };
}

export interface IslandCheck {
  /** Always `"exact-connectivity"`: components are exact-coordinate edge-connected triangle groups (see "Topology semantics" in ../README.md), the same connectivity `summarizeModelGeometry`'s `componentCount` and `surface-distance`'s region grouping already use -- this reuses that shared implementation rather than a second one. */
  readonly semantics: "exact-connectivity";
  readonly componentCount: number;
  /** Descending by `triangleCount`, bounded by the active `maxComponents`. */
  readonly components: readonly IslandComponent[];
  readonly truncated: boolean;
}

interface ComponentTopology {
  readonly boundaryEdgeCount: number;
  readonly nonManifoldEdgeCount: number;
  readonly inconsistentEdgeCount: number;
  readonly degenerateTriangleCount: number;
  readonly signedVolume: number;
}

/**
 * The same exact-coordinate manifold edge census `assessGeometry`
 * (`src/analyze.ts`) performs, and the same signed-volume formula
 * `computeTopology` (`src/summary.ts`) uses, both scoped to one connected
 * component's own triangle subset instead of a whole model -- neither
 * existing function can be reused directly since both operate over an
 * entire `FlatGeometry`/placed-triangle list, not an arbitrary triangle
 * subset. Uses a Kahan-compensated running sum for the same reason
 * `computeTopology`'s private `CompensatedSum` does: many small per-triangle
 * signed-tetrahedron terms summed naively can lose precision.
 */
function componentTopology(
  geometry: FlatGeometry,
  triangleIndices: readonly number[],
): ComponentTopology {
  const positions = geometry.positions;
  const indices = geometry.indices;
  const edges = new Map<string, { forward: number; reverse: number }>();
  let degenerateTriangleCount = 0;
  let volumeSum = 0;
  let volumeCompensation = 0;

  for (const triangle of triangleIndices) {
    const base = triangle * 3;
    const ia = indices[base]!;
    const ib = indices[base + 1]!;
    const ic = indices[base + 2]!;
    const area = triangleAreaAt(geometry, triangle);
    if (!(area > 0) || !Number.isFinite(area)) degenerateTriangleCount += 1;

    const ax = positions[ia * 3]!;
    const ay = positions[ia * 3 + 1]!;
    const az = positions[ia * 3 + 2]!;
    const bx = positions[ib * 3]!;
    const by = positions[ib * 3 + 1]!;
    const bz = positions[ib * 3 + 2]!;
    const cx = positions[ic * 3]!;
    const cy = positions[ic * 3 + 1]!;
    const cz = positions[ic * 3 + 2]!;
    const crossX = by * cz - bz * cy;
    const crossY = bz * cx - bx * cz;
    const crossZ = bx * cy - by * cx;
    const term = (ax * crossX + ay * crossY + az * crossZ) / 6;
    const adjusted = term - volumeCompensation;
    const next = volumeSum + adjusted;
    volumeCompensation = next - volumeSum - adjusted;
    volumeSum = next;

    const keyA = pointKeyAt(geometry, ia);
    const keyB = pointKeyAt(geometry, ib);
    const keyC = pointKeyAt(geometry, ic);
    addComponentEdge(edges, keyA, keyB);
    addComponentEdge(edges, keyB, keyC);
    addComponentEdge(edges, keyC, keyA);
  }

  let boundaryEdgeCount = 0;
  let nonManifoldEdgeCount = 0;
  let inconsistentEdgeCount = 0;
  for (const edge of edges.values()) {
    const total = edge.forward + edge.reverse;
    if (total === 1) boundaryEdgeCount += 1;
    else if (total > 2) nonManifoldEdgeCount += 1;
    else if (edge.forward !== 1 || edge.reverse !== 1)
      inconsistentEdgeCount += 1;
  }

  return {
    boundaryEdgeCount,
    nonManifoldEdgeCount,
    inconsistentEdgeCount,
    degenerateTriangleCount,
    signedVolume: volumeSum,
  };
}

function addComponentEdge(
  edges: Map<string, { forward: number; reverse: number }>,
  fromKey: string,
  toKey: string,
): void {
  const { key, forward } = canonicalEdgeKey(fromKey, toKey);
  const edge = edges.get(key) ?? { forward: 0, reverse: 0 };
  if (forward) edge.forward += 1;
  else edge.reverse += 1;
  edges.set(key, edge);
}

function computeIslands(
  geometry: FlatGeometry,
  work: WorkUnitCounter,
  options: IslandOptions | undefined,
): CheckOutcome<IslandCheck> {
  const maxComponents = resolveBound(
    options?.maxComponents,
    DEFAULT_MAX_ISLAND_COMPONENTS,
    MAX_ISLAND_COMPONENTS,
    "islands.maxComponents",
  );

  const triangleCount = geometry.triangleCount;
  work.charge(triangleCount * ISLAND_TRIANGLE_WORK_UNITS);

  const allFlagged = new Uint8Array(triangleCount).fill(1);
  const components = groupTrianglesByExactEdgeConnectivity(
    geometry,
    allFlagged,
  );

  const built: IslandComponent[] = components.map((component) => {
    const bounds = boundsOfTriangles(geometry, component);
    const topology = componentTopology(geometry, component);
    const reasons: IslandVolumeUnavailableReason[] = [];
    if (topology.degenerateTriangleCount > 0)
      reasons.push("degenerate-triangles");
    if (topology.boundaryEdgeCount > 0) reasons.push("boundary-edges");
    if (topology.nonManifoldEdgeCount > 0) reasons.push("non-manifold-edges");
    if (topology.inconsistentEdgeCount > 0)
      reasons.push("inconsistent-orientation");
    return {
      id: `printability.island.${String(component[0]!).padStart(6, "0")}`,
      triangleCount: component.length,
      bounds,
      volume:
        reasons.length === 0
          ? {
              available: true,
              cubicMillimetres: Math.abs(normalizeZero(topology.signedVolume)),
            }
          : { available: false, reasons },
    };
  });

  built.sort(
    (left, right) =>
      right.triangleCount - left.triangleCount ||
      comparePoints(left.bounds.min, right.bounds.min) ||
      compareText(left.id, right.id),
  );

  const componentCount = built.length;
  const reported = built.slice(0, maxComponents);

  const warnings: PrintabilityWarning[] = [];
  if (reported.length < componentCount) {
    warnings.push({
      code: "printability.island-limit",
      severity: "info",
      message: `${componentCount - reported.length} additional disconnected components were detected but not included in this bounded report.`,
      details: { componentCount, reportedComponentCount: reported.length },
    });
  }
  if (componentCount > 1) {
    warnings.push({
      code: "printability.multiple-islands",
      severity: "warning",
      message: `This model contains ${componentCount} disconnected shells; verify each is intentional -- a stray fragment prints as loose, disconnected material, not part of the intended object.`,
      details: { componentCount },
    });
  }

  return {
    check: {
      semantics: "exact-connectivity",
      componentCount,
      components: reported,
      truncated: reported.length < componentCount,
    },
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Build volume
// ---------------------------------------------------------------------------

const AXIS_PERMUTATIONS: readonly (readonly [
  0 | 1 | 2,
  0 | 1 | 2,
  0 | 1 | 2,
])[] = [
  [0, 1, 2],
  [0, 2, 1],
  [1, 0, 2],
  [1, 2, 0],
  [2, 0, 1],
  [2, 1, 0],
];

export interface BuildVolumeOptions {
  /** Optional; when omitted, `buildVolume.semantics` is `"not-configured"` and no fit judgment is made. Must have finite, positive x/y/z components when supplied. */
  readonly dimensionsMillimetres?: Vec3;
}

export interface BuildVolumeOrientationFit {
  /** `modelAxisForBuildAxis[i]` is which model axis (`0` = x, `1` = y, `2` = z) is placed along build axis `i`. `[0, 1, 2]` is the model exactly as given (no reorientation). */
  readonly modelAxisForBuildAxis: readonly [0 | 1 | 2, 0 | 1 | 2, 0 | 1 | 2];
  readonly fits: boolean;
  /** Per build axis: `0` where that axis fits, else the positive millimetre excess. */
  readonly exceedsByMillimetres: Vec3;
}

export type BuildVolumeCheck =
  | {
      readonly semantics: "not-configured";
      readonly dimensionsMillimetres: Vec3;
    }
  | {
      /** Always `"exact-axis-aligned-fit"`: only the six axis-order permutations of the model's own axis-aligned bounding box are checked -- never an arbitrary rotation search, per this check's documented scope. */
      readonly semantics: "exact-axis-aligned-fit";
      readonly dimensionsMillimetres: Vec3;
      readonly buildVolumeDimensionsMillimetres: Vec3;
      /** Whether the model fits exactly as currently placed (the `[0, 1, 2]` orientation). */
      readonly fitsAsGiven: boolean;
      /** All six axis-order permutations, `[0, 1, 2]` (as-given) first. */
      readonly orientations: readonly BuildVolumeOrientationFit[];
      readonly fitsInAnyOrientation: boolean;
    };

function computeBuildVolume(
  dimensionsMillimetres: Vec3,
  options: BuildVolumeOptions | undefined,
): CheckOutcome<BuildVolumeCheck> {
  const buildDimensions = options?.dimensionsMillimetres;
  if (buildDimensions === undefined) {
    return {
      check: { semantics: "not-configured", dimensionsMillimetres },
      warnings: [],
    };
  }
  if (!buildDimensions.every((value) => Number.isFinite(value) && value > 0)) {
    throw new PrintabilityInputError(
      "buildVolume.dimensionsMillimetres must have finite, positive x/y/z components.",
    );
  }

  const orientations: BuildVolumeOrientationFit[] = AXIS_PERMUTATIONS.map(
    (permutation) => {
      const exceedsByMillimetres: [number, number, number] = [0, 0, 0];
      let fits = true;
      for (let axis = 0; axis < 3; axis += 1) {
        const modelAxis = permutation[axis]!;
        const modelDimension = dimensionsMillimetres[modelAxis]!;
        const excess = normalizeZero(modelDimension - buildDimensions[axis]!);
        if (excess > 0) fits = false;
        exceedsByMillimetres[axis] = Math.max(0, excess);
      }
      return {
        modelAxisForBuildAxis: permutation,
        fits,
        exceedsByMillimetres,
      };
    },
  );
  const fitsAsGiven = orientations[0]!.fits;
  const fitsInAnyOrientation = orientations.some(
    (orientation) => orientation.fits,
  );

  const warnings: PrintabilityWarning[] = [];
  if (!fitsInAnyOrientation) {
    warnings.push({
      code: "printability.exceeds-build-volume",
      severity: "warning",
      message:
        "This model's extents do not fit inside the supplied build volume in any axis-aligned orientation.",
    });
  } else if (!fitsAsGiven) {
    warnings.push({
      code: "printability.fits-only-when-reoriented",
      severity: "info",
      message:
        "This model fits the supplied build volume only when reoriented onto a different axis; it does not fit as currently placed.",
    });
  }

  return {
    check: {
      semantics: "exact-axis-aligned-fit",
      dimensionsMillimetres,
      buildVolumeDimensionsMillimetres: buildDimensions,
      fitsAsGiven,
      orientations,
      fitsInAnyOrientation,
    },
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Scale plausibility
// ---------------------------------------------------------------------------

/** Below this largest-dimension value (in the canonical millimetre frame), the model is observed as implausibly small for common desktop 3D printers. An observation, never a unit correction -- see `ScaleObservation`'s doc comment. */
export const MIN_PLAUSIBLE_MODEL_DIMENSION_MILLIMETRES = 1;
/** Above this largest-dimension value, the model is observed as implausibly large for common desktop 3D printers' build volumes. */
export const MAX_PLAUSIBLE_MODEL_DIMENSION_MILLIMETRES = 1_000;

export interface ScaleObservation {
  readonly dimensionsMillimetres: Vec3;
  /** Echoed from `model.provenance.sourceUnit` -- the unit this package's importer resolved the model to, never guessed or re-derived here. */
  readonly sourceUnit: NormalizedModel["provenance"]["sourceUnit"];
  /** Echoed from `model.provenance.detectedSourceUnit`. */
  readonly detectedSourceUnit: NormalizedModel["provenance"]["detectedSourceUnit"];
  readonly implausible: boolean;
  readonly implausibleReason?:
    "smaller-than-typical-print-scale" | "larger-than-typical-build-volume";
}

function computeScale(
  model: NormalizedModel,
  dimensionsMillimetres: Vec3,
): CheckOutcome<ScaleObservation> {
  const largest = Math.max(...dimensionsMillimetres);
  let implausibleReason: ScaleObservation["implausibleReason"];
  if (largest < MIN_PLAUSIBLE_MODEL_DIMENSION_MILLIMETRES) {
    implausibleReason = "smaller-than-typical-print-scale";
  } else if (largest > MAX_PLAUSIBLE_MODEL_DIMENSION_MILLIMETRES) {
    implausibleReason = "larger-than-typical-build-volume";
  }

  const warnings: PrintabilityWarning[] = [];
  if (implausibleReason !== undefined) {
    warnings.push({
      code: "printability.implausible-scale",
      severity: "info",
      message: `The model's largest dimension is ${largest}mm at the resolved unit (source unit "${model.provenance.sourceUnit}", detected "${model.provenance.detectedSourceUnit}"), outside the ${MIN_PLAUSIBLE_MODEL_DIMENSION_MILLIMETRES}-${MAX_PLAUSIBLE_MODEL_DIMENSION_MILLIMETRES}mm range typical of common desktop printers. This is an observation, not a unit correction -- this package never guesses or changes units.`,
      details: { largestDimensionMillimetres: largest },
    });
  }

  return {
    check: {
      dimensionsMillimetres,
      sourceUnit: model.provenance.sourceUnit,
      detectedSourceUnit: model.provenance.detectedSourceUnit,
      implausible: implausibleReason !== undefined,
      ...(implausibleReason === undefined ? {} : { implausibleReason }),
    },
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Aggregate result and entry point
// ---------------------------------------------------------------------------

export interface PrintabilityWarning {
  readonly code: string;
  readonly severity: "info" | "warning";
  readonly message: string;
  readonly details?: Readonly<Record<string, number>>;
}

export interface AssessPrintabilityOptions {
  /** Defaults to identity. Validated as a proper rigid transform (no scale, shear, or reflection), matching `MeasureOptions.modelToComparison` and `ClearancePlacement.modelToComparison` -- scaling or shearing placed geometry would distort the very thicknesses, angles, and extents this function reports. */
  readonly modelToComparison?: RigidTransform;
  readonly wallThickness?: WallThicknessOptions;
  readonly overhang?: OverhangOptions;
  readonly islands?: IslandOptions;
  readonly buildVolume?: BuildVolumeOptions;
  readonly executionBudget?: {
    readonly maxWorkUnits?: number;
    readonly maxMemoryBytes?: number;
  };
}

export interface PrintabilityAssessment {
  readonly modelId: NormalizedModel["id"];
  readonly method: { readonly id: string; readonly version: string };
  readonly wallThickness: WallThicknessCheck;
  readonly overhangs: OverhangCheck;
  readonly islands: IslandCheck;
  readonly buildVolume: BuildVolumeCheck;
  readonly scale: ScaleObservation;
  /** The union of every check's own warnings, in check order (wall thickness, overhangs, islands, build volume, scale). */
  readonly warnings: readonly PrintabilityWarning[];
  /** Always `PRINTABILITY_DISCLAIMER`, verbatim. */
  readonly disclaimer: string;
}

/**
 * Builds a bounded, deterministic printability report for one model:
 * evidence and warnings for a human to weigh, never a "will print"/"will
 * not print" verdict -- see `PRINTABILITY_DISCLAIMER`, always echoed on
 * `disclaimer`. Each of the five checks below carries its own `semantics`,
 * its own resolved parameters, and its own bounds/truncation flags; none is
 * aggregated into a single pass/fail outcome, because each measures a
 * different thing with a different kind of precision and a different
 * failure mode a UI must be able to show separately.
 *
 * - **`wallThickness`**: for a bounded, deterministically selected set of
 *   surface triangles, casts a ray from each triangle's centroid inward
 *   along its own inverted (inward-pointing) normal and measures the
 *   distance to the first opposite-surface hit (a genuine
 *   Moller-Trumbore ray cast, accelerated by
 *   `TriangleSpatialIndex.castRayNearest`, `src/spatial-index.ts`).
 *   `semantics: "approximate-directional-probe"` -- this is directional
 *   (only the inverted-normal direction is probed, not the true local
 *   minimal thickness) and sampled (bounded by `maxSampleTriangles`, with
 *   `sampleSpacingUpperBoundMillimetres` bounding, for sampled triangles
 *   only, how far a point on that triangle can be from its own probed
 *   centroid -- see `WallThicknessCheck`'s doc comment for the full
 *   statement, including what it does not cover).
 * - **`overhangs`**: for every triangle, the exact angle between its own
 *   outward normal and `buildDirection` (default `+Z`), reported as degrees
 *   from vertical (`0` = wall, `90` = flat ceiling). Triangles whose angle
 *   exceeds `thresholdDegreesFromVertical` (default 45) are grouped into
 *   regions with the shared exact-coordinate connectivity
 *   (`groupTrianglesByExactEdgeConnectivity`, `src/region-connectivity.ts`)
 *   `surface-distance` and `checkClearance` already use.
 *   `semantics: "exact-for-tessellated-surface"` -- unlike `wallThickness`,
 *   nothing here is sampled; every triangle is classified.
 * - **`islands`**: connected-component count and per-component evidence
 *   (triangle count, bounds, and volume where the component is itself
 *   closed and consistently oriented), reusing the same exact-coordinate
 *   edge connectivity the other checks and `summarizeModelGeometry`'s own
 *   `componentCount` already use -- never a second connectivity
 *   implementation. `semantics: "exact-connectivity"`.
 * - **`buildVolume`**: when `options.buildVolume.dimensionsMillimetres` is
 *   supplied, whether the model's own axis-aligned extents fit, in which of
 *   the six axis-order permutations (never an arbitrary rotation search),
 *   and by how much each falls short when it does not.
 *   `semantics: "not-configured"` when no build volume was supplied, else
 *   `"exact-axis-aligned-fit"`.
 * - **`scale`**: the model's own dimensions in the canonical millimetre
 *   frame alongside its import-resolved `sourceUnit`/`detectedSourceUnit`
 *   (never re-derived or guessed here), with an `implausible` observation
 *   when the largest dimension falls outside a typical desktop-printer
 *   range -- explicitly an observation, never a unit correction; this
 *   package never silently reinterprets units.
 *
 * **Resource discipline.** `model` is validated against
 * `normalizedModelSchema` first, then expanded vertex/triangle counts (plus
 * estimated memory, honoring an optional caller-supplied
 * `executionBudget.maxMemoryBytes`) are checked via
 * `checkExpandedGeometryBudget` -- the same pre-flight `checkClearance`,
 * `estimateAlignment`, and `measureOnModel` use -- throwing
 * `PrintabilityResourceLimitError` before any O(vertices + triangles) work
 * runs. Flattening, spatial-index construction, wall-thickness ray casts,
 * overhang classification, and island connectivity are all charged to one
 * charge-before-work `WorkBudget` (bounded by
 * `executionBudget.maxWorkUnits`, reusing `ANALYSIS_LIMITS`/`WorkBudget`
 * from `src/analyze.ts` unchanged); an exhausted budget throws
 * `WorkBudgetExceeded` unchanged, matching every other entry point in this
 * package. `options.modelToComparison` is validated as a proper rigid
 * transform. Invalid option values (an out-of-range bound, a degenerate
 * `overhang.buildDirection`, a non-positive `buildVolume.dimensionsMillimetres`)
 * throw `RangeError`/`PrintabilityInputError` respectively, matching this
 * package's other entry points' conventions.
 *
 * **Determinism.** Identical input produces a deeply equal
 * `PrintabilityAssessment` every time: sample-triangle selection is a fixed
 * stride walk over triangle order, `TriangleSpatialIndex` traversal
 * (`nearestTriangle`'s underlying tree, reused for `castRayNearest`) is
 * deterministic, region/component grouping and ranking use full
 * deterministic tie-breaking, and no step here introduces randomness.
 */
export function assessPrintability(
  model: NormalizedModel,
  options: AssessPrintabilityOptions = {},
): PrintabilityAssessment {
  const validated = normalizedModelSchema.parse(model);
  const modelToComparison =
    options.modelToComparison === undefined
      ? IDENTITY_RIGID
      : rigidTransformSchema.parse(options.modelToComparison);

  const counts = countExpandedGeometry(validated);
  const budgetProblem = checkExpandedGeometryBudget(
    counts.vertices,
    counts.triangles,
    options.executionBudget,
  );
  if (budgetProblem !== undefined) {
    throw new PrintabilityResourceLimitError(budgetProblem);
  }

  const workLimit = Math.min(
    ANALYSIS_LIMITS.maxWorkUnits,
    options.executionBudget?.maxWorkUnits ?? ANALYSIS_LIMITS.maxWorkUnits,
  );
  const work = new WorkBudget(workLimit);

  let geometry: FlatGeometry;
  try {
    geometry = flattenModel(validated, modelToComparison, work);
  } catch (error) {
    if (
      error instanceof WorkBudgetExceeded ||
      error instanceof WorkBudgetInternalError
    ) {
      throw error;
    }
    throw new PrintabilityInputError(
      error instanceof Error ? error.message : "Comparison transform failed.",
    );
  }
  if (geometry.triangleCount === 0) {
    throw new PrintabilityInputError(
      "assessPrintability requires at least one triangle after flattening.",
    );
  }

  const index = new TriangleSpatialIndex(geometry, work);
  const dimensionsMillimetres = boundsOfGeometry(geometry, work);

  const wallThicknessResult = computeWallThickness(
    geometry,
    index,
    work,
    options.wallThickness,
  );
  const overhangResult = computeOverhangs(geometry, work, options.overhang);
  const islandResult = computeIslands(geometry, work, options.islands);
  const buildVolumeResult = computeBuildVolume(
    dimensionsMillimetres,
    options.buildVolume,
  );
  const scaleResult = computeScale(validated, dimensionsMillimetres);

  const warnings: PrintabilityWarning[] = [
    ...wallThicknessResult.warnings,
    ...overhangResult.warnings,
    ...islandResult.warnings,
    ...buildVolumeResult.warnings,
    ...scaleResult.warnings,
  ];

  return {
    modelId: validated.id,
    method: {
      id: PRINTABILITY_METHOD_ID,
      version: PRINTABILITY_METHOD_VERSION,
    },
    wallThickness: wallThicknessResult.check,
    overhangs: overhangResult.check,
    islands: islandResult.check,
    buildVolume: buildVolumeResult.check,
    scale: scaleResult.check,
    warnings,
    disclaimer: PRINTABILITY_DISCLAIMER,
  };
}

const BOUNDS_VERTEX_WORK_UNITS = 1;

/** Overall dimensions from the flattened comparison-frame geometry's own vertex positions -- a fresh, cheap O(vertices) min/max pass rather than a second bounds implementation borrowed from `src/summary.ts`, which walks the model's own mesh/placement graph instead of `FlatGeometry`. */
function boundsOfGeometry(geometry: FlatGeometry, work: WorkUnitCounter): Vec3 {
  const positions = geometry.positions;
  const vertexCount = geometry.vertexCount;
  work.charge(vertexCount * BOUNDS_VERTEX_WORK_UNITS);
  let minX = positions[0]!;
  let minY = positions[1]!;
  let minZ = positions[2]!;
  let maxX = minX;
  let maxY = minY;
  let maxZ = minZ;
  for (let vertex = 1; vertex < vertexCount; vertex += 1) {
    const base = vertex * 3;
    const x = positions[base]!;
    const y = positions[base + 1]!;
    const z = positions[base + 2]!;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  return [
    normalizeZero(maxX - minX),
    normalizeZero(maxY - minY),
    normalizeZero(maxZ - minZ),
  ];
}

function resolveFiniteRangeBound(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new RangeError(
      `${name} must be a finite number between ${minimum} and ${maximum}; received ${String(value)}.`,
    );
  }
  return value;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
