# `@voxelspy/analysis`

Deterministic, bounded geometry comparison over normalized VoxelSpy models. The package consumes `@voxelspy/contracts` values, keeps geometry work independent of UI and browser APIs, and returns validated, serializable analysis results.

## Methods

### `surface-distance` 1.0.0

This adapter samples every triangle's vertices and centroid, measures each sample against a deterministic spatial index of the opposite tessellated surface, groups changed triangles that share exact geometric edges, and ranks regions by maximum distance followed by affected area. Spatial pruning uses exact bounding-box lower bounds while final distances retain the point-to-triangle calculation. Exact edge matching connects facet-local STL vertices when their endpoint coordinates are identical without introducing tolerance-based welding. It requires a distance tolerance. `parameters.maxRegions` may limit the reported ranked regions to a positive integer no greater than 2,048; truncation produces an explicit warning and uncertainty count.

The result is always **approximate**, including when sampled distance is zero. Finite samples can miss extrema, edges that differ by any coordinate value remain separate, and both values and regions depend on tessellation. This is not an exact Hausdorff-distance implementation.

Sampling error is bounded, not just disclosed in prose: for each analyzed triangle, the farthest any point on that triangle can be from its nearest sample (a vertex or the centroid) is at most two-thirds of that triangle's longest edge. The result reports the largest such bound per model and for the pair as `uncertainty.parameters.maxSampleSpacingMillimetres` (with per-model `baselineMaxSampleSpacingMillimetres` and `candidateMaxSampleSpacingMillimetres`), alongside `toleranceMillimetres` and an `undersampled` flag. When the spacing bound exceeds the requested tolerance, a feature confined to a single coarse triangle's interior can be missed entirely -- reported as `complete` with no region for it -- and the result also carries an explicit `analysis.surface-distance-undersampled` warning naming both numbers.

### `axis-aligned-box-solid` 1.0.0

This adapter decomposes the set difference of two boxes into disjoint cells and returns exact volume metrics within a deliberately narrow validated domain. Each comparison-frame input must be one closed, consistently oriented, indexed axis-aligned box with exactly eight corner vertices and twelve non-degenerate triangles. It accepts no method parameters.

The result is **exact within those validated preconditions**. Other closed solids, rotated boxes, duplicate-per-face vertices, general Boolean operations, and repaired geometry return `indeterminate`; the adapter never falls through to a different method.

## Topology semantics

Closedness, orientation consistency, non-manifold detection, and region connectivity all key triangle edges by exact vertex **coordinate**, never by raw vertex index: two triangle corners are treated as the same point, and their shared edge as connected, only when their coordinates are bit-for-bit identical. No tolerance-based welding happens anywhere in this package. This is uniform across `MeshAssessment` (the `assessGeometry` step behind every `validation` entry on an `AnalysisResult`), the `surface-distance` method's exact-edge region connectivity, `summarizeModelGeometry`'s topology and volume evidence, and `inspectModel`'s topology findings and watertightness verdict (below), so a facet-local mesh -- one private vertex copy per triangle corner, the representation binary STL import commonly produces -- that is geometrically watertight is recognized as closed consistently by all four. Index-level topology (whether two triangles happen to reuse the same vertex index) is not what validation, connectivity, the summary, or the inspection report report.

## Single-model inspection

`inspectModel(model, options?)` builds a self-contained `InspectionResult` for one model -- vertex/triangle/mesh/instance/component counts, bounds, surface area, and volume (via `summarizeModelGeometry`, reused unmodified rather than reimplemented), plus:

- **`topologyFindings`**: one entry per topology issue kind actually present (`boundary-edges`, `non-manifold-edges`, `inconsistent-orientation`, `degenerate-triangles`), each with a stable `id`/`kind`, a `count`, a human-readable `summary`, and up to `maxTopologyExamples` bounded, deterministically ordered representative `examples` (an edge midpoint or triangle centroid plus the contributing triangle indices), with `examplesTruncated` set whenever `count` exceeds the number of examples returned -- including when `maxTopologyExamples` is `0`. `boundary-edges` is reported at `info` severity (an open surface is often an intentionally open sheet or panel, not damaged geometry); the other three kinds are `warning`, since each makes the surface itself unreliable for area, volume, or normal-based interpretation. Findings and their examples are omitted, never invented, for issue kinds with a zero count.
- **`watertightness`**: `{ state: "closed" }`, `{ state: "not-closed", reasons }`, or `{ state: "indeterminate", reasons: ["empty-geometry"] }`. This verdict reuses exactly the same two topology counts `summarizeModelGeometry` already uses to decide volume availability -- closed if and only if `topology.boundaryEdgeCount === 0 && topology.nonManifoldEdgeCount === 0`, matching `MeshAssessment.closed` in `analyze.ts` -- so this package never expresses two conflicting notions of "closed." Inconsistent orientation does not affect this verdict (a mesh can be topologically closed while inconsistently wound); it still surfaces separately as its own `topologyFindings` entry and still withholds volume, exactly as `summarizeModelGeometry` already does. `indeterminate` documents the empty-geometry case defensively and is not reachable through `inspectModel` itself today, because the contracts mesh-buffer schema requires a nonzero-byte-length buffer for both `positions` and `indices`, so a schema-valid mesh always contributes at least one triangle.
- **`meshBreakdown`**: `{ meshId, triangleCount, vertexCount }` per mesh record, in `model.meshes` order, bounded by `maxMeshBreakdownEntries` with `truncated`/`totalMeshCount` recorded.
- **`frame`** and **`provenance`** are echoed from the input model unchanged -- never reinterpreted, recentered, or repaired.

`inspectModel` fails closed on hostile input: it validates `model` against `normalizedModelSchema` first (throwing the same way `analyzeModelPair` does on an invalid contract), then checks expanded vertex/triangle counts against this package's existing `ANALYSIS_LIMITS.maxExpandedVertices`/`maxExpandedTriangles` ceilings (the same ceilings `analyzeModelPair` enforces) before any O(vertices + triangles) work runs, throwing `InspectionResourceLimitError` if either is exceeded. `InspectOptions.maxTopologyExamples` (default `DEFAULT_MAX_TOPOLOGY_EXAMPLES` = 5, ceiling `MAX_TOPOLOGY_EXAMPLES` = 50) and `maxMeshBreakdownEntries` (default `DEFAULT_MAX_MESH_BREAKDOWN_ENTRIES` = 200, ceiling `MAX_MESH_BREAKDOWN_ENTRIES` = 2,000) are the only bounds this module adds beyond the package's existing ceilings; an out-of-range value throws `RangeError` rather than being silently clamped. The result is deterministic: identical input, including identical option values, produces a deeply equal `InspectionResult` every time, because example selection walks the model's own mesh/placement traversal order and `Map` insertion order, never object identity or iteration timing.

`inspectModel` adds no new geometry math beyond bounded example-location collection: internally it calls the same triangle/edge walk `summarizeModelGeometry` uses (see `summarizeModelGeometryWithEvidence` in `src/summary.ts`) so the two can never diverge on counts, and is a reporting layer over those measurements, not a second geometry pipeline -- intended so a UI "Inspect" view stays a thin presentation layer over this package's existing analysis, rather than a place where new geometry logic accumulates.

## Mesh-health diagnostics

`diagnoseMeshHealth(model, options?)` is a separate, opt-in entry point from `inspectModel`: `inspectModel` stays cheap by design (a handful of bounded example locations per issue kind), so the richer, visualization-ready evidence a UI needs only once a user actually opens a diagnostic -- ordered boundary-loop polylines and larger per-kind issue lists -- lives here instead, computed only when asked for. It is **diagnostic-only**: like `inspectModel`, it never modifies, welds, repairs, or reinterprets the input model's geometry, only reports on it.

It reuses the same placed-geometry walk and topology census as `summarizeModelGeometry` and `inspectModel` -- there is exactly one implementation of that walk and census, shared by all three through `summarizeModelGeometryWithDiagnosticEvidence` in `src/summary.ts`; `diagnoseMeshHealth` adds only loop tracing and bounded selection over that shared evidence, never a second geometry pipeline.

- **`boundaryLoops`**: boundary edges (each touched by exactly one triangle) traced into maximal edge-disjoint chains using the same exact-coordinate vertex keys the topology census already keys edges by (see "Topology semantics" above). Each `BoundaryLoop` reports its ordered `pointsMillimetres`, true `edgeCount`, whether it `closed` (returned to its own starting vertex) or terminated at a dead end instead, its `perimeterMillimetres`, and `pointsTruncated`. A chain terminates rather than closing exactly when it hits a non-manifold boundary vertex (touched by more than two boundary edges); this is reported honestly, never forced into a loop shape or asserted away. `BoundaryLoopSet.loopCount` is the true number of chains found; `loops` is bounded by `maxBoundaryLoops` and a single point budget (`maxBoundaryLoopPoints`) shared across every returned loop in their final sorted order, with `loopsTruncated` set whenever any chain -- whole or partial -- was left out because either budget ran out.
- **`nonManifoldEdges`** and **`inconsistentOrientationEdges`**: each an `EdgeSegmentSet` of bounded `TopologyEdgeSegment` entries (`endpointsMillimetres: [Vec3, Vec3]` plus every contributing `triangleIndices`), one entry per non-manifold or inconsistently-oriented edge, up to `maxIssueItems`, with `count` (the true total) and `truncated`.
- **`degenerateTriangles`**: a `DegenerateTriangleSet` of bounded `TopologyDegenerateTriangle` entries (`triangleIndex` plus all three `positionsMillimetres`), up to `maxIssueItems`, with `count` and `truncated`.

**Determinism.** Boundary chains are traced in a fixed order: vertices with an irregular (not exactly two) incident boundary-edge count are drained first (fully consuming their incident edges before moving to the next vertex), so any edge left over afterward belongs to a vertex-disjoint set of pure degree-two cycles -- vertices are visited ascending by position then vertex key, and at each vertex, edges are walked toward the lexicographically smallest unvisited neighbor position (tie-broken by a stable per-edge ordinal). This fixes the _set_ of chains found for a given input. Each closed loop is then rotated to a canonical form -- start at its lexicographically smallest point (comparing x, then y, then z), walking in whichever of its two directions reaches a lexicographically smaller second point -- and a non-closed chain is instead oriented so its lexicographically smaller endpoint comes first (reversed as a whole, since a path cannot be rotated without changing which edges are adjacent). Loops are finally ordered by descending edge count, then ascending canonical start point, then closed-before-terminated, then a full point-by-point comparison as a last-resort tie-break. `nonManifoldEdges`, `inconsistentOrientationEdges`, and `degenerateTriangles` use the same bounded-during-the-walk collection order `inspectModel`'s topology examples already use (triangle walk order, then `Map` insertion order for edges). Identical input -- including a structurally-identical, separately constructed model -- therefore produces a deeply equal `MeshHealthDiagnosis` every time.

**Bounds.** `maxBoundaryLoops` (default `DEFAULT_MAX_BOUNDARY_LOOPS` = 20, ceiling `MAX_BOUNDARY_LOOPS` = 500) caps how many chains are returned. `maxBoundaryLoopPoints` (default `DEFAULT_MAX_BOUNDARY_LOOP_POINTS` = 2,000, ceiling `MAX_BOUNDARY_LOOP_POINTS` = 50,000) is a single point budget shared across every returned loop; a loop that only partially fits is still returned with `pointsTruncated: true` and its exact `edgeCount`/`closed`/`perimeterMillimetres`. `maxIssueItems` (default `DEFAULT_MAX_ISSUE_ITEMS` = 100, ceiling `MAX_ISSUE_ITEMS` = 2,000) independently bounds the non-manifold-edge, inconsistent-orientation-edge, and degenerate-triangle lists. Every bound throws `RangeError` when out of range rather than silently clamping, matching `InspectOptions`.

**Resource behavior.** `diagnoseMeshHealth` fails closed exactly like `inspectModel`: it validates `model` against `normalizedModelSchema` first, then checks expanded vertex/triangle counts against this package's existing `ANALYSIS_LIMITS.maxExpandedVertices`/`maxExpandedTriangles` ceilings before any O(vertices + triangles) work runs, throwing `InspectionResourceLimitError` if either is exceeded -- it adds no new ceiling, only reuses the package's existing one. Loop tracing itself runs in time proportional to the boundary-edge count (which that ceiling already bounds): each vertex's incident-edge list is sorted once, and traversal advances a per-vertex cursor past already-visited entries rather than rescanning on every step, so total work stays near-linear even at a single vertex touched by many boundary edges. Because tracing a chain honestly requires seeing every boundary edge (a partial view cannot tell a closed loop from a terminated one), `diagnoseMeshHealth` collects the complete boundary-edge set internally before selecting the bounded, sorted `loops` to return -- this is real additional cost beyond `inspectModel`'s bounded examples, which is exactly why it is a separate, opt-in call rather than folded into every `inspectModel` result.

## Clearance and fit checking

`checkClearance(input, options?)` answers "will these two parts fit?": given two parts, each with its own independently supplied placement transform into the comparison frame, and a desired clearance distance in millimetres, it reports collision regions, the minimum surface-to-surface distance (with a measurable closest-point pair), regions below the desired clearance, and exact triangle-pair interference evidence. It is adjacent to the `surface-distance` method, not a second geometry engine: both flatten each model into a comparison-frame `FlatGeometry`, build a `TriangleSpatialIndex` per part, and sample triangle vertices plus centroids against the opposite part's index. The essential difference is placement -- `analyzeModelPair` compares one model against a revision of itself, while `checkClearance` takes each part's own `modelToComparison` (a validated `RigidTransform`) exactly as supplied and never auto-aligns, recenters, or otherwise adjusts either part's position, matching this package's "never silently recenter, rescale, align, repair, or reinterpret geometry" principle.

**Classification rule** (`state`). `minimumDistanceMillimetres` is compared against `desiredClearanceMillimetres`: `interfering` whenever `interference.detectedPairCount > 0` (an exact triangle-triangle intersection was found) OR `minimumDistanceMillimetres === 0` (a sampled point on one surface landed exactly on the other -- e.g. flush, face-to-face contact); otherwise `tight` when `0 < minimumDistanceMillimetres < desiredClearanceMillimetres`; otherwise `clear`.

**Two different kinds of precision live in one result, and the result never blurs them.** `interference.trianglePairs` is exact: each reported pair is confirmed by an exact triangle-triangle intersection test against the actual tessellated surfaces (`src/triangle-triangle.ts`, Moller's separating-plane algorithm with a coplanar 2D fallback for touching or coincident faces), independent of sampling -- an `interfering` state driven by a detected pair is reliable evidence of real overlap. `minimumDistanceMillimetres`, `closestPoints`, and `tightRegions`, in contrast, are sampled exactly the way `surface-distance` is: each sampled distance is itself an exact point-to-triangle nearest-surface query, but only a bounded set of points on each part's own surface -- its triangle vertices and centroids -- are sampled, so a smaller true minimum distance can exist between samples, and a protrusion confined to one coarse triangle's interior can violate the desired clearance without being reported as tight. This is bounded, not just disclosed in prose: `uncertainty.parameters` reports the same per-triangle sample-spacing bound `surface-distance` reports (at most two-thirds of a triangle's longest edge -- `SAMPLE_SPACING_EDGE_FACTOR`), separately for each part and as the pair maximum, and `uncertainty.parameters.undersampled` plus a `clearance.undersampled` warning are set explicitly whenever that bound exceeds the desired clearance -- a `clear` result is never a silent geometric guarantee. Two interpenetrating solids whose surfaces do not happen to cross at a sampled point can show a small positive `minimumDistanceMillimetres` even while `interference.trianglePairs` correctly reports `interfering`; this is expected, not a bug, and is exactly why the triangle-pair evidence -- not the sampled distance -- is the authoritative interference signal.

**No interference volume.** `interference.volume` is always `{ available: false, reason }`. Computing an exact Boolean-intersection volume requires a validated domain, the way `axis-aligned-box-solid` validates two boxes before returning exact volumes; general triangle-mesh parts satisfy no such domain here, and approximating a volume without one would silently misrepresent precision this package does not have. Only concrete intersecting triangle pairs are ever reported as interference evidence -- the honest option, per this package's "select geometry algorithms through adapters with validated preconditions" principle, over a silently approximated number.

**Tight regions.** `tightRegions.regions` groups triangles whose own minimum sampled distance to the opposite part is below the desired clearance, using the exact same exact-coordinate edge connectivity `surface-distance`'s region grouping uses (`groupTrianglesByExactEdgeConnectivity` in `src/region-connectivity.ts`, shared by both -- never a forked copy). Each region reports its `part` (`"first"` or `"second"`), `bounds`, `anchor`, `minimumDistanceMillimetres`, `areaSquareMillimetres`, `triangleCount`, and `triangleIndices`. Regions are ranked ascending by `minimumDistanceMillimetres` (tightest first), tie-broken by descending area, then part, then bounds, then id -- full deterministic tie-breaking, matching `surface-distance`'s region ranking discipline. `tightRegions.detectedRegionCount` is the true total; `truncated` is set whenever the active `maxTightRegions` left any region out, with a `clearance.region-limit` warning naming the omitted count.

**Interference detection.** Candidate triangle pairs are found by querying one part's `TriangleSpatialIndex` for AABB overlap (`TriangleSpatialIndex.overlapping`, a new coarse range-query method -- coarser than an exact per-triangle AABB test since it returns every triangle sharing an overlapping BVH leaf, which can only add extra rejected candidates, never miss a true intersection), then each candidate is confirmed with the exact triangle-triangle test. When the two parts' whole-geometry bounding boxes do not overlap at all, this pass is skipped entirely. The full candidate set is always scanned (never stopped early), so `interference.detectedPairCount` is always the true total; only the bounded, stored `trianglePairs` list stops growing once the active `maxInterferingTrianglePairs` is reached, with `truncated` and a `clearance.interference-pair-limit` warning set exactly like the tight-region list.

**Method/parameters.** `method.id` is `"clearance-fit-check"` (`CLEARANCE_METHOD_ID`), `method.version` is `"1.0.0"` (`CLEARANCE_METHOD_VERSION`), and `method.parameters` echoes the effective `maxTightRegions`/`maxInterferingTrianglePairs`. `semantics` is always `"approximate"` -- see the two-kinds-of-precision paragraph above for exactly which fields that does and does not cover.

**Bounds and resource behavior.** `checkClearance` reuses `ANALYSIS_LIMITS` (expanded vertex/triangle ceilings and the estimated-memory ceiling, via `checkExpandedGeometryBudget`, shared with `analyzeModelPair`) and the same charge-before-work `WorkBudget` used throughout this package: flattening, the mesh precondition census, spatial-index construction, sampled-distance queries, tight-region connectivity, and interference candidate gathering/exact testing are all charged to one budget constructed before any O(vertices + triangles) work runs, so a caller-supplied budget too small to complete fails closed as `indeterminate`/`resource-budget-exceeded` before the corresponding pass runs -- exactly like `analyzeModelPair`. `maxTightRegions` (default `DEFAULT_MAX_TIGHT_REGIONS` = 200, ceiling `MAX_TIGHT_REGIONS` = `ANALYSIS_LIMITS.maxReportedRegions` = 2,048, the same ceiling `surface-distance`'s `maxRegions` parameter enforces) and `maxInterferingTrianglePairs` (default `DEFAULT_MAX_INTERFERING_TRIANGLE_PAIRS` = 200, ceiling `MAX_INTERFERING_TRIANGLE_PAIRS` = 2,048 -- a genuinely new bound this module adds, since `analyzeModelPair` has no triangle-pair evidence of its own) are the only new bounds; an out-of-range value throws `RangeError` (matching `InspectOptions`/`MeshHealthOptions`) since that is a caller programming error, not a data-driven failure. `desiredClearanceMillimetres` must be finite and non-negative (zero is valid and means "must not touch"); an invalid value returns `indeterminate`/`invalid-desired-clearance`. Each part's `modelToComparison` is validated as a proper rigid transform (`rigidTransformSchema` -- no scale, shear, or reflection) before use.

**Determinism.** Identical `model`/`modelToComparison`/`desiredClearanceMillimetres`/`options` input produces a deeply equal `ClearanceCheckResult` every time: sampling walks each part's own triangle order, region grouping and ranking use full deterministic tie-breaking, and interference candidate gathering/testing walks triangles and AABB-overlap candidates in a fixed order.

## Resource behavior

The package validates model and request contracts before analysis. It expands assembly instances into the comparison frame without recentering, rescaling, alignment, repair, or reinterpretation. The flattened comparison-frame geometry is held in typed arrays (packed vertex positions and triangle indices), not per-vertex or per-triangle objects. A single charged work budget is constructed before any expansion work runs and covers the full pipeline: flattening assembly instances into that buffer, the manifold edge census, spatial-index construction, spatial traversal, exact triangle tests, and connectivity work; reported regions are bounded separately. A caller-supplied budget too small to complete this work fails closed before the corresponding pass runs rather than after. The current implementation ceilings are 3,000,000 expanded vertices, 1,000,000 expanded triangles, 768 MiB of estimated working memory, and 2,200,000,000 charged work units. A request may impose smaller execution budgets. Unsupported methods, failed method preconditions, exhausted budgets, and out-of-range numeric calculations fail closed as `indeterminate` outcomes. `numeric-range-exceeded` is reserved for failures the code itself detects as a genuine numeric-range problem (for example, a computed distance overflowing to a non-finite value); any other unexpected exception during analysis fails closed as `internal-error` instead, so a real defect is never misreported as an input-magnitude problem it did not cause.

These ceilings are implementation safety limits, not model-size support claims or memory reservations. Browser clients should expose conservative request budgets because available memory and practical runtime vary by device. Production accuracy and device tiers still require accepted fixtures and browser benchmarks.

The charged work-unit ceiling is calibrated so the documented triangle ceiling is actually reachable, not just declared: measured against the scaling benchmark tiers (`bench/scaling.mjs`, including its `--large` documented-ceiling tier), a pair totalling the documented 1,000,000 combined triangles charges roughly 1.91 billion work units to complete `surface-distance`, in under a minute of wall-clock time on a single machine and well inside the memory ceiling. 2,200,000,000 keeps roughly 15% measured margin above that figure.

The estimated-memory ceiling's per-element accounting (`BYTES_PER_VERTEX`/`BYTES_PER_TRIANGLE` in `src/analyze.ts`) is deliberately a relative/structural cost model with a stated safety margin, not a byte-exact prediction that every possible single-sample heap reading stays under -- measurement against the same benchmark showed a byte-exact reading is not achievable without either breaking the documented ceilings or rejecting geometry this package already accepts. Two independent, measured reasons drove that choice: vertex-to-triangle ratio is shape-dependent (an indexed mesh with shared vertices has roughly 0.5 vertices per triangle; a facet-local mesh -- one private vertex copy per triangle corner, as binary STL import commonly produces -- has exactly 3, a 6x difference at identical triangle count, so a multiplier conservative enough for the benchmark's indexed terrain tiles would push an existing accepted facet-local test case past its request budget), and single-sample `heapUsed` deltas at small-to-mid scale vary by up to roughly 4x across repeated runs of byte-identical geometry, tracking V8 garbage-collector scheduling rather than a stable per-element cost. A margin wide enough to cover either would make the documented triangle ceiling's worst case (3,000,000 vertices, the facet-local case, at 1,000,000 triangles) exceed the 768 MiB ceiling. The chosen margin (1.5x the exact structural byte count) instead keeps that worst case comfortably under budget and stays conservative at and near the documented ceiling -- the scale where the memory ceiling's protection is load-bearing -- while smaller tiers can still show a noisy, informational, harmless excess given the trivial absolute memory involved. See `src/analyze.ts`'s constant comments and the benchmark section below for the full reasoning and numbers.

## Benchmark

`bench/scaling.mjs` is a manually-run measurement script, not a test -- it never runs under `pnpm test` or `pnpm check`, so it cannot slow CI down. It measures `analyzeModelPair`'s `surface-distance` method against seeded, deterministic synthetic model pairs (a tessellated 3D terrain panel with a single deliberately raised region in the candidate) at several sizes, and reports, per tier:

- Baseline+candidate combined triangle and vertex counts and detected changed-region count.
- Median wall-clock milliseconds across a few in-process iterations (the last iteration is also the one measured for memory).
- The documented **estimated** working memory for that tier (`vertices * 36 + triangles * 450` bytes, mirroring the constants documented above and in `src/analyze.ts`'s `BYTES_PER_VERTEX`/`BYTES_PER_TRIANGLE`).
- The **measured** peak heap delta (`process.memoryUsage().heapUsed` sampled immediately before and after the call), and whether it stayed within the estimate (PASS) or exceeded it (WARN).
- A scaling summary in milliseconds per 1,000 combined triangles, so a superlinear regression between tiers is visible at a glance.

It also runs two fixed, cheap robustness checks: a repeatability check (the same seeded tier run twice in one process must produce byte-identical outcomes), and a fail-closed check (a deliberately tiny `executionBudget.maxWorkUnits` on a non-trivial-scale pair must return an `indeterminate`/`resource-budget-exceeded` result in milliseconds, not hang or exhaust memory).

Run it with:

```sh
node --expose-gc packages/analysis/bench/scaling.mjs            # default tiers, roughly 1k/10k/50k triangles per side
node --expose-gc packages/analysis/bench/scaling.mjs --large    # also runs the ~200k tier and the documented-ceiling
                                                                  # tier (1,000,000 combined triangles; roughly a
                                                                  # minute on its own)
pnpm --filter @voxelspy/analysis bench                          # same as the first form
```

`--expose-gc` is optional but strongly recommended: without it, memory numbers are raw, un-forced `heapUsed` deltas, and the script labels them unreliable instead of reporting GC noise as if it were a measurement.

**These are single-machine, single-Node.js-process measurements.** They are not browser measurements, not device-tier claims, and not a substitute for the browser and hostile-input benchmarks called for elsewhere in this project's plan. A result here says only what happened on the machine that ran it.

Two findings this benchmark previously surfaced have been investigated and addressed (see `src/analyze.ts`'s `BYTES_PER_VERTEX`/`BYTES_PER_TRIANGLE` and `ANALYSIS_LIMITS.maxWorkUnits` comments for the full reasoning); the benchmark itself now demonstrates and guards both:

- **Memory estimate.** Small/mid tiers can still show measured heap exceeding the documented estimate (rows marked WARN below roughly the ~200k tier) -- repeated runs of byte-identical geometry showed that spread is GC-scheduling noise, not a stable per-element cost, and it is harmless at those absolute magnitudes (low tens of MiB at most). What matters is the documented-ceiling tier (`--large`, 1,000,000 combined triangles, the scale where the 768 MiB ceiling is load-bearing): as of this writing it measures well within the estimate (see the benchmark's "Documented-ceiling check" line), and the script treats a regression there as a hard failure.
- **Charged work-unit ceiling.** `ANALYSIS_LIMITS.maxWorkUnits` is calibrated with measured margin (see above) so the documented 1,000,000-triangle ceiling completes under the _default_ execution budget -- no caller override needed. The `--large` documented-ceiling tier is the concrete evidence: it now reaches `state: "complete"`, and the script treats it returning `resource-budget-exceeded` as a hard failure, not just a printed finding.

## Example

```ts
import { analyzeModelPair } from "@voxelspy/analysis";

const result = analyzeModelPair({ request, baseline, candidate });
if (result.outcome.state === "complete") {
  for (const regionId of result.outcome.orderedRegionIds) {
    // Regions are already ranked deterministically.
    console.log(regionId);
  }
}
```

```ts
import { inspectModel } from "@voxelspy/analysis";

const inspection = inspectModel(model);
console.log(inspection.watertightness); // { state: "closed" } | { state: "not-closed", reasons: [...] } | ...
for (const finding of inspection.topologyFindings) {
  console.log(finding.severity, finding.summary, finding.examples);
}
```

```ts
import { diagnoseMeshHealth } from "@voxelspy/analysis";

// Called only once a user opens a diagnostic -- not on every inspection.
const diagnosis = diagnoseMeshHealth(model);
for (const loop of diagnosis.boundaryLoops.loops) {
  console.log(
    loop.closed ? "closed loop" : "open chain",
    loop.pointsMillimetres,
  );
}
for (const segment of diagnosis.nonManifoldEdges.segments) {
  console.log(segment.endpointsMillimetres, segment.triangleIndices);
}
```

```ts
import { checkClearance } from "@voxelspy/analysis";

// Each part is placed independently and deliberately -- never auto-aligned.
const fit = checkClearance({
  first: { model: bracket, modelToComparison: bracketPlacement },
  second: { model: pin, modelToComparison: pinPlacement },
  desiredClearanceMillimetres: 0.2,
});
if (fit.state !== "indeterminate") {
  console.log(fit.state, fit.minimumDistanceMillimetres, fit.closestPoints);
  for (const region of fit.tightRegions.regions) {
    console.log(region.part, region.minimumDistanceMillimetres, region.bounds);
  }
  for (const pair of fit.interference.trianglePairs) {
    console.log(pair.firstTriangleIndex, pair.secondTriangleIndex);
  }
}
```
