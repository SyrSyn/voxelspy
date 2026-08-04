# Geometry and format evidence spike

Status: evidence only. The contracts and import probes in this directory are intentionally non-final and are not public application APIs.

This spike tests whether common mesh inputs and the output of a STEP tessellator can be represented as explicit millimetre, right-handed Z-up typed-array geometry without discarding source units, coordinate transforms, warnings, provenance, or serializable assembly structure. It also demonstrates why comparison methods need validated preconditions and explicit result semantics.

## Run the evidence

From this directory:

```sh
pnpm install --ignore-workspace --frozen-lockfile
pnpm check
pnpm evidence
```

`pnpm build` recomputes and canonically formats the evidence, then requires [`evidence/results.json`](evidence/results.json) to match it byte for byte. No model data is fetched or transmitted.

## Covered behavior

| Input                   | Evidence exercised                                                                                                          | Deliberate limit                                                                                                    |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| ASCII and binary STL    | Equivalent triangle soup, caller-declared unit/axis, typed arrays                                                           | STL has no standard unit or up-axis field; missing declarations produce warnings                                    |
| OBJ                     | Vertices, positive/negative face indices, polygon fan triangulation                                                         | Materials, smoothing, curves, and free-form surfaces are not evaluated                                              |
| 3MF Core                | Stored ZIP entries, model units, aggregate triangle budget, triangle meshes, identity component references, build transform | Deflate requires explicit unbounded opt-in; component-local transforms and extensions are rejected                  |
| glTF/GLB 2.0            | Embedded/GLB buffers, indexed TRIANGLES, static nodes and transforms, metre/Y-up conversion                                 | External resources, sparse/compressed accessors, animation, skins, morphs, and non-triangle primitives are rejected |
| STEP tessellator output | Explicit unit/axis conversion, tessellation tolerances, warnings, meshes, and serializable assembly                         | Native STEP parsing, B-rep interpretation, and tessellation are not implemented in this spike                       |

All checked-in fixtures are generated in [`src/fixtures.ts`](src/fixtures.ts) from simple coordinates and container encodings. They contain no third-party model data and are covered by the repository license. The tetrahedron, boxes, and latitude/longitude spheres are deterministic. The 3MF is assembled as an in-memory stored ZIP with a computed CRC; the glTF and GLB buffers are generated from the same triangle.

## Comparison conclusions

The checked result demonstrates three different contracts, not a ranking of one universal method:

- Sampled surface distance is approximate. Sampling vertices and triangle centroids reports `1.367736397 mm` between two tessellations of the same analytic 10 mm sphere. The value reflects tessellation and sampling; it is not an exact Hausdorff distance.
- Occupancy is approximate and resolution-sensitive. For two generated boxes offset by `5.4 mm`, the estimated symmetric-difference volume is `1200 mm³` at a `2 mm` voxel and `1000 mm³` at a `1 mm` voxel. Neither equals the analytic result automatically.
- The validated-solid adapter is exact only inside its stated domain. The small evidence kernel requires eight unique corners, twelve triangles, six complete planar faces, connected topology, consistent orientation, and matching analytic volume before it returns the analytic `1080 mm³` symmetric difference. It returns `indeterminate` for spheres, disconnected tetrahedra that merely occupy all AABB corners, or invalid/open meshes.

Open geometry is a precondition failure for occupancy and solid methods in this spike. Surface distance also rejects empty, non-finite, out-of-range, and degenerate geometry. It is not silently repaired, capped, recentered, or reoriented. Malformed indices, aggregate triangle limits, unsafe archive paths, external glTF resources, animation/morph data, unsupported primitive modes, and occupancy sample budgets fail closed.

ZIP expanded-size and compression-ratio fields are preflight evidence for stored entries. They are not presented as a memory bound for platform decompression. Raw-deflate decoding is demonstrated only behind an explicit unbounded-decompression opt-in; strict/default import rejects it.

## Contract evidence and unresolved decisions

The evidence supports a normalized result with `Float64Array` positions, `Uint32Array` indices, explicit source/target units and axes, a source-to-target transform, warnings, provenance, and optional serializable assembly nodes. These are prototype shapes; accepting them as application contracts still requires review.

The following decisions remain open:

1. Choose production import libraries and hostile-input budgets per format. The narrow parsers here only make behavior testable.
2. Choose a native STEP/OCCT integration after license, WebAssembly size, worker cancellation, assembly fidelity, unit extraction, and tessellation-tolerance tests.
3. Define how a production importer represents multiple primitives, materials, instancing, component-local transforms, and partial import warnings.
4. Define method-selection policy from mesh validation, task intent, tolerances, and available compute. Unsupported preconditions must remain `indeterminate` rather than falling through to an unrelated method.
5. Establish accuracy budgets and reference fixtures before accepting a surface-distance accelerator, voxel engine, or solid Boolean kernel.

## Rejected shortcuts

- Treating STL or OBJ coordinates as millimetres without a warning.
- Relabeling Y-up geometry as Z-up without rotating coordinates and node transforms.
- Parsing STEP text as if it were tessellated geometry.
- Calling finite surface samples an exact Hausdorff result.
- Running voxel occupancy or solid operations on open meshes without reporting invalid preconditions.
- Claiming platform deflate decompression is memory-bounded by untrusted ZIP metadata.
- Selecting one Boolean, voxel, or distance implementation for every comparison.

See [`DEPENDENCIES.md`](DEPENDENCIES.md) for the dependency and license snapshot.
