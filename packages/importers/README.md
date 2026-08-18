# `@voxelspy/importers`

Browser-local mesh format input and output for VoxelSpy's normalized-geometry contracts: importing accepted formats into a `NormalizedModel` (`@voxelspy/contracts`), and exporting a `NormalizedModel` back to bytes for those same formats. Format reading and writing live in one package because they share one frame model, one safety-limit philosophy, and one round-trip guarantee -- an export this package writes is always accepted back by this package's own import, unchanged.

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

## Exporting models

`exportModel` serializes a `NormalizedModel` to bytes for one of three targets: `"stl-binary"`, `"stl-ascii"`, or `"obj"` -- exactly the vertex/face subset `importModel` reads back, so `exportModel` then `importModel` is a closed round trip. Nothing this function writes is ever a construct this package's own importer would refuse.

```ts
import { exportModel } from "@voxelspy/importers";

const result = await exportModel(model, {
  targetFormat: "stl-binary",
  targetUnit: "millimetre",
  targetAxis: "right-handed-z-up",
});

// result.bytes, result.digest, result.geometry.{triangleCount,vertexCount},
// result.appliedModelToTarget, result.warnings, result.notes
```

**Frame handling is explicit, not defaulted.** The normalized model is always in the canonical frame (millimetres, right-handed Z-up). `targetUnit` and `targetAxis` are required options with no default: `exportModel` never emits canonical-frame numbers under an unrequested label, and never guesses an output frame. The exact transform applied to every coordinate is returned as `appliedModelToTarget` -- the precise algebraic inverse of the transform an import declaring the same `userUnit`/`userAxis` would apply back. Because neither STL nor OBJ has any field for unit or axis metadata, that choice does not survive inside the file bytes: `result.warnings` always includes an `export.unit-not-declared` entry saying so, and re-importing the file requires supplying the same unit and axis again as `userUnit`/`userAxis`.

**Flattening.** STL and OBJ have no representation for multiple meshes or multiple instances of one mesh. Every placement instance (flat `meshToModel`, or a hierarchy's `meshToNode` composed with each ancestor's `localToParent`) is resolved to one world transform and written into a single triangle soup. Whenever the model has more than one mesh or more than one instance, an `export.instances-flattened` warning names the counts -- this package never claims to preserve assembly structure a target format cannot express.

**Determinism.** Every coordinate is formatted with the same rule (below); triangles are visited in a fixed order (instance array order, then each mesh's own index order); the binary STL header is a fixed 84-byte constant, never a timestamp. Two calls with a deeply-equal model and options produce byte-identical output and an identical digest.

**Number formatting and round-trip exactness.** Every coordinate is written with `value.toString()` -- ECMA-262's `Number::toString`, the shortest decimal (or exponential, for extreme magnitudes) string that reads back, via `Number(...)`, to the exact same `Float64` value. This is locale-independent (unlike `toLocaleString`) and never truncates or pads precision (unlike `toFixed`). Because of this, `exportModel` then `importModel` is **bit-exact** for ASCII STL and OBJ whenever `targetUnit` is `"millimetre"` (any `targetAxis`: the Z-up/Y-up conversion is a sign flip and a coordinate permutation, never a multiply). For any other `targetUnit`, expect equality only to ordinary IEEE-754 double-precision tolerance (a few ULPs): dividing a millimetre value by a non-power-of-two unit scale factor (e.g. 25.4 for inch) and multiplying it back on re-import is not guaranteed to be an exact inverse -- that residual comes from the unit-conversion arithmetic itself, not from text formatting. **Binary STL is lossier still**: it stores each coordinate as an IEEE-754 `float32`, so its round trip is bounded by float32's relative precision (`2^-23`, about `1.2e-7`) regardless of unit -- documented and tested in `test/export.test.ts`.

**Provenance and honesty.** Alongside `bytes`, every export reports the target format, `appliedModelToTarget`, the resolved `targetUnit`/`targetAxis`, `geometry.{triangleCount,vertexCount}` for what was actually written, and a SHA-256 `digest`. `warnings` always includes the unit/axis-not-declared entry above, plus (when applicable) `export.instances-flattened` and `export.degenerate-facet-normals` (a zero vector was written for a triangle with zero area after the output transform, since no normal could be computed). `notes` records informational context: STL facet normals are always computed geometrically from vertex winding order (the normalized model retains no original per-facet normal data to write instead), and OBJ output never references a material library.

## Limits and refusal behavior

Import enforces caller-provided limits plus fixed safety ceilings of 32 MiB input, 500,000 output triangles, and 1,500,000 OBJ vertices. Exceeded limits return `resource-limit`. Invalid syntax, non-finite coordinates, out-of-range references, truncated or trailing binary STL data, external OBJ material libraries, and unsupported OBJ statements fail closed. Degenerate triangles are preserved and reported rather than silently repaired.

Export enforces the same fixed ceilings (`EXPORTER_SAFETY_LIMITS`, 500,000 triangles and 1,500,000 vertices), checked against the FLATTENED (post-instancing) geometry by cheap arithmetic over each mesh's existing buffer lengths -- before any output buffer is allocated -- and throws `ExportResourceLimitError` if exceeded: a file this package's own importer would refuse on the way in is not a file this package will produce on the way out. `exportModel` also validates the input model against `normalizedModelSchema` and throws `ExportUnsupportedTargetError` for an unrecognized `targetFormat` or `ExportInputError` for an invalid `targetUnit`/`targetAxis` or geometry that flattens to zero triangles.

OBJ polygon fan triangulation is deterministic but may not represent arbitrary concave or non-planar polygons as their author intended; every occurrence produces a warning. OBJ materials, smoothing, normals, and texture coordinates do not affect geometry output and are reported when encountered. Assemblies, materials, colors, curves, free-form surfaces, external resources, 3MF, glTF/GLB, and STEP are not supported by this package version, for either import or export.

All parsing, serializing, and hashing use browser platform APIs. Normal import and export do not fetch or transmit model data.
