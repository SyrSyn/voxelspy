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

## 3MF Core inputs (mesh geometry only)

`importModel` also accepts `.3mf`: a ZIP (OPC -- Open Packaging Conventions) container whose `3D Model` part is an XML document in the 3MF Core namespace. Only the Core mesh-geometry subset is in scope -- Materials, Colours, Beam Lattice, Slice, and Production extension content is either ignored (with a warning) or rejected explicitly, never silently reinterpreted.

**Container reading is independent of `@voxelspy/session-archive`.** That package is deliberately stored-only (never decompresses anything) as a security property of the portable-session format, so it must never grow a deflate code path. Real-world 3MF files are ordinary ZIP archives and are commonly deflate-compressed, so this package (`src/zip.ts`) implements its own narrow, defensive ZIP/OPC reader using the platform's built-in `DecompressionStream("deflate-raw")` -- no new dependency, no hand-rolled inflate.

**Unit resolution is FROM THE FORMAT.** Every 3MF Core document declares (or, absent a `unit` attribute, spec-defaults to `"millimeter"`) its own unit via `<model unit="...">`. This is therefore an "embedded" resolution exactly like glTF's fixed metre declaration: `provenance.detectedSourceUnit`/`sourceUnit` reflect the file's own declaration and `sourceResolution.unit` is `"embedded"` unless overridden by `declaredUnit` or `userUnit`. The six 3MF unit tokens map onto this package's unit vocabulary as `micron`→micrometre, `millimeter`→millimetre, `centimeter`→centimetre, `inch`→inch, `foot`→foot, `meter`→metre; any other token fails closed as `invalid-input`.

**Coordinate convention is right-handed Z-up, per the specification, not assumed.** The 3MF Core Specification, §3.1 "Coordinate Space", states: _"Coordinates in this specification are based on a right-handed coordinate space. Producers and consumers MUST define and map the origin of the coordinate space to the bottom-front-left corner of the device's output field (such as a tray, platform, or bed), with the x-axis increasing to the right of the output field, the y-axis increasing to the back of the output field, and the z-axis increasing to the top of the output field."_ Z increasing "to the top of the output field" is up. This importer therefore resolves 3MF's axis as `"right-handed-z-up"` -- also an embedded (format-declared) resolution, never defaulted or requested from a caller -- and applies exactly `sourceToModelTransform(sourceUnit, "right-handed-z-up")` at the top of the imported hierarchy, the same mechanism glTF's `right-handed-y-up` embedded resolution uses.

**Placement is a hierarchy**, built the same way as glTF's: every 3MF `<build><item>` becomes one child of a synthetic `node.3mf.frame` (carrying the unit/axis conversion), and every `<components><component>` reference becomes a nested child node, each keeping its own authored `transform` attribute completely unconverted (still in the file's own unit). 3MF's `transform` attribute is 12 row-major numbers `m00 m01 m02 m10 m11 m12 m20 m21 m22 m30 m31 m32`, applied to a point as `p' = p * M` (row-vector convention: row 0 is the image of the local X axis, row 1 of Y, row 2 of Z, row 3 the translation). This package's `Mat4` is column-major and applied as `p' = M * p`. For a pure affine matrix these conventions are related by a transpose, so storing the SAME 12 numbers in the SAME order -- inserting a `0` after each 3x3 row and a trailing `1` -- produces exactly `M^T`, the correct column-vector matrix for the identical physical transform. `test/threemf.test.ts` pins this with a worked +90 degree rotation about Z (`transform="0 1 0 -1 0 0 0 0 1 0 0 0"`) and a translation-composition case through a build item and a nested component.

**Explicit rejections -- every one fails the import outright:**

- **Container/OPC structure**: encrypted entries; unsupported ZIP compression methods (only stored and deflate are accepted); ZIP64 fields; multi-disk archives; streamed entries using a trailing data descriptor; duplicate or path-traversing entry names (absolute paths, backslashes, `.`/`..` segments, control characters); overlapping entry payload byte ranges; disagreement between an entry's local and central-directory headers; a ZIP comment or trailing bytes after the declared archive end; a missing `_rels/.rels`, a root relationship that does not name exactly one 3D-model part, an `External` `TargetMode`, a missing `[Content_Types].xml`, or a declared 3D-model part whose content type does not match `application/vnd.ms-package.3dmanufacturing-3dmodel+xml`; a declared model part not actually present in the archive.
- **XML safety**: `<!DOCTYPE>`/`<!ENTITY>` and any other markup declaration; any XML entity other than the five predefined entities and numeric character references; processing instructions outside the leading `<?xml ... ?>` prolog; element nesting or total node/attribute counts beyond this package's fixed safety limits; malformed or unterminated markup.
- **Model semantics**: any `requiredextensions` token (named in the failure message); the Beam Lattice extension; a Production-extension `path` attribute on `<item>`/`<component>` (a cross-part reference this importer does not resolve); an `<object>` declaring neither or both of `<mesh>`/`<components>`; an unrecognized `type` value; a `<build>`/`<component>` reference to a missing object id; a reference (direct or through a component) to an object of type `"other"`; a cycle in component references; a triangle vertex index beyond its mesh's vertex count; fewer than 3 vertices in a mesh; an empty `<build>`.

**Ignored, but always reported as a warning naming what was dropped (`3mf-decorative-data-ignored`):** `<metadata>`; `<basematerials>` and `pid`/`pindex` material/colour assignments; `thumbnail` attributes; `name`/`partnumber` labels. Unrecognized resource/build elements and namespaced extension content are reported separately (`3mf-resource-ignored`, `3mf-extension-ignored`), and resource objects unreachable from any `<build><item>` are reported as `3mf-unreferenced-objects`.

**Decompression bounds.** `src/zip.ts` bounds decompression INCREMENTALLY: compressed input is fed to `DecompressionStream` in small (4096-byte) writes, and output is checked against the caps below after every chunk the stream produces -- never after attempting to materialize a whole entry's expansion. A decompression bomb therefore fails with a `resource-limit` error after at most a small, bounded amount of output has been produced and held in memory (`test/threemf.test.ts` proves this directly: ~20,000,000 bytes of zeros compress to well under 20 KB, and the bounded reader aborts within milliseconds, long before the full expansion could ever be produced). The bounds, in `IMPORTER_SAFETY_LIMITS.archive` (a caller's `options.limits.archive` may only tighten these, never loosen them, mirroring the existing triangle-limit convention):

- maximum ZIP entry count: 512;
- maximum decompressed bytes for any single entry: 64 MiB;
- maximum decompressed bytes summed across every entry actually read: 128 MiB;
- maximum (decompressed / compressed) ratio for any single entry: 300.

Beyond the archive layer, `IMPORTER_SAFETY_LIMITS.threeMfXml` bounds the hand-rolled XML parser (`src/xml.ts`): element nesting depth (64), total element count (200,000), attributes per element (64), and attribute value length (1,000,000 characters) -- checked before each new element/attribute is accepted, so a document crafted to nest deeply or hold many attributes fails fast rather than after building a large tree. `IMPORTER_SAFETY_LIMITS.threeMfHierarchyNodes` (50,000) separately bounds how many synthetic hierarchy nodes `<build>`/`<component>` unrolling may generate, independent of the geometry triangle/vertex ceilings every format shares.

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

OBJ polygon fan triangulation is deterministic but may not represent arbitrary concave or non-planar polygons as their author intended; every occurrence produces a warning. OBJ materials, smoothing, normals, and texture coordinates do not affect geometry output and are reported when encountered. glTF/GLB and 3MF Core static mesh geometry and node-hierarchy assemblies are supported for import as described above; glTF/GLB and 3MF export, animations, skins, morph targets, materials/colors/textures, curves, free-form surfaces, 3MF extensions (Beam Lattice, Slice, Production, Materials/Colours), and STEP remain unsupported by this package version.

All parsing, serializing, and hashing use browser platform APIs. Normal import and export do not fetch or transmit model data.
