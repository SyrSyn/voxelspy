# Reports and portable sessions evidence spike

This self-contained spike tests whether one versioned, serializable review model can drive a PDF report, an editable DOCX report, and a portable `.voxelspy` session. It uses only generated cuboids with documented provenance. It does not read user files, use browser APIs, contact a service, or transmit model data.

The schemas and identifiers here are research evidence. They are not frozen public contracts and must not be adopted without a separate API and product review.

## Reproduce the evidence

Node.js 24 and pnpm 10 are required. Install from this directory with workspace discovery disabled so the spike retains its lane-local lockfile:

```sh
cd spikes/phase-1/reports-sessions
pnpm install --ignore-workspace --frozen-lockfile
pnpm check
pnpm generate
unzip -t artifacts/report.docx
unzip -t artifacts/review.voxelspy
```

`pnpm generate` creates and validates `report.json`, `figure.svg`, `report.pdf`, `report.docx`, `review.voxelspy`, and `SHA256SUMS` under the ignored `artifacts/` directory. Repeating it produces the same bytes and hashes.

## Canonical evidence model

The canonical report includes:

- two generated ASCII STL cuboids in millimetres, each with a source hash, identity transform, role, and provenance;
- a bounded callout anchored to the candidate and a two-point distance whose stored value must match its endpoints;
- one automatic finding with detector identity, version, parameters, severity, confidence, and markup links;
- a saved camera, visibility map, selections, optional section plane, active review view, notes, and status;
- deterministic, serializable 2D figure primitives shared by the PDF and DOCX exporters.

Cross-references and finite geometry values are validated. Entity counts and human-authored string lengths are bounded. Schema dispatch accepts version 1 explicitly and rejects missing or unknown versions instead of guessing or silently migrating.

The PDF renderer writes a single-page PDF with editable text plus vector figure primitives. The DOCX renderer writes editable OOXML paragraphs and embeds the same deterministic figure as SVG. The session stores `manifest.json`, `report.json`, the figure, and both original synthetic STL files:

```text
review.voxelspy
├── manifest.json
├── report.json
├── figures/overview.svg
└── models
    ├── baseline.stl
    └── candidate.stl
```

Every payload entry is listed with media type, byte count, and SHA-256 hash. Import requires an exact manifest/archive match and separately verifies the report's model hashes.

## Security and resource findings

Import performs a central-directory preflight before inflation. It rejects archives that exceed compressed size, entry count, per-entry size, total uncompressed size, or compression-ratio limits. It also rejects encrypted or unsupported compression methods, multi-disk ZIPs, duplicate names, path traversal, absolute or platform-specific paths, invalid UTF-8 names, inconsistent local/central headers, entries outside archive bounds, trailing bytes, missing files, unlisted files, invalid JSON, unsupported schema versions, and size/hash changes.

The spike defaults to a 32 MiB compressed archive, 32 entries, 16 MiB per entry, 32 MiB total inflated data, and a 100:1 maximum compression ratio. These are evidence defaults, not accepted product limits. ZIP64 and encrypted sessions are deliberately unsupported.

`fflate.unzipSync` materializes every payload after preflight. With current limits, peak memory includes the compressed buffer, up to 32 MiB of inflated buffers, JSON strings/objects, and exporter copies. A production large-session importer should parse the central directory incrementally, stream each entry through a byte counter and SHA-256 verifier into temporary file or origin-private storage, keep only the manifest/report in memory, and expose models as blob/file handles. Worker transport should transfer buffers; shared memory must remain optional.

## Fidelity findings and limits

- The canonical inputs and every artifact are byte deterministic because dates, ordering, IDs, geometry, and archive timestamps are fixed.
- The PDF is a deliberately small single-page renderer. It has no pagination, wrapping, font embedding, tagged-PDF accessibility, colour-profile management, or full Unicode support; unsupported characters are replaced. Its validator checks PDF structure but is not an independent conformance suite.
- DOCX text remains editable, while the figure is an embedded SVG. The package passes ZIP/relationship/content checks, but older office software may not display SVG. No office suite was available for rendered compatibility testing.
- Figures consume explicit saved-view-derived primitives rather than re-running geometry during export. Production must define the camera-to-figure rendering contract, fonts, occlusion, line styles, and raster fallback.
- The session is self-contained and restores source bytes and serialized review state. It does not prove forward migration, partial loading, repair, encryption, digital signatures, or multi-gigabyte operation.

## Unresolved contract decisions

Before accepting public schemas, decide coordinate-frame semantics for anchors and measurements, unit-conversion policy, stable ID generation, report revision/history representation, manual-versus-automatic finding lifecycle, detector parameter portability, figure rendering guarantees, hash algorithm agility, compatibility/migration policy, and whether sessions may contain optional derived geometry or thumbnails. Threat modeling must also decide product limits and whether archive signatures or encryption belong in the format.

See [PROVENANCE.md](PROVENANCE.md) for fixture and dependency provenance.
