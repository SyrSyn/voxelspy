# `@voxelspy/importers`

Browser-local mesh loading for VoxelSpy's accepted import and normalized-geometry contracts.

## Supported inputs

- ASCII STL with strict facet structure
- Binary STL with an exact header-declared byte length
- OBJ vertices and faces, including negative vertex indices and explicit fan triangulation of polygon faces

STL and OBJ do not contain authoritative units or up-axis metadata. Import therefore returns `needs-input` unless the request supplies `declaredUnit`/`declaredAxis` or explicit `userUnit`/`userAxis` corrections. The selected source frame, its origin, and the exact source-to-model transform are retained in provenance. Coordinates are converted to millimetres and right-handed Z-up, but are never recentered, aligned, rescaled by heuristics, repaired, or deduplicated.

```ts
import { importModel } from "@voxelspy/importers";

const result = await importModel({
  contractVersion: 1,
  targetModelId: "model.baseline",
  format: "stl",
  sourceName: "baseline.stl",
  bytes,
  options: {
    userUnit: "millimetre",
    userAxis: "right-handed-z-up",
    limits: { inputBytes: 32_000_000, triangleCount: 250_000 },
  },
});
```

Successful imports contain full-span `Float64Array` position buffers, full-span `Uint32Array` index buffers, a SHA-256 source digest, warnings, notes, flat placement, and source-frame provenance validated by `@voxelspy/contracts`.

## Limits and refusal behavior

The package enforces caller-provided limits plus fixed safety ceilings of 32 MiB input, 500,000 output triangles, and 1,500,000 OBJ vertices. Exceeded limits return `resource-limit`. Invalid syntax, non-finite coordinates, out-of-range references, truncated or trailing binary STL data, external OBJ material libraries, and unsupported OBJ statements fail closed. Degenerate triangles are preserved and reported rather than silently repaired.

OBJ polygon fan triangulation is deterministic but may not represent arbitrary concave or non-planar polygons as their author intended; every occurrence produces a warning. OBJ materials, smoothing, normals, and texture coordinates do not affect geometry output and are reported when encountered. Assemblies, materials, colors, curves, free-form surfaces, external resources, 3MF, glTF/GLB, and STEP are not supported by this package version.

All parsing and hashing use browser platform APIs. Normal import does not fetch or transmit model data.
