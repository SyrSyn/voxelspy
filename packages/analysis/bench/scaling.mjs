#!/usr/bin/env node
/**
 * Deterministic scaling and memory benchmark for `@voxelspy/analysis`'s
 * `surface-distance` method.
 *
 * This is a manually-run measurement script, not a test: it is never
 * executed by `pnpm test` / CI, so it cannot slow the test suite down. Run
 * it on demand -- see the "Benchmark" section of ../README.md for what it
 * measures and its limits (single machine, Node.js, not a browser or device
 * claim).
 *
 * Usage:
 *   node --expose-gc bench/scaling.mjs            # default tiers (~1k/10k/50k triangles/side)
 *   node --expose-gc bench/scaling.mjs --large     # also runs the ~200k tier and the ~1M
 *                                                  # documented-ceiling tier (1,000,000 combined
 *                                                  # triangles; roughly a minute on its own)
 *   pnpm --filter @voxelspy/analysis bench         # same as the first form
 *
 * `--expose-gc` is optional but strongly recommended: without it, memory
 * numbers are raw, un-forced `process.memoryUsage().heapUsed` deltas and
 * this script says so loudly instead of quietly reporting GC noise as if it
 * were a measurement.
 *
 * Everything here is seeded and arithmetic (no wall-clock-dependent
 * inputs), so two runs on the same machine generate byte-identical geometry
 * and should report closely comparable timings.
 */

import { performance } from "node:perf_hooks";
import { analyzeModelPair } from "../dist/index.js";
import {
  CANONICAL_FRAME,
  IDENTITY_MAT4,
  analysisRequestSchema,
  normalizedModelSchema,
} from "@voxelspy/contracts";

// ---------------------------------------------------------------------------
// Geometry generation: seeded, deterministic, arithmetic only.
// ---------------------------------------------------------------------------

/** Physical footprint of every generated panel, regardless of tessellation. */
const EXTENT_MILLIMETRES = 1000;
/**
 * A genuinely 3D (not near-planar) deterministic terrain surface is used
 * instead of a flat sheet: an early version of this benchmark used a flat
 * panel with a small Z undulation, which starved the spatial index's
 * bounding-box pruning of a third discriminating axis and produced
 * misleadingly early budget exhaustion caused by the shape, not by scale.
 * A two-frequency sine/cosine terrain gives every tier real 3D structure.
 * See the "Benchmark" section of ../README.md for the measured effect this
 * had before it was corrected.
 */
const TERRAIN_AMPLITUDE_MILLIMETRES = 150;
const TERRAIN_WAVELENGTH_X_MILLIMETRES = 120;
const TERRAIN_WAVELENGTH_Y_MILLIMETRES = 95;
/** Height of the deliberate deviation given to the candidate model only. */
const BUMP_HEIGHT_MILLIMETRES = 20;
/** A realistic inspection tolerance: comfortably below the bump height. */
const TOLERANCE_MILLIMETRES = 1;
/** Fraction of the grid, from each edge, left outside the bumped square. */
const BUMP_MARGIN_FRACTION = 0.4;

/** Deterministic terrain height at one (x, y) position, given a tier phase. */
function terrainHeight(x, y, phase) {
  return (
    TERRAIN_AMPLITUDE_MILLIMETRES *
    Math.sin(x / TERRAIN_WAVELENGTH_X_MILLIMETRES + phase) *
    Math.cos(y / TERRAIN_WAVELENGTH_Y_MILLIMETRES + phase * 0.5)
  );
}

/**
 * Mirrors the per-element memory estimate documented in
 * ../src/analyze.ts (`BYTES_PER_VERTEX` / `BYTES_PER_TRIANGLE`) and in
 * ../README.md. Not imported: the package does not export these constants
 * from its public API (`checkResourceBudget` is internal), so this
 * benchmark restates the publicly documented values rather than reaching
 * into `src`. If the documented estimate ever changes, update these two
 * constants to match -- a mismatch here would silently invalidate the
 * measured-vs-estimated comparison below.
 *
 * These already include the 1.5x structural safety margin described in
 * `src/analyze.ts`. Below roughly the ~50k tier, single-sample `heapUsed`
 * readings are expected to still WARN sometimes -- that reflects
 * GC-scheduling noise this benchmark's own repeated-run measurements
 * uncovered, not a regression -- see the "Resource behavior" section of
 * ../README.md. The tier that must never WARN once completed is the
 * documented-ceiling tier below (`~1M`); see the memory regression guard
 * near the end of this script.
 */
const ESTIMATED_BYTES_PER_VERTEX = 36;
const ESTIMATED_BYTES_PER_TRIANGLE = 450;
/**
 * Mirrors `ANALYSIS_LIMITS.maxMemoryBytes` in ../src/analyze.ts, restated
 * here for the same reason as the constants above: it is not exported.
 * Used only as a hard regression guard on the documented-ceiling tier, not
 * as the per-tier estimate.
 */
const MAX_MEMORY_BYTES_CEILING = 768 * 1024 * 1024;

// Small mulberry32 PRNG: fast, deterministic, no dependency.
function mulberry32(seed) {
  let state = seed >>> 0;
  return function next() {
    state += 0x6d2b79f5;
    let result = Math.imul(state ^ (state >>> 15), state | 1);
    result ^= result + Math.imul(result ^ (result >>> 7), result | 61);
    return ((result ^ (result >>> 14)) >>> 0) / 4294967296;
  };
}

/** Builds the shared indexed grid triangulation for one panel side. */
function buildGridIndices(gridSize) {
  const verticesPerSide = gridSize + 1;
  const indices = new Uint32Array(gridSize * gridSize * 2 * 3);
  let cursor = 0;
  for (let row = 0; row < gridSize; row += 1) {
    for (let column = 0; column < gridSize; column += 1) {
      const a = row * verticesPerSide + column;
      const b = a + 1;
      const c = a + verticesPerSide + 1;
      const d = a + verticesPerSide;
      indices[cursor] = a;
      indices[cursor + 1] = b;
      indices[cursor + 2] = c;
      indices[cursor + 3] = a;
      indices[cursor + 4] = c;
      indices[cursor + 5] = d;
      cursor += 6;
    }
  }
  return { verticesPerSide, indices };
}

/** Builds one panel's positions: shared terrain height, plus an optional bump. */
function buildPositions(verticesPerSide, step, phase, bumpRange) {
  const vertexCount = verticesPerSide * verticesPerSide;
  const positions = new Float64Array(vertexCount * 3);
  for (let row = 0; row < verticesPerSide; row += 1) {
    for (let column = 0; column < verticesPerSide; column += 1) {
      const index = row * verticesPerSide + column;
      const inBump =
        bumpRange !== undefined &&
        row >= bumpRange.rowStart &&
        row <= bumpRange.rowEnd &&
        column >= bumpRange.columnStart &&
        column <= bumpRange.columnEnd;
      const x = column * step;
      const y = row * step;
      const base = index * 3;
      positions[base] = x;
      positions[base + 1] = y;
      positions[base + 2] =
        terrainHeight(x, y, phase) + (inBump ? BUMP_HEIGHT_MILLIMETRES : 0);
    }
  }
  return positions;
}

function buildModel(id, positions, indices) {
  return normalizedModelSchema.parse({
    contractVersion: 1,
    id,
    frame: CANONICAL_FRAME,
    meshes: [{ id: `${id}.mesh`, geometry: { positions, indices } }],
    placement: {
      kind: "flat",
      instances: [
        {
          id: `${id}.instance`,
          meshId: `${id}.mesh`,
          meshToModel: IDENTITY_MAT4,
        },
      ],
    },
    warnings: [],
    provenance: {
      formatId: "generated-benchmark",
      importerId: "analysis-bench-scaling",
      importerVersion: "1.0.0",
      sourceName: `${id}.generated`,
      detectedSourceUnit: "millimetre",
      detectedSourceAxis: "right-handed-z-up",
      sourceUnit: "millimetre",
      sourceAxis: "right-handed-z-up",
      sourceResolution: { unit: "embedded", axis: "embedded" },
      appliedSourceToModel: IDENTITY_MAT4,
      notes: [
        "Procedurally generated grid panel for packages/analysis/bench/scaling.mjs.",
      ],
    },
  });
}

function buildRequest(requestId, baselineId, candidateId, executionBudget) {
  return analysisRequestSchema.parse({
    contractVersion: 1,
    requestId,
    baseline: { modelId: baselineId, modelToComparison: IDENTITY_MAT4 },
    candidate: { modelId: candidateId, modelToComparison: IDENTITY_MAT4 },
    method: { id: "surface-distance", version: "1.0.0", parameters: {} },
    tolerance: { distanceMillimetres: TOLERANCE_MILLIMETRES },
    ...(executionBudget === undefined ? {} : { executionBudget }),
  });
}

/**
 * Builds one tier's baseline/candidate pair: a `gridSize x gridSize` cell
 * grid panel (two triangles per cell) tessellating a deterministic 3D
 * terrain surface, plus a single square region -- well above tolerance --
 * raised only in the candidate. This gives `analyzeModelPair` a realistic,
 * non-trivial connected-region workload instead of a degenerate
 * all-changed, all-identical, or near-planar input. `tier.seed` only
 * derives the terrain phase (kept for reproducibility and to vary each
 * tier's terrain slightly); geometry is otherwise a closed-form function of
 * position, so baseline and candidate are bit-identical outside the bump.
 */
function buildTier(tier) {
  const { verticesPerSide, indices } = buildGridIndices(tier.gridSize);
  const step = EXTENT_MILLIMETRES / tier.gridSize;
  const phase = mulberry32(tier.seed)() * Math.PI * 2;
  const rowStart = Math.floor(tier.gridSize * BUMP_MARGIN_FRACTION);
  const rowEnd = Math.ceil(tier.gridSize * (1 - BUMP_MARGIN_FRACTION));
  const bumpRange = {
    rowStart,
    rowEnd,
    columnStart: rowStart,
    columnEnd: rowEnd,
  };

  const baselinePositions = buildPositions(verticesPerSide, step, phase);
  const candidatePositions = buildPositions(
    verticesPerSide,
    step,
    phase,
    bumpRange,
  );

  const baseline = buildModel(
    `bench-${tier.slug}-baseline`,
    baselinePositions,
    indices,
  );
  const candidate = buildModel(
    `bench-${tier.slug}-candidate`,
    candidatePositions,
    indices,
  );
  const triangleCountPerSide = indices.length / 3;
  return {
    tier,
    baseline,
    candidate,
    vertexCountPerSide: verticesPerSide * verticesPerSide,
    triangleCountPerSide,
  };
}

// ---------------------------------------------------------------------------
// Tiers
// ---------------------------------------------------------------------------

const TIERS = [
  { label: "~1k", slug: "1k", gridSize: 22, seed: 0x1001 },
  { label: "~10k", slug: "10k", gridSize: 71, seed: 0x1002 },
  { label: "~50k", slug: "50k", gridSize: 158, seed: 0x1003 },
  {
    label: "~200k",
    slug: "200k",
    gridSize: 316,
    seed: 0x1004,
    optional: true,
  },
  /**
   * gridSize 500 produces exactly 1,000,000 combined (baseline + candidate)
   * triangles -- this package's documented `maxExpandedTriangles` ceiling
   * (see ../README.md's "Resource behavior" section). Under the default
   * execution budget (no `executionBudget` override -- this tier, like the
   * others above, is built through `buildRequest` without one), this tier
   * must reach `state: "complete"`, not `resource-budget-exceeded`: that is
   * the concrete evidence that the documented triangle ceiling is actually
   * reachable, not just declared. See the memory and budget regression
   * guards near the end of this script. Single iteration and `--large`-only:
   * this tier takes roughly a minute on a typical development machine.
   */
  {
    label: "~1M (documented ceiling)",
    slug: "1m",
    gridSize: 500,
    seed: 0x1005,
    optional: true,
  },
];

const includeLarge = process.argv.includes("--large");
const activeTiers = TIERS.filter((tier) => !tier.optional || includeLarge);

const gcAvailable = typeof globalThis.gc === "function";

// ---------------------------------------------------------------------------
// Measurement helpers
// ---------------------------------------------------------------------------

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function formatMiB(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

function formatMs(ms) {
  return `${ms.toFixed(1)} ms`;
}

/** Runs one tier's analyzeModelPair `iterations` times; measures the last. */
function runTier(built, iterations) {
  const { baseline, candidate, tier } = built;
  const request = buildRequest(`bench.${tier.slug}`, baseline.id, candidate.id);
  const wallTimesMs = [];
  let lastResult;
  let measuredDeltaBytes;
  let retainedDeltaBytes;
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const isLast = iteration === iterations - 1;
    if (isLast && gcAvailable) globalThis.gc();
    const heapBefore = process.memoryUsage().heapUsed;
    const start = performance.now();
    const result = analyzeModelPair({ request, baseline, candidate });
    const wallMs = performance.now() - start;
    wallTimesMs.push(wallMs);
    if (isLast) {
      lastResult = result;
      const heapAfterRaw = process.memoryUsage().heapUsed;
      measuredDeltaBytes = heapAfterRaw - heapBefore;
      if (gcAvailable) {
        globalThis.gc();
        retainedDeltaBytes = process.memoryUsage().heapUsed - heapBefore;
      }
    }
  }
  return {
    medianWallMs: median(wallTimesMs),
    wallTimesMs,
    result: lastResult,
    measuredDeltaBytes,
    retainedDeltaBytes,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  console.log("@voxelspy/analysis scaling benchmark");
  console.log(
    "Scope: single machine, single Node.js process. NOT a browser or device-tier claim.",
  );
  console.log(
    `Node ${process.versions.node} on ${process.platform}/${process.arch}; --expose-gc ${gcAvailable ? "ENABLED" : "NOT ENABLED"}.`,
  );
  if (!gcAvailable) {
    console.log(
      "WARNING: run with `node --expose-gc` for reliable memory measurement. " +
        "Without it, memory deltas below are raw, un-forced heapUsed samples " +
        "that can include unrelated GC noise from earlier tiers; they are " +
        "labeled UNRELIABLE rather than reported as clean measurements.",
    );
  }
  console.log("");

  let anyMemoryFinding = false;
  let anyScalingFinding = false;
  let anyBudgetFinding = false;

  const rows = [];
  for (const tier of activeTiers) {
    const built = buildTier(tier);
    const iterations = tier.optional ? 1 : 3;
    const combinedVertices = built.vertexCountPerSide * 2;
    const combinedTriangles = built.triangleCountPerSide * 2;
    const estimatedMemoryBytes =
      combinedVertices * ESTIMATED_BYTES_PER_VERTEX +
      combinedTriangles * ESTIMATED_BYTES_PER_TRIANGLE;

    const measurement = runTier(built, iterations);
    const outcome = measurement.result.outcome;

    if (outcome.state !== "complete") {
      // A tier failing closed with `resource-budget-exceeded` under the
      // *default* execution budget (not the deliberately tiny budget used
      // by the dedicated fail-closed check below) is itself a real,
      // reportable measurement, not a benchmark bug: it shows the fixed
      // charged-work-unit ceiling can be exhausted well short of this
      // package's documented triangle/vertex ceilings. Record it and keep
      // going instead of aborting the whole run.
      if (outcome.code !== "resource-budget-exceeded") {
        console.error(
          `FATAL: tier ${tier.label} failed unexpectedly (state=${outcome.state}, code=${outcome.code}). This is a benchmark-setup problem, not a measurement.`,
        );
        console.error(JSON.stringify(outcome, null, 2));
        process.exitCode = 1;
        return;
      }
      anyBudgetFinding = true;
      rows.push({
        tier,
        combinedVertices,
        combinedTriangles,
        estimatedMemoryBytes,
        measuredDeltaBytes: measurement.measuredDeltaBytes,
        medianWallMs: measurement.medianWallMs,
        budgetExceeded: true,
      });
      continue;
    }

    const conservative =
      gcAvailable && measurement.measuredDeltaBytes <= estimatedMemoryBytes;
    // The documented-ceiling tier (slug "1m") gets its own dedicated,
    // exit-code-affecting check below; it is deliberately excluded from
    // this informational small/mid-tier note so the note's wording (which
    // describes expected small-scale GC noise) stays accurate.
    if (gcAvailable && !conservative && tier.slug !== "1m") {
      anyMemoryFinding = true;
    }

    rows.push({
      tier,
      combinedVertices,
      combinedTriangles,
      estimatedMemoryBytes,
      measuredDeltaBytes: measurement.measuredDeltaBytes,
      retainedDeltaBytes: measurement.retainedDeltaBytes,
      medianWallMs: measurement.medianWallMs,
      wallTimesMs: measurement.wallTimesMs,
      regionCount: outcome.regions.length,
      conservative,
      budgetExceeded: false,
    });
  }

  // -------------------------------------------------------------------------
  // Table: per-tier counts, timing, and memory.
  // -------------------------------------------------------------------------
  console.log(
    "Per-tier measurements (triangle/vertex counts are baseline+candidate combined):",
  );
  console.log("");
  const header = [
    "tier",
    "triangles",
    "vertices",
    "regions",
    "median ms",
    "estimated mem",
    "measured Δheap",
    "ratio",
    "verdict",
  ];
  const lines = [header];
  for (const row of rows) {
    if (row.budgetExceeded) {
      const partialExceeds =
        gcAvailable && row.measuredDeltaBytes > row.estimatedMemoryBytes;
      lines.push([
        row.tier.label,
        String(row.combinedTriangles),
        String(row.combinedVertices),
        "n/a",
        `${formatMs(row.medianWallMs)} (to failure)`,
        formatMiB(row.estimatedMemoryBytes),
        gcAvailable ? `${formatMiB(row.measuredDeltaBytes)} (partial)` : "n/a",
        "n/a",
        `BUDGET EXCEEDED (did not complete)${partialExceeds ? " -- partial memory already exceeded estimate" : ""}`,
      ]);
      continue;
    }
    const ratio =
      row.estimatedMemoryBytes > 0
        ? row.measuredDeltaBytes / row.estimatedMemoryBytes
        : Number.NaN;
    const verdict = gcAvailable
      ? row.conservative
        ? "PASS (conservative)"
        : "WARN (NOT conservative)"
      : "N/A (no --expose-gc)";
    lines.push([
      row.tier.label,
      String(row.combinedTriangles),
      String(row.combinedVertices),
      String(row.regionCount),
      formatMs(row.medianWallMs),
      formatMiB(row.estimatedMemoryBytes),
      `${formatMiB(row.measuredDeltaBytes)}${gcAvailable ? "" : " (unreliable)"}`,
      Number.isFinite(ratio) ? `${(ratio * 100).toFixed(1)}%` : "n/a",
      verdict,
    ]);
  }
  printTable(lines);
  console.log("");

  // -------------------------------------------------------------------------
  // Scaling summary: ms per 1,000 triangles, to make superlinear growth visible.
  // -------------------------------------------------------------------------
  console.log(
    "Scaling summary (ms per 1,000 combined triangles; budget-exceeded tiers show time-to-failure and are excluded from the growth comparison, since they did not run to completion):",
  );
  console.log("");
  const scalingLines = [["tier", "ms/1k triangles", "growth vs. prior tier"]];
  let previousPer1k;
  for (const row of rows) {
    const per1k = row.medianWallMs / (row.combinedTriangles / 1000);
    if (row.budgetExceeded) {
      scalingLines.push([
        row.tier.label,
        `${per1k.toFixed(3)} (to failure)`,
        "n/a (did not complete)",
      ]);
      continue;
    }
    let growth = "n/a (first completed tier)";
    if (previousPer1k !== undefined) {
      const factor = per1k / previousPer1k;
      const flagged = factor > 1.5;
      if (flagged) anyScalingFinding = true;
      growth = `${factor.toFixed(2)}x${flagged ? " -- WARN: possible superlinear scaling" : ""}`;
    }
    scalingLines.push([row.tier.label, per1k.toFixed(3), growth]);
    previousPer1k = per1k;
  }
  printTable(scalingLines);
  console.log("");

  // -------------------------------------------------------------------------
  // Repeatability check: same seed, same process -> identical outcome.
  // -------------------------------------------------------------------------
  console.log("Repeatability check (smallest tier, run twice, compared):");
  const repeatBuilt = buildTier(activeTiers[0]);
  const repeatRequest = buildRequest(
    "bench.repeat",
    repeatBuilt.baseline.id,
    repeatBuilt.candidate.id,
  );
  const firstRun = analyzeModelPair({
    request: repeatRequest,
    baseline: repeatBuilt.baseline,
    candidate: repeatBuilt.candidate,
  });
  const secondRun = analyzeModelPair({
    request: repeatRequest,
    baseline: repeatBuilt.baseline,
    candidate: repeatBuilt.candidate,
  });
  const repeatable =
    JSON.stringify(firstRun.outcome) === JSON.stringify(secondRun.outcome);
  console.log(
    `  ${repeatable ? "PASS" : "FAIL"}: two runs of the same seeded geometry produced ${repeatable ? "identical" : "DIFFERENT"} outcomes.`,
  );
  if (!repeatable) process.exitCode = 1;
  console.log("");

  // -------------------------------------------------------------------------
  // Fail-closed check: a deliberately tiny execution budget on a
  // non-trivial-scale pair must fail closed as an indeterminate resource
  // outcome, quickly, rather than hanging or exhausting memory.
  // -------------------------------------------------------------------------
  console.log("Fail-closed check (tiny execution budget on a mid-scale pair):");
  const failClosedTier =
    activeTiers.find((tier) => tier.label === "~50k") ?? activeTiers[0];
  const failClosedBuilt = buildTier(failClosedTier);
  const failClosedRequest = buildRequest(
    "bench.failclosed",
    failClosedBuilt.baseline.id,
    failClosedBuilt.candidate.id,
    { maxWorkUnits: 1, maxMemoryBytes: 256 * 1024 * 1024 },
  );
  const failClosedStart = performance.now();
  const failClosedResult = analyzeModelPair({
    request: failClosedRequest,
    baseline: failClosedBuilt.baseline,
    candidate: failClosedBuilt.candidate,
  });
  const failClosedMs = performance.now() - failClosedStart;
  const failedClosed =
    failClosedResult.outcome.state === "indeterminate" &&
    failClosedResult.outcome.code === "resource-budget-exceeded";
  console.log(
    `  ${failedClosed ? "PASS" : "FAIL"}: tier ${failClosedTier.label} (${failClosedBuilt.triangleCountPerSide * 2} combined triangles) with maxWorkUnits=1 returned ` +
      `state=${failClosedResult.outcome.state}${
        "code" in failClosedResult.outcome
          ? `, code=${failClosedResult.outcome.code}`
          : ""
      } in ${formatMs(failClosedMs)} (no hang, no crash).`,
  );
  if (!failedClosed) process.exitCode = 1;
  console.log("");

  // -------------------------------------------------------------------------
  // Prominent findings and regression guards.
  //
  // Both findings below were investigated and addressed in src/analyze.ts
  // (see its BYTES_PER_VERTEX/BYTES_PER_TRIANGLE and ANALYSIS_LIMITS
  // comments) and in the README's "Resource behavior" section. What follows
  // distinguishes expected, already-explained noise from an actual
  // regression of either fix.
  // -------------------------------------------------------------------------
  const ceilingRow = rows.find((row) => row.tier.slug === "1m");
  let ceilingRegression = false;

  if (ceilingRow !== undefined) {
    if (ceilingRow.budgetExceeded) {
      console.log(
        "=".repeat(78) +
          "\nREGRESSION: the documented-ceiling tier (~1M, 1,000,000 combined\n" +
          "triangles) did NOT complete under the default execution budget --\n" +
          "it returned resource-budget-exceeded. ANALYSIS_LIMITS.maxWorkUnits in\n" +
          "src/analyze.ts is calibrated, with measured margin, to make this\n" +
          "package's documented triangle ceiling reachable; this tier failing\n" +
          "means that calibration has regressed (charges grew, the ceiling\n" +
          "shrank, or geometry got harder to prune) and needs new evidence, not\n" +
          "just a larger constant.\n" +
          "=".repeat(78),
      );
      ceilingRegression = true;
    } else if (gcAvailable && !ceilingRow.conservative) {
      console.log(
        "=".repeat(78) +
          "\nREGRESSION: the documented-ceiling tier (~1M) completed but measured\n" +
          "working memory EXCEEDED the documented estimate. Unlike the smaller\n" +
          "tiers above, this is exactly the scale where BYTES_PER_VERTEX/\n" +
          "BYTES_PER_TRIANGLE's safety margin is supposed to hold -- see their\n" +
          "comment in src/analyze.ts. Investigate before trusting the 768 MiB\n" +
          "ceiling at this size.\n" +
          "=".repeat(78),
      );
      ceilingRegression = true;
    } else {
      console.log(
        `Documented-ceiling check: the ~1M tier (1,000,000 combined triangles) completed under the default execution budget${gcAvailable ? `, using ${formatMiB(ceilingRow.measuredDeltaBytes)} against a ${formatMiB(ceilingRow.estimatedMemoryBytes)} estimate and a ${formatMiB(MAX_MEMORY_BYTES_CEILING)} ceiling` : ""}. This is the concrete evidence that the README's documented triangle ceiling is reachable, not just declared.`,
      );
    }
  } else {
    console.log(
      "Documented-ceiling check: skipped (run with --large to include the ~1M tier).",
    );
  }
  if (ceilingRegression) process.exitCode = 1;

  if (gcAvailable && anyMemoryFinding) {
    console.log(
      "Note: measured working memory exceeded the documented estimate for at least one SMALL/MID tier above (rows marked WARN, tier < ~1M). " +
        "This is expected and already accounted for: repeated runs of byte-identical geometry show single-sample heapUsed deltas at these " +
        "scales vary with V8 garbage-collector scheduling, not a stable per-element cost (see BYTES_PER_VERTEX/BYTES_PER_TRIANGLE's comment " +
        "in src/analyze.ts). Absolute magnitudes at these tiers (low tens of MiB at most) are far below anything that threatens a browser " +
        "tab; the documented-ceiling check above is the one that must stay conservative.",
    );
  } else if (gcAvailable) {
    console.log(
      "Estimate check: measured working memory stayed within the documented estimate at every tier run.",
    );
  }
  if (anyScalingFinding) {
    console.log(
      "FINDING: ms-per-1k-triangles grew by more than 1.5x between at least one pair of adjacent tiers (see WARN above); this may indicate superlinear scaling.",
    );
  }
  if (anyBudgetFinding && !ceilingRegression) {
    console.log(
      "=".repeat(78) +
        "\nREGRESSION: at least one tier at or below the documented ceiling hit\n" +
        "the default charged work-unit budget (ANALYSIS_LIMITS.maxWorkUnits in\n" +
        "src/analyze.ts) and returned resource-budget-exceeded without a\n" +
        "caller-requested small budget. That budget is calibrated, with\n" +
        "measured margin, to reach the documented 1,000,000-triangle ceiling\n" +
        "(see the ~1M tier above); a smaller completed tier failing closed\n" +
        "instead means that calibration has regressed.\n" +
        "=".repeat(78),
    );
    process.exitCode = 1;
  }
}

function printTable(rows) {
  const widths = rows[0].map((_, column) =>
    Math.max(...rows.map((row) => row[column].length)),
  );
  for (const row of rows) {
    console.log(
      row.map((cell, column) => cell.padEnd(widths[column])).join("  "),
    );
  }
}

main();
