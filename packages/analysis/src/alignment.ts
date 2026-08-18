import {
  IDENTITY_MAT4,
  normalizedModelSchema,
  rigidTransformSchema,
} from "@voxelspy/contracts";
import type {
  Mat4,
  NormalizedModel,
  RigidTransform,
  Vec3,
} from "@voxelspy/contracts";

import {
  ANALYSIS_LIMITS,
  WorkBudget,
  WorkBudgetExceeded,
  WorkBudgetInternalError,
  checkExpandedGeometryBudget,
} from "./analyze.js";
import {
  closestPointOnTriangle,
  countExpandedGeometry,
  flattenModel,
  multiply,
} from "./geometry.js";
import type { FlatGeometry, WorkUnitCounter } from "./geometry.js";
import { resolveBound } from "./inspect.js";
import { TriangleSpatialIndex } from "./spatial-index.js";

/**
 * A validated, deliberately supplied `RigidTransform` computed by
 * `estimateAlignment` is never applied to any model or comparison by this
 * package. It is returned to the caller as data -- the same
 * `rigidTransformSchema` shape `ClearancePlacement.modelToComparison` and
 * `AnalysisRequest`'s model bindings already use -- so a caller who reviews
 * and accepts it can feed it straight back as that part's placement. This
 * module never mutates a `NormalizedModel`, never runs a comparison, and
 * never chooses on the caller's behalf whether an estimated alignment should
 * be used; see the "Deliberate alignment" section of ../README.md.
 */

/** Thrown for correspondence-point input that cannot determine a unique rigid transform: too few points, too many, duplicated points, or a collinear/coincident point set. A caller programming error, not a data-driven runtime outcome -- see `checkClearance`'s and `inspectModel`'s existing typed-error conventions for the same distinction. */
export class AlignmentInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AlignmentInputError";
  }
}

/** Thrown when expanded geometry for `iterative-closest-point` exceeds this package's existing `ANALYSIS_LIMITS` ceilings, mirroring `InspectionResourceLimitError` in `src/inspect.ts`. Thrown before any O(vertices + triangles) work runs. */
export class AlignmentResourceLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AlignmentResourceLimitError";
  }
}

/** Thrown when `iterative-closest-point`'s input geometry cannot be used to iterate: empty geometry after flattening, or a comparison transform that produced non-finite coordinates. */
export class AlignmentGeometryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AlignmentGeometryError";
  }
}

const IDENTITY_RIGID: RigidTransform =
  rigidTransformSchema.parse(IDENTITY_MAT4);

/** One correspondence: a point on the moving part's surface (in the moving model's own, unplaced frame) matched deliberately by the caller to its intended counterpart on the fixed part's surface (in the comparison frame -- the frame the fixed part is trustedly already placed in). Never inferred automatically. */
export interface CorrespondencePoint {
  readonly moving: Vec3;
  readonly fixed: Vec3;
}

export interface CorrespondencePointsInput {
  readonly method: "correspondence-points";
  /** At least `MIN_CORRESPONDENCES` (3), at most `MAX_CORRESPONDENCES`. Must not be collinear or contain duplicate moving or fixed points -- see `AlignmentInputError`. */
  readonly correspondences: readonly CorrespondencePoint[];
}

/** The fixed/reference part's own trusted placement into the comparison frame, exactly like `ClearancePlacement` in `src/clearance.ts`. `iterative-closest-point` never adjusts this placement -- only the moving part's placement is refined. */
export interface AlignmentTargetPlacement {
  readonly model: NormalizedModel;
  readonly modelToComparison: RigidTransform;
}

export interface IterativeClosestPointInput {
  readonly method: "iterative-closest-point";
  /** The part being aligned, in its own local/model frame -- not yet placed into the comparison frame. */
  readonly moving: NormalizedModel;
  /** The reference part, already placed at a trusted position. Never adjusted. */
  readonly fixed: AlignmentTargetPlacement;
  /** Starting guess for the moving part's placement into the comparison frame, refined by iteration. Defaults to identity (no assumed placement) -- callers commonly supply a `correspondence-points` result here to seed a coarse-to-fine alignment. */
  readonly initialTransform?: RigidTransform;
}

export type EstimateAlignmentInput =
  CorrespondencePointsInput | IterativeClosestPointInput;

export interface EstimateAlignmentOptions {
  /** `iterative-closest-point` only. Bounded by `MAX_ICP_ITERATIONS`. Defaults to `DEFAULT_MAX_ICP_ITERATIONS`. Ignored by `correspondence-points`, which is a single closed-form solve. */
  readonly maxIterations?: number;
  /** `iterative-closest-point` only. Millimetres. Bounded by `MAX_ICP_CONVERGENCE_TOLERANCE_MILLIMETRES`. Defaults to `DEFAULT_ICP_CONVERGENCE_TOLERANCE_MILLIMETRES`. */
  readonly convergenceToleranceMillimetres?: number;
  readonly executionBudget?: {
    readonly maxWorkUnits?: number;
    readonly maxMemoryBytes?: number;
  };
}

export interface AlignmentResidualStats {
  readonly rmsMillimetres: number;
  readonly maxMillimetres: number;
}

export interface AlignmentWarning {
  readonly code: string;
  readonly severity: "warning";
  readonly message: string;
  readonly details?: Readonly<Record<string, number>>;
}

/**
 * Evidence for the returned `transform`, sufficient for a UI to decide
 * whether to offer it to the caller rather than silently trust it.
 *
 * `correspondence-points` is a single closed-form solve, not an iterative
 * process: `iterations` is `0` and `converged` is always `true` for it
 * (there is no convergence loop to fail). `iterative-closest-point` reports
 * the true number of refinement iterations performed and whether the
 * per-sample displacement fell below the convergence tolerance before the
 * iteration ceiling was reached -- `converged: false` is reported honestly,
 * never hidden behind a still-returned transform.
 *
 * `impliedScale` is present only for `correspondence-points`: the
 * least-squares uniform scale factor the correspondence points imply between
 * the moving and fixed point sets, computed independently of the rotation
 * fit and reported as evidence only -- `transform` never applies it, because
 * scaling geometry would change measurements. See the "Deliberate alignment"
 * section of ../README.md.
 *
 * `poorFit` is set whenever `residualsAfterMillimetres.rmsMillimetres` is
 * large relative to the aligned geometry's own scale (see
 * `POOR_FIT_RESIDUAL_RATIO`) -- a converged, low-iteration-count result can
 * still be a poor fit when the two parts are not actually the same shape;
 * `poorFitReason` names the exact numbers and threshold used so a UI can
 * warn instead of implying a confirmed match.
 */
export interface AlignmentEvidence {
  readonly method: EstimateAlignmentInput["method"];
  readonly parameters: Readonly<Record<string, number>>;
  readonly correspondenceCount: number;
  readonly iterations: number;
  readonly converged: boolean;
  readonly residualsBeforeMillimetres: AlignmentResidualStats;
  readonly residualsAfterMillimetres: AlignmentResidualStats;
  readonly impliedScale?: number;
  readonly poorFit: boolean;
  readonly poorFitReason?: string;
}

export interface AlignmentEstimate {
  /** Never applied by this function. The caller decides whether to use it, and any comparison computed with it must record it -- see the "Deliberate alignment" section of ../README.md. */
  readonly transform: RigidTransform;
  readonly evidence: AlignmentEvidence;
  readonly warnings: readonly AlignmentWarning[];
}

export const MIN_CORRESPONDENCES = 3;
/** Implementation ceiling on `CorrespondencePointsInput.correspondences`. Far above any plausible manually-supplied point set; guards against an unbounded input list. */
export const MAX_CORRESPONDENCES = 1_024;

export const DEFAULT_MAX_ICP_ITERATIONS = 50;
export const MAX_ICP_ITERATIONS = 500;

export const DEFAULT_ICP_CONVERGENCE_TOLERANCE_MILLIMETRES = 1e-4;
export const MAX_ICP_CONVERGENCE_TOLERANCE_MILLIMETRES = 1_000;

/**
 * Relative threshold this package uses to flag a converged (or
 * ceiling-hit) alignment whose residuals are nonetheless large relative to
 * the aligned geometry's own scale -- evidence the two shapes may not
 * actually match, not just numeric noise. This is a disclosed heuristic, not
 * an exact geometric guarantee: see `evaluatePoorFit` below and the
 * "Deliberate alignment" section of ../README.md.
 */
export const POOR_FIT_RESIDUAL_RATIO = 0.02;

/** Relative threshold above which `correspondence-points`' implied scale is reported as an explicit `alignment.implied-scale-mismatch` warning. */
const SCALE_MISMATCH_WARNING_RATIO = 0.01;

/** Relative threshold (of the largest eigenvalue) below which a correspondence point set's spread along an axis is treated as zero for the purposes of the collinearity/coincidence check. */
const COLLINEARITY_RELATIVE_THRESHOLD = 1e-9;

/** Bounded, fixed sweep count for this module's self-contained Jacobi eigenvalue solver (see `jacobiEigenSymmetric`) -- deliberately generous for the tiny (3x3/4x4) symmetric matrices this module ever diagonalizes, which converge to double precision within roughly ten sweeps; the ceiling itself, not observed convergence, is what bounds the loop. */
const JACOBI_MAX_SWEEPS = 100;
const JACOBI_CONVERGENCE_EPSILON = 1e-30;

/** Guards the poor-fit ratio's denominator against division by a near-zero reference scale (a degenerate or vanishingly small aligned geometry). */
const MIN_POOR_FIT_SCALE_REFERENCE_MILLIMETRES = 1e-6;

/** Charged per triangle in `buildDeterministicSamples` for reading three vertex coordinates and computing a centroid -- comparable to `DIRECTIONAL_TRIANGLE_WORK_UNITS` in `src/analyze.ts` for a similar per-triangle read-and-derive pass. */
const ICP_SAMPLE_BUILD_TRIANGLE_WORK_UNITS = 4;
/** Charged per sample per iteration before each `TriangleSpatialIndex.nearestTriangle` query, on top of that query's own internal per-BVH-node charges -- covers transforming the sample point and computing its matched closest point. */
const ICP_SAMPLE_QUERY_WORK_UNITS = 4;
/** Charged per sample per iteration for the convergence displacement check (a fixed-cost point transform and comparison, no spatial query). */
const ICP_DISPLACEMENT_WORK_UNITS = 1;

/**
 * Estimates -- never applies -- a rigid transform aligning a "moving" part
 * onto a "fixed" part, by one of two explicit, caller-selected methods.
 *
 * **This function never mutates a model, never recenters or rescales
 * geometry, and never runs a comparison.** It returns a computed
 * `RigidTransform` plus evidence a caller (or a UI) can use to decide
 * whether to accept it; VoxelSpy's "never silently recenter, rescale, align,
 * repair, or reinterpret geometry" rule means the caller must explicitly
 * choose to feed the returned transform into a placement (for example
 * `ClearancePlacement.modelToComparison` or an `AnalysisRequest` model
 * binding), and any comparison computed using an estimated alignment should
 * record that transform in its own provenance rather than silently absorb
 * it. See the "Deliberate alignment" section of ../README.md.
 *
 * **`correspondence-points`**: a single closed-form least-squares rigid fit
 * (rotation plus translation, no scale) from at least three caller-supplied
 * point pairs, via a self-contained quaternion/eigenvector method (Horn,
 * 1987) -- see `RigidFitAccumulator.fit` below for the derivation. Rejects
 * fewer than three points, more than `MAX_CORRESPONDENCES`, duplicate
 * moving or fixed points, and a collinear or coincident point set, all with
 * `AlignmentInputError`.
 *
 * **`iterative-closest-point`**: refines an initial transform (identity by
 * default, or a caller-supplied seed such as a `correspondence-points`
 * result) by repeated closest-point matching against the fixed part's
 * spatial index, bounded by `maxIterations` and a convergence displacement
 * tolerance, both options with documented ceilings. Deterministic: sample
 * points are the moving part's own triangle vertices and centroids, in
 * triangle order -- the same deterministic sampling this package's other
 * methods use (`surface-distance`, `checkClearance`) -- never a random
 * subset.
 *
 * **Resource discipline.** Reuses `ANALYSIS_LIMITS` and the same
 * charge-before-work `WorkBudget` this package uses throughout;
 * `iterative-closest-point` fails closed with `AlignmentResourceLimitError`
 * before any O(vertices + triangles) work runs when expanded geometry
 * exceeds the package's ceilings, and with `WorkBudgetExceeded` (reused
 * unchanged from `src/analyze.ts`, not redefined) if the active budget runs
 * out mid-computation.
 */
export function estimateAlignment(
  input: EstimateAlignmentInput,
  options: EstimateAlignmentOptions = {},
): AlignmentEstimate {
  if (input.method === "correspondence-points") {
    return estimateCorrespondencePoints(input);
  }
  return estimateIterativeClosestPoint(input, options);
}

// ---------------------------------------------------------------------------
// correspondence-points
// ---------------------------------------------------------------------------

function estimateCorrespondencePoints(
  input: CorrespondencePointsInput,
): AlignmentEstimate {
  const correspondences = input.correspondences;
  validateCorrespondenceList(correspondences);

  const accumulator = new RigidFitAccumulator();
  for (const pair of correspondences) {
    accumulator.add(
      pair.moving[0],
      pair.moving[1],
      pair.moving[2],
      pair.fixed[0],
      pair.fixed[1],
      pair.fixed[2],
    );
  }
  const residualsBeforeMillimetres = accumulator.residualStats();
  const { transform: rawTransform, impliedScale } = accumulator.fit();
  const transform = rigidTransformSchema.parse(reorthonormalize(rawTransform));

  let afterSquaredSum = 0;
  let afterMax = 0;
  for (const pair of correspondences) {
    const moved = applyRigid(transform, pair.moving);
    const dx = moved[0] - pair.fixed[0];
    const dy = moved[1] - pair.fixed[1];
    const dz = moved[2] - pair.fixed[2];
    const squared = dx * dx + dy * dy + dz * dz;
    afterSquaredSum += squared;
    const distance = Math.sqrt(squared);
    if (distance > afterMax) afterMax = distance;
  }
  const residualsAfterMillimetres: AlignmentResidualStats = {
    rmsMillimetres: Math.sqrt(afterSquaredSum / correspondences.length),
    maxMillimetres: afterMax,
  };

  const scaleReference = boundingDiagonal(
    correspondences.map((pair) => pair.fixed),
  );
  const { poorFit, poorFitReason } = evaluatePoorFit(
    residualsAfterMillimetres,
    scaleReference,
  );

  const warnings: AlignmentWarning[] = [];
  if (poorFit) {
    warnings.push(
      poorFitWarning(poorFitReason!, residualsAfterMillimetres, scaleReference),
    );
  }
  if (Math.abs(impliedScale - 1) > SCALE_MISMATCH_WARNING_RATIO) {
    warnings.push({
      code: "alignment.implied-scale-mismatch",
      severity: "warning",
      message: `The correspondence points imply a uniform scale factor of ${impliedScale.toFixed(6)}x between the moving and fixed points; the returned transform is rigid (no scale applied), because scaling geometry would change measurements. Review whether the two parts are expressed in the same real-world units before using this alignment.`,
      details: { impliedScale },
    });
  }

  return {
    transform,
    evidence: {
      method: "correspondence-points",
      parameters: {},
      correspondenceCount: correspondences.length,
      iterations: 0,
      converged: true,
      residualsBeforeMillimetres,
      residualsAfterMillimetres,
      impliedScale,
      poorFit,
      ...(poorFitReason === undefined ? {} : { poorFitReason }),
    },
    warnings,
  };
}

function validateCorrespondenceList(
  correspondences: readonly CorrespondencePoint[],
): void {
  if (correspondences.length < MIN_CORRESPONDENCES) {
    throw new AlignmentInputError(
      `correspondence-points requires at least ${MIN_CORRESPONDENCES} point pairs to determine a unique rigid transform; received ${correspondences.length}.`,
    );
  }
  if (correspondences.length > MAX_CORRESPONDENCES) {
    throw new AlignmentInputError(
      `correspondence-points accepts at most ${MAX_CORRESPONDENCES} point pairs; received ${correspondences.length}.`,
    );
  }
  const movingKeys = new Set<string>();
  const fixedKeys = new Set<string>();
  correspondences.forEach((pair, index) => {
    if (
      !pair.moving.every((value) => Number.isFinite(value)) ||
      !pair.fixed.every((value) => Number.isFinite(value))
    ) {
      throw new AlignmentInputError(
        `Correspondence at index ${index} must have finite moving and fixed coordinates.`,
      );
    }
    const movingKey = pointKey(pair.moving);
    const fixedKey = pointKey(pair.fixed);
    if (movingKeys.has(movingKey)) {
      throw new AlignmentInputError(
        `Duplicate moving point in correspondences at index ${index}: correspondence-points requires distinct moving points.`,
      );
    }
    if (fixedKeys.has(fixedKey)) {
      throw new AlignmentInputError(
        `Duplicate fixed point in correspondences at index ${index}: correspondence-points requires distinct fixed points.`,
      );
    }
    movingKeys.add(movingKey);
    fixedKeys.add(fixedKey);
  });
  checkNonCollinear(
    correspondences.map((pair) => pair.moving),
    "moving",
  );
  checkNonCollinear(
    correspondences.map((pair) => pair.fixed),
    "fixed",
  );
}

function pointKey(point: Vec3): string {
  return `${point[0]},${point[1]},${point[2]}`;
}

/**
 * Rejects a correspondence-side point set whose spread spans fewer than two
 * dimensions (all points coincident, or all collinear), which leaves at
 * least one rotational degree of freedom undetermined by the correspondence
 * fit. Rank is assessed from the eigenvalues of the point set's own centered
 * covariance matrix (via `jacobiEigenSymmetric`), relative to its largest
 * eigenvalue -- scale-independent, so this rejects true collinearity
 * regardless of the coordinate magnitudes involved.
 */
function checkNonCollinear(points: readonly Vec3[], label: string): void {
  const n = points.length;
  const centroid: Vec3 = [
    points.reduce((sum, point) => sum + point[0], 0) / n,
    points.reduce((sum, point) => sum + point[1], 0) / n,
    points.reduce((sum, point) => sum + point[2], 0) / n,
  ];
  let c00 = 0;
  let c01 = 0;
  let c02 = 0;
  let c11 = 0;
  let c12 = 0;
  let c22 = 0;
  for (const point of points) {
    const dx = point[0] - centroid[0];
    const dy = point[1] - centroid[1];
    const dz = point[2] - centroid[2];
    c00 += dx * dx;
    c01 += dx * dy;
    c02 += dx * dz;
    c11 += dy * dy;
    c12 += dy * dz;
    c22 += dz * dz;
  }
  const covariance: number[][] = [
    [c00, c01, c02],
    [c01, c11, c12],
    [c02, c12, c22],
  ];
  const { values } = jacobiEigenSymmetric(covariance, 3, JACOBI_MAX_SWEEPS);
  const sorted = [...values].sort((left, right) => right - left);
  const largest = sorted[0]!;
  if (!(largest > 0)) {
    throw new AlignmentInputError(
      `All supplied ${label} correspondence points are coincident: at least three non-collinear points are required.`,
    );
  }
  const rankThreshold = largest * COLLINEARITY_RELATIVE_THRESHOLD;
  const rank = sorted.filter((value) => value > rankThreshold).length;
  if (rank < 2) {
    throw new AlignmentInputError(
      `The supplied ${label} correspondence points are collinear: at least three non-collinear points are required to determine a unique rotation.`,
    );
  }
}

// ---------------------------------------------------------------------------
// iterative-closest-point
// ---------------------------------------------------------------------------

function resolveToleranceBound(
  value: number | undefined,
  fallback: number,
  ceiling: number,
  name: string,
): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 0 || value > ceiling) {
    throw new RangeError(
      `${name} must be a finite number between 0 and ${ceiling}; received ${String(value)}.`,
    );
  }
  return value;
}

function estimateIterativeClosestPoint(
  input: IterativeClosestPointInput,
  options: EstimateAlignmentOptions,
): AlignmentEstimate {
  const movingModel = normalizedModelSchema.parse(input.moving);
  const fixedModel = normalizedModelSchema.parse(input.fixed.model);
  const fixedTransform = rigidTransformSchema.parse(
    input.fixed.modelToComparison,
  );
  const initialTransform: Mat4 =
    input.initialTransform === undefined
      ? IDENTITY_RIGID
      : rigidTransformSchema.parse(input.initialTransform);

  const maxIterations = resolveBound(
    options.maxIterations,
    DEFAULT_MAX_ICP_ITERATIONS,
    MAX_ICP_ITERATIONS,
    "maxIterations",
  );
  const convergenceTolerance = resolveToleranceBound(
    options.convergenceToleranceMillimetres,
    DEFAULT_ICP_CONVERGENCE_TOLERANCE_MILLIMETRES,
    MAX_ICP_CONVERGENCE_TOLERANCE_MILLIMETRES,
    "convergenceToleranceMillimetres",
  );

  const movingCounts = countExpandedGeometry(movingModel);
  const fixedCounts = countExpandedGeometry(fixedModel);
  const budgetProblem = checkExpandedGeometryBudget(
    movingCounts.vertices + fixedCounts.vertices,
    movingCounts.triangles + fixedCounts.triangles,
    options.executionBudget,
  );
  if (budgetProblem !== undefined) {
    throw new AlignmentResourceLimitError(budgetProblem);
  }

  const workLimit = Math.min(
    ANALYSIS_LIMITS.maxWorkUnits,
    options.executionBudget?.maxWorkUnits ?? ANALYSIS_LIMITS.maxWorkUnits,
  );
  const work = new WorkBudget(workLimit);

  let movingLocalGeometry: FlatGeometry;
  let fixedGeometry: FlatGeometry;
  try {
    movingLocalGeometry = flattenModel(movingModel, IDENTITY_RIGID, work);
    fixedGeometry = flattenModel(fixedModel, fixedTransform, work);
  } catch (error) {
    if (
      error instanceof WorkBudgetExceeded ||
      error instanceof WorkBudgetInternalError
    ) {
      throw error;
    }
    throw new AlignmentGeometryError(
      error instanceof Error ? error.message : "Comparison transform failed.",
    );
  }

  if (
    movingLocalGeometry.triangleCount === 0 ||
    fixedGeometry.triangleCount === 0
  ) {
    throw new AlignmentGeometryError(
      "iterative-closest-point requires both the moving and fixed models to contain at least one triangle after flattening.",
    );
  }

  const samples = buildDeterministicSamples(movingLocalGeometry, work);
  const sampleCount = samples.length / 3;
  const fixedIndex = new TriangleSpatialIndex(fixedGeometry, work);

  let currentTransform: Mat4 = initialTransform;
  let residualsBeforeMillimetres: AlignmentResidualStats | undefined;
  let iterations = 0;
  let converged = false;
  const globalPoints = new Float64Array(sampleCount * 3);

  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    const accumulator = new RigidFitAccumulator();
    for (let sample = 0; sample < sampleCount; sample += 1) {
      const base = sample * 3;
      const lx = samples[base]!;
      const ly = samples[base + 1]!;
      const lz = samples[base + 2]!;
      const global = applyRigid(currentTransform, [lx, ly, lz]);
      globalPoints[base] = global[0];
      globalPoints[base + 1] = global[1];
      globalPoints[base + 2] = global[2];

      work.charge(ICP_SAMPLE_QUERY_WORK_UNITS);
      const nearest = fixedIndex.nearestTriangle(
        global[0],
        global[1],
        global[2],
        work,
      );
      const targetBase = nearest.triangleIndex * 3;
      const ja = fixedGeometry.indices[targetBase]!;
      const jb = fixedGeometry.indices[targetBase + 1]!;
      const jc = fixedGeometry.indices[targetBase + 2]!;
      const target = closestPointOnTriangle(
        global[0],
        global[1],
        global[2],
        fixedGeometry.positions,
        ja,
        jb,
        jc,
      );
      accumulator.add(
        global[0],
        global[1],
        global[2],
        target[0],
        target[1],
        target[2],
      );
    }

    if (residualsBeforeMillimetres === undefined) {
      residualsBeforeMillimetres = accumulator.residualStats();
    }

    const { transform: delta } = accumulator.fit();
    currentTransform = multiply(delta, currentTransform);
    iterations = iteration + 1;

    let maxDisplacementSquared = 0;
    for (let sample = 0; sample < sampleCount; sample += 1) {
      work.charge(ICP_DISPLACEMENT_WORK_UNITS);
      const base = sample * 3;
      const gx = globalPoints[base]!;
      const gy = globalPoints[base + 1]!;
      const gz = globalPoints[base + 2]!;
      const moved = applyRigid(delta, [gx, gy, gz]);
      const dx = moved[0] - gx;
      const dy = moved[1] - gy;
      const dz = moved[2] - gz;
      const squared = dx * dx + dy * dy + dz * dz;
      if (squared > maxDisplacementSquared) maxDisplacementSquared = squared;
    }
    if (Math.sqrt(maxDisplacementSquared) <= convergenceTolerance) {
      converged = true;
      break;
    }
  }

  const finalAccumulator = new RigidFitAccumulator();
  for (let sample = 0; sample < sampleCount; sample += 1) {
    const base = sample * 3;
    const lx = samples[base]!;
    const ly = samples[base + 1]!;
    const lz = samples[base + 2]!;
    const global = applyRigid(currentTransform, [lx, ly, lz]);
    work.charge(ICP_SAMPLE_QUERY_WORK_UNITS);
    const nearest = fixedIndex.nearestTriangle(
      global[0],
      global[1],
      global[2],
      work,
    );
    const targetBase = nearest.triangleIndex * 3;
    const ja = fixedGeometry.indices[targetBase]!;
    const jb = fixedGeometry.indices[targetBase + 1]!;
    const jc = fixedGeometry.indices[targetBase + 2]!;
    const target = closestPointOnTriangle(
      global[0],
      global[1],
      global[2],
      fixedGeometry.positions,
      ja,
      jb,
      jc,
    );
    finalAccumulator.add(
      global[0],
      global[1],
      global[2],
      target[0],
      target[1],
      target[2],
    );
  }
  const residualsAfterMillimetres = finalAccumulator.residualStats();

  const transform = rigidTransformSchema.parse(
    reorthonormalize(currentTransform),
  );
  const scaleReference = boundingDiagonalOfPositions(
    fixedGeometry.positions,
    fixedGeometry.vertexCount,
  );
  const { poorFit, poorFitReason } = evaluatePoorFit(
    residualsAfterMillimetres,
    scaleReference,
  );

  const warnings: AlignmentWarning[] = [];
  if (!converged) {
    warnings.push({
      code: "alignment.not-converged",
      severity: "warning",
      message: `iterative-closest-point reached its iteration ceiling (${maxIterations}) without the per-sample displacement falling below the convergence tolerance (${convergenceTolerance} mm); the returned transform is the best estimate reached, not a confirmed converged fit.`,
      details: {
        maxIterations,
        convergenceToleranceMillimetres: convergenceTolerance,
        iterations,
      },
    });
  }
  if (poorFit) {
    warnings.push(
      poorFitWarning(poorFitReason!, residualsAfterMillimetres, scaleReference),
    );
  }

  return {
    transform,
    evidence: {
      method: "iterative-closest-point",
      parameters: {
        maxIterations,
        convergenceToleranceMillimetres: convergenceTolerance,
      },
      correspondenceCount: sampleCount,
      iterations,
      converged,
      residualsBeforeMillimetres:
        residualsBeforeMillimetres ?? residualsAfterMillimetres,
      residualsAfterMillimetres,
      poorFit,
      ...(poorFitReason === undefined ? {} : { poorFitReason }),
    },
    warnings,
  };
}

/**
 * Deterministic sample points for `iterative-closest-point`: each triangle's
 * three vertices plus its centroid, in triangle order -- the same
 * "vertices-and-triangle-centroids" sampling `surface-distance` and
 * `checkClearance` already use, reused here rather than a third sampling
 * scheme. Stored as a flat `Float64Array` (not per-sample `Vec3` objects),
 * matching this package's typed-array discipline for O(triangles)-scale
 * data.
 */
function buildDeterministicSamples(
  geometry: FlatGeometry,
  work: WorkUnitCounter,
): Float64Array {
  const triangleCount = geometry.triangleCount;
  work.charge(triangleCount * ICP_SAMPLE_BUILD_TRIANGLE_WORK_UNITS);
  const samples = new Float64Array(triangleCount * 4 * 3);
  const positions = geometry.positions;
  const indices = geometry.indices;
  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    const base = triangle * 3;
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
    const out = triangle * 12;
    samples[out] = ax;
    samples[out + 1] = ay;
    samples[out + 2] = az;
    samples[out + 3] = bx;
    samples[out + 4] = by;
    samples[out + 5] = bz;
    samples[out + 6] = cx;
    samples[out + 7] = cy;
    samples[out + 8] = cz;
    samples[out + 9] = (ax + bx + cx) / 3;
    samples[out + 10] = (ay + by + cy) / 3;
    samples[out + 11] = (az + bz + cz) / 3;
  }
  return samples;
}

// ---------------------------------------------------------------------------
// Shared rigid-fit math
// ---------------------------------------------------------------------------

/**
 * Accumulates a streaming least-squares rigid (rotation + translation, no
 * scale) fit from moving/fixed point pairs, without retaining the pairs
 * themselves: only nine raw pairwise-product sums, six raw coordinate sums,
 * one raw squared-norm sum, a count, and a running residual (pre-fit)
 * sum-of-squares/maximum. This lets both `correspondence-points` (a handful
 * of pairs) and `iterative-closest-point` (up to `4 * triangleCount` sample
 * pairs per iteration) share one implementation without materializing a
 * point array proportional to sample count -- the centered cross-covariance
 * terms Horn's method needs are recovered from the raw sums via the
 * standard identity `sum((p-p̄)(q-q̄)) = sum(p*q) - n*p̄*q̄`.
 *
 * `fit()` implements Horn's closed-form absolute-orientation solution
 * (B.K.P. Horn, "Closed-form solution of absolute orientation using unit
 * quaternions", J. Opt. Soc. Am. A, 1987): build the symmetric 4x4 matrix N
 * from the centered cross-covariance terms, take the unit-quaternion
 * eigenvector of N's largest eigenvalue (found by this module's own bounded
 * Jacobi eigenvalue solver, `jacobiEigenSymmetric` -- no external dependency
 * and no general-purpose SVD needed for a 4x4 matrix), and convert that
 * quaternion to a rotation matrix. This always yields a proper rotation
 * (determinant +1, orthonormal columns) because it is built from a
 * normalized quaternion, never a reflection -- exactly the precondition
 * `rigidTransformSchema` enforces. Translation is then the closed-form
 * `t = fixed_centroid - R * moving_centroid`.
 */
class RigidFitAccumulator {
  #n = 0;
  #sumPx = 0;
  #sumPy = 0;
  #sumPz = 0;
  #sumQx = 0;
  #sumQy = 0;
  #sumQz = 0;
  #sxx = 0;
  #sxy = 0;
  #sxz = 0;
  #syx = 0;
  #syy = 0;
  #syz = 0;
  #szx = 0;
  #szy = 0;
  #szz = 0;
  #sumRawPP = 0;
  #residualSquaredSum = 0;
  #residualMax = 0;

  add(
    px: number,
    py: number,
    pz: number,
    qx: number,
    qy: number,
    qz: number,
  ): void {
    this.#n += 1;
    this.#sumPx += px;
    this.#sumPy += py;
    this.#sumPz += pz;
    this.#sumQx += qx;
    this.#sumQy += qy;
    this.#sumQz += qz;
    this.#sxx += px * qx;
    this.#sxy += px * qy;
    this.#sxz += px * qz;
    this.#syx += py * qx;
    this.#syy += py * qy;
    this.#syz += py * qz;
    this.#szx += pz * qx;
    this.#szy += pz * qy;
    this.#szz += pz * qz;
    this.#sumRawPP += px * px + py * py + pz * pz;
    const dx = px - qx;
    const dy = py - qy;
    const dz = pz - qz;
    const squared = dx * dx + dy * dy + dz * dz;
    this.#residualSquaredSum += squared;
    const distance = Math.sqrt(squared);
    if (distance > this.#residualMax) this.#residualMax = distance;
  }

  residualStats(): AlignmentResidualStats {
    return {
      rmsMillimetres: Math.sqrt(this.#residualSquaredSum / this.#n),
      maxMillimetres: this.#residualMax,
    };
  }

  fit(): { transform: Mat4; impliedScale: number } {
    const n = this.#n;
    const pMeanX = this.#sumPx / n;
    const pMeanY = this.#sumPy / n;
    const pMeanZ = this.#sumPz / n;
    const qMeanX = this.#sumQx / n;
    const qMeanY = this.#sumQy / n;
    const qMeanZ = this.#sumQz / n;

    const sxx = this.#sxx - n * pMeanX * qMeanX;
    const sxy = this.#sxy - n * pMeanX * qMeanY;
    const sxz = this.#sxz - n * pMeanX * qMeanZ;
    const syx = this.#syx - n * pMeanY * qMeanX;
    const syy = this.#syy - n * pMeanY * qMeanY;
    const syz = this.#syz - n * pMeanY * qMeanZ;
    const szx = this.#szx - n * pMeanZ * qMeanX;
    const szy = this.#szy - n * pMeanZ * qMeanY;
    const szz = this.#szz - n * pMeanZ * qMeanZ;
    const centeredPP =
      this.#sumRawPP -
      n * (pMeanX * pMeanX + pMeanY * pMeanY + pMeanZ * pMeanZ);

    const N: number[][] = [
      [sxx + syy + szz, syz - szy, szx - sxz, sxy - syx],
      [syz - szy, sxx - syy - szz, sxy + syx, szx + sxz],
      [szx - sxz, sxy + syx, -sxx + syy - szz, syz + szy],
      [sxy - syx, szx + sxz, syz + szy, -sxx - syy + szz],
    ];
    const { values, vectors } = jacobiEigenSymmetric(N, 4, JACOBI_MAX_SWEEPS);
    let bestIndex = 0;
    for (let index = 1; index < 4; index += 1) {
      if (values[index]! > values[bestIndex]!) bestIndex = index;
    }
    let qw = vectors[0]![bestIndex]!;
    let qx = vectors[1]![bestIndex]!;
    let qy = vectors[2]![bestIndex]!;
    let qz = vectors[3]![bestIndex]!;
    const qLength = Math.hypot(qw, qx, qy, qz) || 1;
    qw /= qLength;
    qx /= qLength;
    qy /= qLength;
    qz /= qLength;

    const r00 = qw * qw + qx * qx - qy * qy - qz * qz;
    const r01 = 2 * (qx * qy - qw * qz);
    const r02 = 2 * (qx * qz + qw * qy);
    const r10 = 2 * (qx * qy + qw * qz);
    const r11 = qw * qw - qx * qx + qy * qy - qz * qz;
    const r12 = 2 * (qy * qz - qw * qx);
    const r20 = 2 * (qx * qz - qw * qy);
    const r21 = 2 * (qy * qz + qw * qx);
    const r22 = qw * qw - qx * qx - qy * qy + qz * qz;

    const tx = qMeanX - (r00 * pMeanX + r01 * pMeanY + r02 * pMeanZ);
    const ty = qMeanY - (r10 * pMeanX + r11 * pMeanY + r12 * pMeanZ);
    const tz = qMeanZ - (r20 * pMeanX + r21 * pMeanY + r22 * pMeanZ);

    const transform: Mat4 = [
      r00,
      r10,
      r20,
      0,
      r01,
      r11,
      r21,
      0,
      r02,
      r12,
      r22,
      0,
      tx,
      ty,
      tz,
      1,
    ] as Mat4;

    // s minimizing sum |q' - s R p'|^2: s = sum(q' . R p') / sum(|p'|^2).
    // numerator = sum_a sum_b R[a][b] * S[b][a], where S[b][a] = sum(p'_b q'_a).
    const R = [
      [r00, r01, r02],
      [r10, r11, r12],
      [r20, r21, r22],
    ];
    const S = [
      [sxx, sxy, sxz],
      [syx, syy, syz],
      [szx, szy, szz],
    ];
    let numerator = 0;
    for (let a = 0; a < 3; a += 1) {
      for (let b = 0; b < 3; b += 1) {
        numerator += R[a]![b]! * S[b]![a]!;
      }
    }
    const impliedScale = centeredPP > 0 ? numerator / centeredPP : 1;

    return { transform, impliedScale };
  }
}

/**
 * Classical cyclic Jacobi eigenvalue algorithm for a small symmetric matrix
 * (this module only ever calls it with `n` = 3 or 4): repeated Givens
 * rotations zero one off-diagonal pair per step, cycling through every
 * `(p, q)` pair in a fixed order each sweep (deterministic, no pivot search,
 * no randomness), for up to `maxSweeps` sweeps or until the off-diagonal
 * energy is negligible, whichever comes first -- `maxSweeps` is the true
 * bound; convergence is an optimization, not a requirement for termination.
 * For matrices this small, convergence to double precision is reached
 * within roughly ten sweeps in practice; `JACOBI_MAX_SWEEPS` (100) is a
 * generous, fixed ceiling on top of that. Returns eigenvalues (the final
 * diagonal) and eigenvectors (the accumulated rotation's columns).
 */
function jacobiEigenSymmetric(
  input: readonly (readonly number[])[],
  n: number,
  maxSweeps: number,
): { values: number[]; vectors: number[][] } {
  const a = input.map((row) => row.slice());
  const v: number[][] = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)),
  );

  for (let sweep = 0; sweep < maxSweeps; sweep += 1) {
    let offDiagonalSumSquares = 0;
    for (let p = 0; p < n; p += 1) {
      for (let q = p + 1; q < n; q += 1) {
        offDiagonalSumSquares += a[p]![q]! * a[p]![q]!;
      }
    }
    if (offDiagonalSumSquares < JACOBI_CONVERGENCE_EPSILON) break;

    for (let p = 0; p < n - 1; p += 1) {
      for (let q = p + 1; q < n; q += 1) {
        const apq = a[p]![q]!;
        if (apq === 0) continue;
        const app = a[p]![p]!;
        const aqq = a[q]![q]!;
        const theta = (aqq - app) / (2 * apq);
        const t =
          (theta >= 0 ? 1 : -1) /
          (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        const tau = s / (1 + c);

        a[p]![p] = app - t * apq;
        a[q]![q] = aqq + t * apq;
        a[p]![q] = 0;
        a[q]![p] = 0;

        for (let k = 0; k < n; k += 1) {
          if (k === p || k === q) continue;
          const akp = a[k]![p]!;
          const akq = a[k]![q]!;
          const newAkp = akp - s * (akq + tau * akp);
          const newAkq = akq + s * (akp - tau * akq);
          a[k]![p] = newAkp;
          a[p]![k] = newAkp;
          a[k]![q] = newAkq;
          a[q]![k] = newAkq;
        }
        for (let k = 0; k < n; k += 1) {
          const vkp = v[k]![p]!;
          const vkq = v[k]![q]!;
          v[k]![p] = vkp - s * (vkq + tau * vkp);
          v[k]![q] = vkq + s * (vkp - tau * vkq);
        }
      }
    }
  }

  const values = Array.from({ length: n }, (_, i) => a[i]![i]!);
  return { values, vectors: v };
}

/**
 * Guards the `rigidTransformSchema` boundary against float drift: the
 * rotation this module computes is already numerically orthonormal to
 * within a few units in the last place (a fresh unit quaternion each
 * `RigidFitAccumulator.fit()` call, and -- for `iterative-closest-point` --
 * at most `MAX_ICP_ITERATIONS` compositions of such near-orthonormal
 * matrices), comfortably inside `rigidTransformSchema`'s 1e-10 tolerance.
 * This Gram-Schmidt re-orthonormalization of the final transform's rotation
 * columns is defense in depth, not a correction for an expected failure.
 */
function reorthonormalize(matrix: Mat4): Mat4 {
  let x: Vec3 = [matrix[0], matrix[1], matrix[2]];
  let y: Vec3 = [matrix[4], matrix[5], matrix[6]];
  const xLength = Math.hypot(x[0], x[1], x[2]) || 1;
  x = [x[0] / xLength, x[1] / xLength, x[2] / xLength];
  const xDotY = x[0] * y[0] + x[1] * y[1] + x[2] * y[2];
  y = [y[0] - xDotY * x[0], y[1] - xDotY * x[1], y[2] - xDotY * x[2]];
  const yLength = Math.hypot(y[0], y[1], y[2]) || 1;
  y = [y[0] / yLength, y[1] / yLength, y[2] / yLength];
  const z: Vec3 = [
    x[1] * y[2] - x[2] * y[1],
    x[2] * y[0] - x[0] * y[2],
    x[0] * y[1] - x[1] * y[0],
  ];
  return [
    x[0],
    x[1],
    x[2],
    0,
    y[0],
    y[1],
    y[2],
    0,
    z[0],
    z[1],
    z[2],
    0,
    matrix[12],
    matrix[13],
    matrix[14],
    1,
  ] as Mat4;
}

function applyRigid(transform: readonly number[], point: Vec3): Vec3 {
  const x = point[0];
  const y = point[1];
  const z = point[2];
  return [
    transform[0]! * x + transform[4]! * y + transform[8]! * z + transform[12]!,
    transform[1]! * x + transform[5]! * y + transform[9]! * z + transform[13]!,
    transform[2]! * x + transform[6]! * y + transform[10]! * z + transform[14]!,
  ];
}

function boundingDiagonal(points: readonly Vec3[]): number {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (const point of points) {
    if (point[0] < minX) minX = point[0];
    if (point[1] < minY) minY = point[1];
    if (point[2] < minZ) minZ = point[2];
    if (point[0] > maxX) maxX = point[0];
    if (point[1] > maxY) maxY = point[1];
    if (point[2] > maxZ) maxZ = point[2];
  }
  return Math.hypot(maxX - minX, maxY - minY, maxZ - minZ);
}

function boundingDiagonalOfPositions(
  positions: Float64Array,
  vertexCount: number,
): number {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
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
  return Math.hypot(maxX - minX, maxY - minY, maxZ - minZ);
}

/**
 * A disclosed heuristic, not an exact geometric guarantee: flags a
 * converged (or ceiling-hit) alignment whose after-fit RMS residual remains
 * a non-trivial fraction (`POOR_FIT_RESIDUAL_RATIO`, 2%) of the aligned
 * geometry's own bounding-box diagonal. A low-error alignment relative to a
 * large part reads as a good fit; the same absolute error on a small part
 * does not, which is why this is relative to scale rather than an absolute
 * millimetre threshold. This can both under- and over-flag: it is a signal
 * for a UI to surface for review, not a certified shape-match verdict --
 * exactly the same honesty this package applies to sampling and
 * interference evidence elsewhere (see `checkClearance`'s
 * `clearance.undersampled` warning for the same "bounded, not just
 * disclosed in prose" discipline).
 */
function evaluatePoorFit(
  residualsAfter: AlignmentResidualStats,
  scaleReferenceMillimetres: number,
): { poorFit: boolean; poorFitReason?: string } {
  const reference = Math.max(
    scaleReferenceMillimetres,
    MIN_POOR_FIT_SCALE_REFERENCE_MILLIMETRES,
  );
  const ratio = residualsAfter.rmsMillimetres / reference;
  if (ratio > POOR_FIT_RESIDUAL_RATIO) {
    return {
      poorFit: true,
      poorFitReason: `After alignment, the root-mean-square residual (${residualsAfter.rmsMillimetres.toFixed(6)} mm) is ${(ratio * 100).toFixed(2)}% of the aligned geometry's bounding diagonal (${reference.toFixed(6)} mm), above the ${(POOR_FIT_RESIDUAL_RATIO * 100).toFixed(0)}% heuristic threshold this package uses to flag a likely shape mismatch. A converged, low-iteration-count transform is not a confirmed match here -- treat this alignment as a starting point requiring review.`,
    };
  }
  return { poorFit: false };
}

function poorFitWarning(
  reason: string,
  residualsAfter: AlignmentResidualStats,
  scaleReference: number,
): AlignmentWarning {
  return {
    code: "alignment.poor-fit",
    severity: "warning",
    message: reason,
    details: {
      residualRmsMillimetres: residualsAfter.rmsMillimetres,
      residualMaxMillimetres: residualsAfter.maxMillimetres,
      scaleReferenceMillimetres: scaleReference,
      poorFitResidualRatio: POOR_FIT_RESIDUAL_RATIO,
    },
  };
}
