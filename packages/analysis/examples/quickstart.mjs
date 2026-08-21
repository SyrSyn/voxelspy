#!/usr/bin/env node
// A small, genuinely runnable counterpart to the illustrative snippets in
// README.md: every snippet there assumes variables (`request`, `baseline`,
// `candidate`, `model`, ...) already exist, which is fine for showing an
// API's shape but is not something a reader can paste into a terminal. This
// file is. It imports only through this package's public entry point --
// `@voxelspy/analysis` -- and `@voxelspy/contracts`, the same way an outside
// consumer would, builds two tiny models by hand (a closed 10mm cube and a
// one-corner-raised variant of it), and runs one full
// build -> analyze -> inspect -> measure flow, printing what each step
// returns.
//
// Run it after building this package:
//
//   pnpm --filter @voxelspy/analysis build
//   node packages/analysis/examples/quickstart.mjs
//
// or, from inside packages/analysis:
//
//   pnpm build && node examples/quickstart.mjs

import {
  CANONICAL_FRAME,
  IDENTITY_MAT4,
  analysisRequestSchema,
  normalizedModelSchema,
} from "@voxelspy/contracts";
import {
  ANALYSIS_LIMITS,
  SURFACE_DISTANCE_METHOD,
  analyzeModelPair,
  inspectModel,
  measureOnModel,
} from "@voxelspy/analysis";

// A closed, consistently-wound 10mm cube, expressed the way a real importer
// would hand it to this package: one mesh, one flat-placement instance, full
// provenance. `raise` optionally lifts one corner vertex, producing a
// deliberately-changed candidate for `analyzeModelPair` to detect.
function cubeModel(id, raise = 0) {
  const size = 10;
  return normalizedModelSchema.parse({
    contractVersion: 1,
    id,
    frame: CANONICAL_FRAME,
    meshes: [
      {
        id: `${id}.mesh`,
        geometry: {
          positions: new Float64Array([
            0,
            0,
            0,
            size,
            0,
            0,
            size,
            size,
            0,
            0,
            size,
            0,
            0,
            0,
            size,
            size,
            0,
            size,
            size,
            size,
            size + raise, // corner 6 -- optionally raised along Z
            0,
            size,
            size,
          ]),
          indices: new Uint32Array([
            0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6,
            2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5,
          ]),
        },
      },
    ],
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
      formatId: "generated-example",
      importerId: "quickstart-example",
      importerVersion: "1.0.0",
      sourceName: `${id}.generated`,
      detectedSourceUnit: "millimetre",
      detectedSourceAxis: "right-handed-z-up",
      sourceUnit: "millimetre",
      sourceAxis: "right-handed-z-up",
      sourceResolution: { unit: "embedded", axis: "embedded" },
      appliedSourceToModel: IDENTITY_MAT4,
      notes: [
        "Procedurally generated for packages/analysis/examples/quickstart.mjs.",
      ],
    },
  });
}

const baseline = cubeModel("baseline");
const candidate = cubeModel("candidate", /* raise= */ 1.5);

console.log("== analyzeModelPair ==");
const request = analysisRequestSchema.parse({
  contractVersion: 1,
  requestId: "quickstart.request.1",
  baseline: { modelId: baseline.id, modelToComparison: IDENTITY_MAT4 },
  candidate: { modelId: candidate.id, modelToComparison: IDENTITY_MAT4 },
  method: {
    id: SURFACE_DISTANCE_METHOD.id,
    version: SURFACE_DISTANCE_METHOD.version,
    parameters: {},
  },
  tolerance: { distanceMillimetres: 0.01 },
});
const analysis = analyzeModelPair({ request, baseline, candidate });
console.log("outcome.state:", analysis.outcome.state);
if (analysis.outcome.state === "complete") {
  console.log("changed regions:", analysis.outcome.orderedRegionIds.length);
  console.log(
    "uncertainty (max sample spacing, mm):",
    analysis.outcome.uncertainty.parameters.maxSampleSpacingMillimetres,
  );
}

console.log("\n== inspectModel ==");
const inspection = inspectModel(baseline);
console.log("watertightness:", inspection.watertightness);
console.log("topology findings:", inspection.topologyFindings.length);

console.log("\n== measureOnModel (bounding-extent) ==");
const extent = measureOnModel(baseline, { kind: "bounding-extent" });
if (extent.bounds.available) {
  console.log("dimensions (mm):", extent.bounds.dimensionsMillimetres);
}

console.log("\n== measureOnModel (snap-point) ==");
const snap = measureOnModel(baseline, {
  kind: "snap-point",
  at: { kind: "point", point: [5, 5, 0] },
});
if (snap.outcome.hit) {
  console.log("snapped point (mm):", snap.outcome.pointMillimetres);
  console.log("snap classification:", snap.outcome.snap.kind);
}

console.log("\n== ANALYSIS_LIMITS (for sizing your own execution budgets) ==");
console.log({
  maxExpandedVertices: ANALYSIS_LIMITS.maxExpandedVertices,
  maxExpandedTriangles: ANALYSIS_LIMITS.maxExpandedTriangles,
  maxMemoryBytes: ANALYSIS_LIMITS.maxMemoryBytes,
  maxWorkUnits: ANALYSIS_LIMITS.maxWorkUnits,
});
