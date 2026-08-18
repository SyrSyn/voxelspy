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

Closedness, orientation consistency, non-manifold detection, and region connectivity all key triangle edges by exact vertex **coordinate**, never by raw vertex index: two triangle corners are treated as the same point, and their shared edge as connected, only when their coordinates are bit-for-bit identical. No tolerance-based welding happens anywhere in this package. This is uniform across `MeshAssessment` (the `assessGeometry` step behind every `validation` entry on an `AnalysisResult`), the `surface-distance` method's exact-edge region connectivity, and `summarizeModelGeometry`'s topology and volume evidence, so a facet-local mesh -- one private vertex copy per triangle corner, the representation binary STL import commonly produces -- that is geometrically watertight is recognized as closed consistently by all three. Index-level topology (whether two triangles happen to reuse the same vertex index) is not what validation, connectivity, or the summary report.

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
