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

## Deliberate alignment

`estimateAlignment(input, options?)` answers "what rigid transform would bring this part onto that one?" -- and only answers it. **It never applies the transform it computes.** It never mutates a model, never recenters or rescales geometry, and never runs a comparison. It returns a computed `RigidTransform` (the same validated `rigidTransformSchema` shape `ClearancePlacement.modelToComparison` and `AnalysisRequest` model bindings already use, so it can be fed straight back as a placement) plus evidence, and leaves the decision to use it entirely to the caller. This exists because scan-versus-CAD inspection -- the largest professional use of surface deviation measurement -- routinely starts with two parts in unrelated coordinate frames, and this package's hard rule is that geometry is never silently recentred, rescaled, aligned, or repaired: alignment must be opt-in, explicit, and its resulting transform auditable. A caller that accepts an estimated alignment and uses it to place a part for `checkClearance` or `analyzeModelPair` should record that transform in its own provenance -- this package does not do that bookkeeping on the caller's behalf.

**Two explicit methods, selected by the caller via `input.method`; there is no automatic fallback between them.**

- **`correspondence-points`**: a single closed-form least-squares rigid fit (rotation plus translation, **no scale**) from at least three caller-supplied point pairs (`CorrespondencePoint`: a point on the moving part's surface, in the moving model's own unplaced frame, matched to its intended counterpart on the fixed part's surface, in the comparison frame the fixed part is already trustedly placed in). This is Horn's closed-form absolute-orientation solution (B.K.P. Horn, 1987): build the symmetric 4x4 matrix from the correspondences' centered cross-covariance terms, take the unit-quaternion eigenvector of its largest eigenvalue via this module's own bounded, self-contained Jacobi eigenvalue solver (`jacobiEigenSymmetric` in `src/alignment.ts` -- no new dependency, no general-purpose SVD needed for a 4x4 matrix), and convert that quaternion to a rotation matrix. This always yields a proper rotation (orthonormal columns, determinant +1), never a reflection, satisfying `rigidTransformSchema` by construction. Degenerate input is rejected with `AlignmentInputError`: fewer than `MIN_CORRESPONDENCES` (3) points, more than `MAX_CORRESPONDENCES` (1,024), a duplicate moving or fixed point, or a moving or fixed point set that is collinear or coincident (rank less than 2, assessed from that point set's own centered-covariance eigenvalues, scale-independent) -- any of these leaves at least one rotational degree of freedom undetermined, so this package refuses to guess.
- **`iterative-closest-point`**: refines an initial transform (identity by default, or a caller-supplied seed -- commonly a `correspondence-points` result, for a coarse-to-fine alignment) by repeated closest-point matching: transform the moving part's deterministic sample points by the current estimate, find each one's nearest point on the fixed part's tessellated surface via its `TriangleSpatialIndex`, solve the same closed-form rigid fit between the sample points and their matches, and compose that increment onto the current estimate. Bounded by `maxIterations` (default `DEFAULT_MAX_ICP_ITERATIONS` = 50, ceiling `MAX_ICP_ITERATIONS` = 500) and a convergence displacement tolerance in millimetres, `convergenceToleranceMillimetres` (default `DEFAULT_ICP_CONVERGENCE_TOLERANCE_MILLIMETRES` = 1e-4, ceiling `MAX_ICP_CONVERGENCE_TOLERANCE_MILLIMETRES` = 1,000) -- iteration stops as soon as every sample point's displacement from that iteration's increment falls at or below the tolerance, or when `maxIterations` is reached, whichever comes first; an out-of-range option throws `RangeError`, matching `InspectOptions`/`MeshHealthOptions`. **Deterministic**: sample points are the moving part's own triangle vertices and centroids, in triangle order -- the same "vertices-and-triangle-centroids" sampling `surface-distance` and `checkClearance` already use, reused rather than a third scheme -- never a random subset, and the closed-form fit at each step has no random component either.

**Rigid only, and why.** Neither method ever returns or applies a scale factor. Scaling geometry would change measurements -- exactly what this package exists to report accurately -- so a rigid-only result is the only answer that cannot silently distort a subsequent comparison. When correspondence points imply a uniform scale mismatch between the moving and fixed point sets, that is reported as evidence (`AlignmentEvidence.impliedScale`, the least-squares scale minimizing residual given the already-recovered rotation) and, when it deviates from 1 by more than 1%, as an explicit `alignment.implied-scale-mismatch` warning -- never applied to the returned transform. A caller seeing a large implied scale should treat it as a signal the two parts may be expressed in different units, not as a correction to make.

**Poor-fit and non-convergence are reported honestly, not hidden behind a still-returned transform.** `AlignmentEvidence.converged` is `false` (with an `alignment.not-converged` warning naming the iteration ceiling and tolerance) whenever `iterative-closest-point` reaches `maxIterations` without meeting the convergence tolerance -- `correspondence-points` is a single closed-form solve, so it reports `iterations: 0` and `converged: true` unconditionally, since there is no iteration loop to fail. Independently, `AlignmentEvidence.poorFit` is set whenever the after-fit root-mean-square residual (`residualsAfterMillimetres.rmsMillimetres`) exceeds `POOR_FIT_RESIDUAL_RATIO` (2%) of the aligned geometry's own bounding-box diagonal, with `poorFitReason` naming the exact numbers and threshold and an `alignment.poor-fit` warning carrying the same details -- a converged, low-iteration-count result can still be a poor fit when the two parts are not actually the same shape (residual is measured relative to scale, not as an absolute millimetre threshold, because the same absolute error reads as a good fit on a large part and a bad one on a small part). This is a disclosed heuristic, not a certified shape-match verdict -- exactly the same "bounded, not just disclosed in prose" discipline this package applies to sampling and interference evidence elsewhere -- and it exists so a UI can warn instead of implying a confirmed match.

**Every result also reports** `method`, `parameters` (the effective `maxIterations`/`convergenceToleranceMillimetres` for `iterative-closest-point`; empty for `correspondence-points`), `correspondenceCount` (the number of point pairs used, or the sample count for `iterative-closest-point`), and `residualsBeforeMillimetres`/`residualsAfterMillimetres` (root-mean-square and maximum residual distance, measured before any fitting and after the returned transform is applied to the same points/samples) -- so a caller can see exactly how much the fit improved, not just its final number.

**Resource discipline.** `iterative-closest-point` reuses `ANALYSIS_LIMITS` (expanded vertex/triangle ceilings and the estimated-memory ceiling, via `checkExpandedGeometryBudget`) and the same charge-before-work `WorkBudget` this package uses throughout: flattening both models, building the fixed part's `TriangleSpatialIndex`, building the moving part's deterministic sample set, and every iteration's closest-point queries and displacement checks are all charged to one budget constructed before any O(vertices + triangles) work runs. An expanded-geometry ceiling violation throws `AlignmentResourceLimitError` before any such work runs; an exhausted budget throws `WorkBudgetExceeded` (reused unchanged from `src/analyze.ts`, not redefined); empty geometry after flattening (either part) throws `AlignmentGeometryError`. `correspondence-points` has no comparable geometry-sized cost -- its cost is proportional only to the (already bounded) correspondence count.

**Determinism.** Identical input produces a deeply equal `AlignmentEstimate` every time for both methods: `correspondence-points` is a closed-form solve with a fixed-order, bounded eigenvalue solver; `iterative-closest-point` samples in a fixed triangle order, queries the fixed part's spatial index deterministically (the same `TriangleSpatialIndex` every other method in this package uses), and never introduces randomness at any step.

## Measurement

`measureOnModel(model, query, options?)` answers a single click-to-measure-style query against one placed model, for a UI to build measurement tooling as a thin layer over this package rather than reimplementing its own approximate geometry math.

**Exactness.** Every `measureOnModel` result is `semantics: "exact"`, in contrast to `analyzeModelPair`'s and `checkClearance`'s `"approximate"`: those methods sample a bounded set of points (each triangle's vertices and centroid) against the opposite surface, so a smaller true distance can exist between samples. `snap-point` and `point-to-surface` instead query `TriangleSpatialIndex.nearestTriangle` directly against the query point -- an exhaustive, exact nearest-triangle search over every triangle via the same accelerated BVH the rest of this package uses, not a sampled subset -- so the returned point and distance are exact for the tessellated surface as given. `point-to-point` is exact ordinary vector arithmetic on the two supplied coordinates, with no claim that either point actually lies on any surface. `bounding-extent` is an exact min/max over the placed vertex positions. **"Exact" is a claim about the tessellated triangle mesh, not about any original curved or CAD geometry that mesh approximates** -- the same distinction `axis-aligned-box-solid` and `checkClearance`'s `interference.trianglePairs` already draw.

**Query kinds.**

- **`snap-point`**: given `at: { kind: "point", point }`, returns the exact closest point on the surface to `point` (`TriangleSpatialIndex.nearestTriangle` plus `closestPointOnTriangle`, the same primitives every other exact-nearest-point query in this package uses). Given `at: { kind: "ray", origin, direction }` -- the shape a click-to-measure UI casts from a camera through a clicked pixel -- returns the exact nearest ray/triangle intersection point (a genuine ray cast, Moller-Trumbore, over every triangle) or `{ hit: false, reason: "ray-missed-surface" }` when the ray crosses no triangle, an honest outcome, not a thrown error. Either way, the resulting point is then classified against its containing triangle's three vertices and three edges: `snap: { kind: "vertex", ... }` when within `snapToleranceMillimetres` of a vertex (checked first -- a point within tolerance of a vertex is always within tolerance of every edge touching that vertex too, so vertex is the more specific, preferred classification); else `snap: { kind: "edge", ... }` when within tolerance of an edge; else `snap: { kind: "face" }` (interior, unsnapped). This is what makes click-to-measure precise: the UI does not need its own approximate raycast/snap logic.
- **`point-to-point`**: the straight-line distance between two supplied points plus their axis-aligned componentwise delta (`second - first`). Pure arithmetic -- does not read the model's geometry at all (the two points are typically obtained from prior `snap-point` calls), included so a full measurement workflow lives behind one function.
- **`point-to-surface`**: the exact shortest distance from a supplied point to the model's surface, with the closest surface point and the triangle it lies on. Works identically whether the query point is outside, on, or "inside" the surface -- this package makes no inside/outside claim, for the same reason `checkClearance` computes no interference volume.
- **`bounding-extent`**: overall dimensions and axis-aligned bounds, reused unmodified from `summarizeModelGeometry`'s own bounds computation (the same one `analyzeModelPair`'s comparison summary and `inspectModel` use) rather than a second, differently-computed bounds pass.

**Resource discipline.** Every query kind -- including `point-to-point` and `bounding-extent`, which do not need a spatial index -- first validates `model` against `normalizedModelSchema` and checks its expanded vertex/triangle counts (plus estimated memory, honoring an optional caller-supplied `executionBudget.maxMemoryBytes`) via `checkExpandedGeometryBudget`, the same pre-flight `checkClearance` and `estimateAlignment` use, throwing `MeasurementResourceLimitError` before any O(vertices + triangles) work runs if that fails -- a uniform, predictable resource contract across query kinds, even where a specific kind's own work is trivial. `snap-point` and `point-to-surface` additionally flatten the model and build a `TriangleSpatialIndex` under a charge-before-work `WorkBudget` (bounded by `executionBudget.maxWorkUnits`); an exhausted budget throws `WorkBudgetExceeded` unchanged, matching every other entry point in this package. `options.modelToComparison` is validated as a proper rigid transform (`rigidTransformSchema` -- no scale, shear, or reflection), matching `ClearancePlacement.modelToComparison`, since scaling or shearing placed geometry would distort the very distances this function reports. `snapToleranceMillimetres` (default `DEFAULT_SNAP_TOLERANCE_MILLIMETRES` = 0.5mm, ceiling `MAX_SNAP_TOLERANCE_MILLIMETRES` = 1,000mm) and other invalid query input (a non-finite point, a degenerate ray direction) throw `RangeError`/`MeasurementInputError` respectively, matching `InspectOptions`'s and `EstimateAlignmentOptions`'s conventions.

**Determinism.** Identical input produces a deeply equal `MeasurementResult` every time: `TriangleSpatialIndex` traversal is deterministic, the ray cast resolves ties at identical intersection distance by ascending triangle index, and no step introduces randomness.

## Cross-sectioning

`sectionModel(model, plane, options?)` cross-sections `model` with a plane, returning the section as ordered, bounded polylines -- for a UI to render a 2D cut view or measure a profile.

**Algorithm.** Every triangle in the flattened comparison-frame geometry is classified against the plane by the exact sign of `unitNormal . vertex + d` at each of its three corners (`0` for a vertex exactly on the plane -- a direct evaluation of caller-supplied input, not accumulated error, so this package's no-tolerance-welding philosophy applies the same exact `=== 0` test "Topology semantics" above already uses for coordinate identity). Each triangle contributes at most one segment: no segment when all three corners are strictly the same side, or when exactly one corner is on the plane and the other two are strictly the same side (the plane only touches that one vertex); the in-plane edge itself when exactly two corners are on the plane; a segment from the on-plane vertex to the opposite edge's crossing point when exactly one corner is on the plane and the other two are on opposite sides; a segment between the two edges' crossing points when no corner is on the plane and the sign split is 2-1; and (see "Coincident-plane" below) no segment, but a census entry, when all three corners are on the plane.

A crossing point on a shared edge is computed identically regardless of which of the edge's two triangles (or which vertex-index numbering, facet-local or shared) supplies it: the edge's two endpoints are always ordered by their exact-coordinate key (`pointKeyAt`, the same key `assessGeometry` and `groupTrianglesByExactEdgeConnectivity` use) and interpolated from the coordinate-lesser endpoint toward the coordinate-greater one, so two triangles sharing a bit-identical edge always compute a bit-identical crossing point -- what lets loop tracing key segment endpoints by exact string equality.

**Loop tracing** reuses the same exact-coordinate-keyed chain tracer `diagnoseMeshHealth`'s boundary-loop tracer uses -- literally the same implementation (`traceAllChains` in `src/chain-tracing.ts`), not a forked copy -- so a section of a closed, watertight model produces `closed: true` loops, while a section of an open mesh (a panel, a box missing a face) can produce `closed: false` chains that terminate at the mesh's own boundary instead of looping back on themselves, reported honestly rather than forced closed. Each `SectionLoop` reports its ordered `pointsMillimetres`, true `edgeCount`, `closed`, `perimeterMillimetres` (exact for the traced polyline, exact even when points are truncated), `pointsTruncated`, and `area`.

**Area.** `area.available` is `true` only for a closed loop -- an open polyline has no well-defined enclosed area, and reports `{ available: false, reason: "not-closed" }` instead. For a closed loop, `signedSquareMillimetres` is the standard 3D-polygon vector-area formula (`0.5 * sum(P_i x P_{i+1})`, dotted with the plane's unit normal): positive when the loop's `pointsMillimetres` order winds counterclockwise around that normal (right-hand rule), negative when clockwise. That winding is a byproduct of this package's deterministic canonical point ordering (see "Determinism" below), **not** a measurement of which side is "solid" or which loop is an outer boundary versus a hole -- do not infer solid/hole or inside/outside from the sign alone. `absoluteSquareMillimetres` is `|signedSquareMillimetres|`.

**Determinism** is identical to `diagnoseMeshHealth`'s rule (see "Mesh-health diagnostics" above for the full statement): each closed loop is rotated to start at its lexicographically smallest point and walk toward whichever of its two directions reaches a lexicographically smaller second point; a non-closed chain is oriented so its lexicographically smaller endpoint comes first; loops are ordered by descending edge count, then ascending canonical start point, then closed-before-terminated, then a full point-by-point comparison as a last resort. Segment classification is itself a fixed walk of the geometry's own triangle order. Identical `model`/`plane`/`options` therefore produces a deeply equal `SectionResult` every time.

**Coincident-plane (degenerate case).** When the plane exactly coincides with one or more triangles (every vertex on-plane), those triangles contribute no segment of their own -- extracting a meaningful outline from an in-plane triangle soup is a 2D-outline-extraction problem out of scope here, the same kind of "no validated domain, so no approximation offered" decision `checkClearance` makes for interference volume. Those triangles are counted in `coincidentTriangleCount` and reported via a `section.plane-coincident-with-faces` warning -- always surface this to the caller rather than trusting the returned loops alone when it is nonzero. In practice this is often harmless: any _adjacent_ triangle with exactly one edge in the plane still contributes that edge as an ordinary segment, so a coincident face's own boundary is frequently still recovered correctly from its neighbors -- but this is not guaranteed for every mesh, so `coincidentTriangleCount > 0` should always be surfaced, not silently trusted.

**A plane missing the model entirely** is not an error: `loops.loops` is simply empty (`loopCount: 0`).

**Bounds.** `maxLoops` (default `DEFAULT_MAX_SECTION_LOOPS` = 200, ceiling `MAX_SECTION_LOOPS` = 2,000) caps how many loops are returned. `maxLoopPoints` (default `DEFAULT_MAX_SECTION_LOOP_POINTS` = 20,000, ceiling `MAX_SECTION_LOOP_POINTS` = 200,000) is a single point budget shared across every returned loop, spent in the loops' final sorted order -- a loop that only partially fits is still returned with `pointsTruncated: true` and its exact `edgeCount`/`closed`/`perimeterMillimetres`/`area`, and `loopsTruncated` is set whenever any loop is left out entirely. Every bound throws `RangeError` when out of range, matching `InspectOptions`/`MeshHealthOptions`.

**Resource discipline** mirrors `measureOnModel`: `model` validated against `normalizedModelSchema`, expanded vertex/triangle counts and estimated memory checked via `checkExpandedGeometryBudget` (throwing `SectionResourceLimitError` before any O(vertices + triangles) work runs), flattening and the per-triangle plane-intersection walk charged to a charge-before-work `WorkBudget` (throwing `WorkBudgetExceeded` unchanged on exhaustion), `options.modelToComparison` validated as a proper rigid transform, and an invalid `plane` (a non-finite point, a non-finite or zero-length normal) throwing `SectionInputError`.

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

```ts
import { estimateAlignment } from "@voxelspy/analysis";

// estimateAlignment only computes a transform -- it never applies it. The
// caller decides whether to accept it and feed it back as a placement.
const seed = estimateAlignment({
  method: "correspondence-points",
  correspondences: [
    { moving: [0, 0, 0], fixed: [12.4, 3.1, 0.2] },
    { moving: [10, 0, 0], fixed: [22.1, 3.6, 0.4] },
    { moving: [0, 10, 0], fixed: [12.8, 13.0, 0.1] },
  ],
});
console.log(
  seed.evidence.impliedScale,
  seed.evidence.residualsAfterMillimetres,
);

const refined = estimateAlignment({
  method: "iterative-closest-point",
  moving: scan,
  fixed: { model: cad, modelToComparison: cadPlacement },
  initialTransform: seed.transform,
});
if (!refined.evidence.converged || refined.evidence.poorFit) {
  console.warn("Review before use:", refined.warnings);
}
// Only now, deliberately, use the result as a placement:
const fit = checkClearance({
  first: { model: scan, modelToComparison: refined.transform },
  second: { model: cad, modelToComparison: cadPlacement },
  desiredClearanceMillimetres: 0.2,
});
```

```ts
import { measureOnModel } from "@voxelspy/analysis";

// Click-to-measure: cast a ray from the camera through the clicked pixel.
const snapped = measureOnModel(model, {
  kind: "snap-point",
  at: { kind: "ray", origin: cameraPosition, direction: pickDirection },
});
if (snapped.outcome.hit) {
  console.log(snapped.outcome.pointMillimetres, snapped.outcome.snap);
}

// Two snapped points -> distance and componentwise delta.
const distance = measureOnModel(model, {
  kind: "point-to-point",
  first: firstSnap.outcome.pointMillimetres,
  second: secondSnap.outcome.pointMillimetres,
});
console.log(distance.distanceMillimetres, distance.deltaMillimetres);
```

```ts
import { sectionModel } from "@voxelspy/analysis";

const section = sectionModel(model, {
  point: [0, 0, sliceHeight],
  normal: [0, 0, 1],
});
if (section.coincidentTriangleCount > 0) {
  console.warn("Plane coincides with part of the surface:", section.warnings);
}
for (const loop of section.loops.loops) {
  console.log(loop.closed, loop.perimeterMillimetres, loop.area);
}
```
