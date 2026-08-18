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

The package validates model and request contracts before analysis. It expands assembly instances into the comparison frame without recentering, rescaling, alignment, repair, or reinterpretation. The flattened comparison-frame geometry is held in typed arrays (packed vertex positions and triangle indices), not per-vertex or per-triangle objects. A single charged work budget is constructed before any expansion work runs and covers the full pipeline: flattening assembly instances into that buffer, the manifold edge census, spatial-index construction, spatial traversal, exact triangle tests, and connectivity work; reported regions are bounded separately. A caller-supplied budget too small to complete this work fails closed before the corresponding pass runs rather than after. The current implementation ceilings are 3,000,000 expanded vertices, 1,000,000 expanded triangles, 768 MiB of estimated working memory, and 76,800,000 charged work units. A request may impose smaller execution budgets. Unsupported methods, failed method preconditions, exhausted budgets, and out-of-range numeric calculations fail closed as `indeterminate` outcomes. `numeric-range-exceeded` is reserved for failures the code itself detects as a genuine numeric-range problem (for example, a computed distance overflowing to a non-finite value); any other unexpected exception during analysis fails closed as `internal-error` instead, so a real defect is never misreported as an input-magnitude problem it did not cause.

These ceilings are implementation safety limits, not model-size support claims or memory reservations. Browser clients should expose conservative request budgets because available memory and practical runtime vary by device. Production accuracy and device tiers still require accepted fixtures and browser benchmarks.

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
