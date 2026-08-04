# `@voxelspy/contracts`

This package defines the versioned, environment-neutral data boundaries shared by VoxelSpy runtimes. It is a private workspace package while the first public contracts are reviewed. Package version `0.1.0` does not imply that the schemas are ready for independent publication.

## Coordinate and ownership conventions

- Normalized computation uses finite `Float64` values, millimetres, and a right-handed Z-up model frame.
- Matrices are column-major affine matrices applied as `p' = M * [x, y, z, 1]`. Affine transforms must be numerically invertible, using a scale-independent normalized determinant check. Source normalization is a handedness-preserving uniform-scale transform. Comparison alignment is a proper rigid transform. Instance and source-hierarchy placement remain explicitly affine.
- `appliedSourceToModel` records the audited unit and axis conversion already applied during normalization. It is derived from the resolved source frame and cannot translate or recenter geometry. Detected unit and axis values are retained separately, including `unknown`, so a declaration or user correction does not erase the importer's observation. Each resolved source dimension records whether it came from embedded metadata, a caller declaration, or a user decision. An unresolved source frame cannot produce a normalized model.
- Mesh buffers contain mesh-local coordinates in canonical units and basis. Placement is a discriminated choice: a flat model uses each instance's `meshToModel`, while a hierarchy uses `meshToNode` followed by the node chain's `localToParent`. Hierarchy roots use identity relative to the model frame. A model cannot carry both placement systems.
- Model-to-comparison alignment belongs to an explicit analysis binding, not the imported model. Planes use `n dot p + constantMillimetres = 0` in their declared frame.
- Runtime geometry uses full-span, independently owned `ArrayBuffer` views containing `Float64Array` positions and `Uint32Array` triangle indices. Those buffers support structured cloning and transfer; shared or partial views require a later ownership contract. Typed geometry is not portable JSON and is never included in reports implicitly.
- Transferring a buffer changes runtime ownership. Transport implementations must document detachment and must not hide preservation copies.

## Import and analysis semantics

Import requests carry caller-supplied resource limits, with archive-specific limits only when the selected adapter needs them. Per dimension, a request may supply one user correction or caller declaration; when neither is supplied, the importer must use detected embedded metadata. Successful exchanges correlate that deterministic resolution with the requested model, format, source name, normalized transform, and triangle ceiling. This package defines the policy shape but intentionally defines no product defaults, decompressor, parser, network behavior, or importer engine object. An unresolved source unit or axis produces `needs-input`; callers cannot declare `unknown` as a resolution.

Analysis distinguishes three outcomes:

1. malformed data or runtime failures are structured errors outside an analysis result;
2. valid requests with unsupported domains, failed method preconditions, or exhausted budgets are `indeterminate`;
3. completed work is `approximate` or `exact-within-validated-preconditions` and records its requested and effective method, parameters, tolerances, two-model validation evidence, units, warnings, and uncertainty or validated domain. Effective parameter or tolerance changes correspond one-to-one with structured adjustment fields, and every exact-domain precondition requires evidence for both models. A closed assessment cannot report boundary edges, and count-valued metrics are safe integers.

Cancellation is a worker lifecycle event, not an analysis result. A requested method never falls through silently to another method.

## Reports and portable sessions

Version 1 reports are immutable, bounded review snapshots. They embed a correlated analysis request/result exchange, exactly two source-model records, comparison- or model-frame callouts and distances, manual or automatic findings, renderer-neutral saved views, and bounded 2D line/label figure primitives. Coordinates remain finite canonical millimetres. Automatic findings reference their analysis request and at least one existing change region; indeterminate analyses can still produce manual findings but cannot claim automatic regions.

Report entity IDs are unique across models, metrics, regions, markups, findings, views, and figures. Source digests and names must agree with import normalization provenance. Timestamps use the exact UTC millisecond form `YYYY-MM-DDTHH:mm:ss.sssZ`; unsupported versions and unknown keys reject instead of being guessed or stripped. Figure primitives are already-reviewed export inputs, so report exporters do not rerun geometry implicitly.

A version 1 portable session is deliberately self-contained: `manifest.json`, one verified report payload, and the two original source-model payloads. The manifest uses canonical lowercase relative paths, sorted entries, positive safe byte counts, and SHA-256 digests. Its report and source records must match the report graph exactly. Saving or sharing a session therefore transfers the original model data and must be presented as an explicit user action.

Session archive implementation remains outside this package. The contract provides caller-supplied limits and correlated preflight/post-inflate evidence for compressed bytes, entry count, individual and aggregate expansion, compression ratio, dedicated manifest/report sizes, exact archive membership, and verified payload sizes and hashes. Implementations must reject traversal, malformed or duplicate archive names, encryption, unsupported compression, inconsistent headers, trailing data, invalid UTF-8/JSON, and duplicate JSON keys before interpreting content. No product-default limits are defined here.

## Deliberate exclusions

The package has no dependency on React, Three.js, DOM `File`, browser globals, Node built-ins, archive implementations, storage, identity, hosting, or persistence. It does not select an importer, geometry kernel, accuracy threshold, method fallback, resource limit, worker topology, canonical JSON byte encoding, report renderer, archive parser, or deployment policy.

The hierarchical placement shape preserves a serializable rooted tree without freezing one CAD engine's runtime objects. Typed geometry needs a separately versioned binary format before it can appear in a portable session.

## Verification

From the repository root:

```sh
pnpm --filter @voxelspy/contracts check
```

Tests cover finite values, transforms, typed-array layout, graph references, resource bounds, version dispatch, result semantics, review/report graphs, portable-session evidence, and strict portable metadata. Browser-library and Node-library TypeScript consumers compile against the same package exports.
