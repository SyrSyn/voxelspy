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

## glTF 2.0 / GLB inputs (static mesh geometry only)

`importModel` also accepts `.gltf` (plain JSON, with every buffer embedded as a base64 `data:` URI) and `.glb` (the binary container: a 12-byte header, one JSON chunk, and an optional second chunk holding buffer 0's bytes). Only static mesh geometry is in scope -- see `spikes/phase-1/EVIDENCE.md` for the accepted boundary this importer implements.

**Supported.** `POSITION` accessors (`FLOAT` `VEC3` only); `mode: 4` (`TRIANGLES`) primitives, indexed (`UNSIGNED_BYTE`/`UNSIGNED_SHORT`/`UNSIGNED_INT`) or non-indexed (vertices are read as sequential triangles); multiple primitives per mesh and multiple meshes; and a full node hierarchy with either a `matrix` or `translation`/`rotation`/`scale` transform per node.

**Frame resolution is FROM THE FORMAT, not defaulted.** glTF declares metres and right-handed Y-up by specification, so import never returns `needs-input` for these formats and never requires `declaredUnit`/`declaredAxis`: `provenance.detectedSourceUnit`/`detectedSourceAxis` are always `"metre"`/`"right-handed-y-up"`, and `sourceResolution` is `"embedded"` unless overridden. A `userUnit`/`userAxis` (or `declaredUnit`/`declaredAxis`) request option still overrides the embedded declaration -- recorded as `"user"`/`"declared"` in `sourceResolution` -- and, because that overrides an authoritative value the file itself supplied, also raises the same `user-source-frame` warning STL/OBJ raise only for an explicit user correction.

**Placement is a hierarchy, not flattened.** Unlike STL/OBJ (always `placement: { kind: "flat" }`, one mesh, one instance), a glTF import produces `placement: { kind: "hierarchy" }`: every glTF node becomes one assembly node, keeping its own authored transform completely unconverted (still in the file's own metre/Y-up numbers). Two synthetic ancestor nodes are added above the file's own scene roots -- `node.gltf.root` (identity, satisfying the contract's rule that hierarchy roots use an identity transform) and `node.gltf.frame` (carrying exactly `sourceToModelTransform(sourceUnit, sourceAxis)`, the same conversion STL/OBJ apply per vertex). Composing the frame conversion once, at the top of the hierarchy, means every mesh and every real glTF node's transform is stored exactly as authored; only the resolved world transform for a given instance lands in the canonical millimetre, right-handed-Z-up frame.

**Scene selection.** The document's default scene (`scene`, or the sole entry of `scenes` when there is exactly one) is imported. When the default scene is ambiguous (multiple `scenes`, no `scene` index) or entirely absent, every node that is nobody's child (scanned across the whole `nodes` array) is treated as a root -- a deliberate, documented fallback for minimal or library-style assets that declare `nodes`/`meshes` without a `scenes` array, never a guess about any single node's own geometry or transform.

**Explicit rejections -- every one fails the import outright, never silently:**

- Animations; skins (`skins`, `node.skin`); morph targets (`primitive.targets`, `mesh.weights`, `node.weights`).
- Any `extensionsRequired` entry, named in the failure message -- this importer implements no glTF extension.
- Any primitive `mode` other than `4` -- including `5`/`6` (`TRIANGLE_STRIP`/`TRIANGLE_FAN`) -- named by number and name. Strip/fan topologies are deliberately never converted to an indexed triangle list, since doing so would silently change connectivity.
- Sparse accessors, and any accessor with no `bufferView` (e.g. one an unsupported extension would otherwise populate).
- Any component type other than `FLOAT` for `POSITION`, or other than the three unsigned integer types for indices; `JOINTS_0`/`WEIGHTS_0` primitive attributes (skinning, even without `node.skin`); a `normalized` accessor.
- Any buffer or image reference that is not an embedded `data:` base64 URI or (buffer 0 of a GLB only) the binary chunk -- refused even for images, whose content this importer never reads, so an external reference can never be silently ignored.
- A malformed GLB container: wrong magic number; an unsupported version; a declared total or chunk length that does not match the actual bytes; a non-4-byte-aligned, mistyped, or misordered chunk; unexpected trailing bytes.
- A malformed document: invalid JSON; a missing or non-`"2.x"` `asset.version`; an out-of-range buffer/bufferView/accessor/node/mesh reference; an accessor or bufferView span that overruns its buffer's actual byte length; an index value beyond `POSITION`'s vertex count; a non-indexed or indexed primitive whose index count is not a multiple of 3.
- A document with no static mesh geometry reachable from its selected scene.

**Ignored, but always reported as a warning naming what was dropped:**

- Non-required `extensionsUsed` entries (`gltf-extension-ignored`).
- Materials, textures, images, samplers, and cameras, none of which affect geometry output (`gltf-decorative-data-ignored`, with per-category counts).
- Non-`POSITION` vertex attributes such as `NORMAL`, `TEXCOORD_0`, `COLOR_0`, and `TANGENT` (`gltf-attributes-not-evaluated`).

**Bounds.** glTF/GLB import reuses this package's existing `IMPORTER_SAFETY_LIMITS` (32 MiB input, 500,000 triangles, 1,500,000 vertices) plus the caller's own `options.limits.triangleCount`, both checked cumulatively across every primitive in the document. Every accessor's declared `count`, `byteOffset`, and `byteStride` is validated against its bufferView's ACTUAL byte length -- itself validated against its buffer's actual decoded byte length -- before any `Float64Array`/`Uint32Array` is allocated: because the whole input is already capped at 32 MiB, an attacker-declared accessor `count` in the billions is rejected by plain arithmetic, at zero allocation cost, rather than by attempting (and failing) a huge allocation. Base64 data URIs are decoded with the platform `atob`, consistent with this package's existing browser-platform-API assumption (`TextDecoder`, `crypto.subtle`, `DataView`) -- no Node-specific API is used.

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

OBJ polygon fan triangulation is deterministic but may not represent arbitrary concave or non-planar polygons as their author intended; every occurrence produces a warning. OBJ materials, smoothing, normals, and texture coordinates do not affect geometry output and are reported when encountered. glTF/GLB static mesh geometry and node-hierarchy assemblies are supported for import as described above; glTF/GLB export, animations, skins, morph targets, materials/colors/textures, curves, free-form surfaces, 3MF, and STEP remain unsupported by this package version.

All parsing, serializing, and hashing use browser platform APIs. Normal import and export do not fetch or transmit model data.
