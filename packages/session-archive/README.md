# `@voxelspy/session-archive`

This private workspace package saves and opens version 1 portable VoxelSpy sessions entirely in the browser. A session is a self-contained ZIP containing `manifest.json`, `report.json`, and the two original source-model byte streams referenced by the report.

Saving and opening are local operations. The package has no network, identity, persistence, analytics, or hosted-storage integration. A caller must present sharing or saving as an explicit action because the archive contains the original models, report, review state, and provenance.

## Archive profile

Version 1 uses a deliberately narrow deterministic ZIP profile:

- entries are stored without compression, use UTF-8 canonical relative paths, and are written in ordinal path order;
- timestamps and platform metadata are fixed, so identical accepted input produces identical bytes;
- encrypted entries, compression, data descriptors, ZIP64, comments, trailing bytes, duplicate paths, traversal paths, overlapping records, inconsistent headers, and malformed UTF-8 are rejected;
- CRC-32 is checked before payload interpretation, then every payload is checked against its SHA-256 manifest digest;
- manifest and report JSON reject duplicate object keys, unsupported versions, unknown fields, and contract-invalid references.

Stored entries make compressed and expanded sizes identical. Expansion limits and compression-ratio policy are therefore checked before payload extraction without allocating decompression output. Deflate archives are intentionally unsupported rather than inflated through an unbounded platform API.

## Caller-supplied limits

There are no implicit product limits. Every save and open operation requires a `SessionArchiveLimits` value from `@voxelspy/contracts`:

- maximum archive bytes;
- maximum entry count;
- maximum bytes for any entry;
- maximum aggregate expanded bytes;
- maximum compression ratio;
- dedicated maximum manifest and report bytes.

The ZIP format used here additionally limits each payload and the complete archive to 4 GiB minus one byte and limits entry count to 65,535. Normal application limits should be substantially smaller.

## API

`createSessionArchive` validates the report, requires exactly the two referenced source paths, verifies their SHA-256 digests, and returns deterministic archive bytes plus the accepted bundle and preflight evidence.

`inspectSessionArchive` validates structure and caller limits without returning payloads. `openSessionArchive` additionally verifies CRC-32, strict JSON, SHA-256 integrity, exact manifest membership, report/source correlation, and the complete archive exchange contract. Returned resources are fresh byte arrays and preserve the original model bytes exactly.

`digestSessionResource` computes the contract SHA-256 shape with Web Crypto for callers preparing report source records.
