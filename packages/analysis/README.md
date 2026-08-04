# `@voxelspy/analysis`

Deterministic, bounded geometry comparison over normalized VoxelSpy models. The package consumes `@voxelspy/contracts` values, keeps geometry work independent of UI and browser APIs, and returns validated, serializable analysis results.

## Methods

### `surface-distance` 1.0.0

This adapter samples every triangle's vertices and centroid, measures each sample against the opposite tessellated surface, groups adjacent changed triangles, and ranks regions by maximum distance followed by affected area. It requires a distance tolerance. `parameters.maxRegions` may limit the reported ranked regions to a positive integer no greater than 2,048; truncation produces an explicit warning and uncertainty count.

The result is always **approximate**, including when sampled distance is zero. Finite samples can miss extrema, topology is inferred from shared indices, and both values and regions depend on tessellation. This is not an exact Hausdorff-distance implementation.

### `axis-aligned-box-solid` 1.0.0

This adapter decomposes the set difference of two boxes into disjoint cells and returns exact volume metrics within a deliberately narrow validated domain. Each comparison-frame input must be one closed, consistently oriented, indexed axis-aligned box with exactly eight corner vertices and twelve non-degenerate triangles. It accepts no method parameters.

The result is **exact within those validated preconditions**. Other closed solids, rotated boxes, duplicate-per-face vertices, general Boolean operations, and repaired geometry return `indeterminate`; the adapter never falls through to a different method.

## Resource behavior

The package validates model and request contracts before analysis. It expands assembly instances into the comparison frame without recentering, rescaling, alignment, repair, or reinterpretation. Built-in ceilings bound expanded vertices, triangles, estimated working memory, point-triangle work, and reported regions. A request may impose smaller execution budgets. Unsupported methods, failed method preconditions, exhausted budgets, and out-of-range numeric calculations fail closed as `indeterminate` outcomes.

These ceilings are implementation safety limits, not model-size support claims. Production accuracy and device tiers still require accepted fixtures and browser benchmarks.

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
