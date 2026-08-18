# `@voxelspy/session-archive`

This private workspace package saves and opens version 1 portable VoxelSpy sessions entirely in the browser. A session is a self-contained ZIP containing `manifest.json`, `report.json`, and the two original source-model byte streams referenced by the report.

Saving and opening are local operations. The package has no network, identity, persistence, analytics, or hosted-storage integration. A caller must present sharing or saving as an explicit action because the archive contains the original models, report, review state, and provenance.

## Archive profile

Version 1 uses a deliberately narrow deterministic ZIP profile. The writer (`createStoredZip`) emits exactly one fixed byte layout for accepted input, and the reader (`inspectStoredZip`) rejects any archive that deviates from it — including archives produced by other correct ZIP tools — because this package's determinism claim ("identical accepted input produces identical bytes") only holds if acceptance is exactly as narrow as production.

Every field below is enforced by the reader, not just written by the writer:

- **Compression**: every entry's method is `0` (stored). Deflate and every other method are rejected, so decompression output is never allocated from untrusted input.
- **Flags**: every entry's general-purpose flag field is exactly `0x0800` (UTF-8 names only). The encrypted bit, the data-descriptor bit, and any other combination are rejected.
- **Header versions**: version-needed-to-extract is `20` in both the local and central header; version-made-by is `20` in the central header.
- **Timestamps**: DOS mod-time is `0` and DOS mod-date is `33` (1980-01-01, the conventional reproducible-build epoch) in both the local and central header.
- **Attributes**: central-directory internal file attributes are `0` and external file attributes are `0` (no platform-specific permission bits).
- **Names**: UTF-8, decoded strictly (malformed UTF-8 is rejected), matching `portableResourcePathSchema` (canonical, relative, no dot segments), unique across the archive, and identical between an entry's local and central header.
- **Sizes and CRC-32**: compressed size equals expanded size (a consequence of storing rather than compressing); the local header's CRC-32 and both size fields must agree exactly with the central header's.
- **Extra fields, per-entry comments, disk numbers**: zero-length/zero-valued in both local and central headers.
- **Archive-level fields**: single-disk only (the end record's disk fields and per-entry disk-number-start are all `0`); zero-length archive comment; no trailing bytes after the end-of-central-directory record; the end record's central-directory offset and length must exactly bound the central directory that precedes it.
- **Byte-range accounting**: every entry's local header + name + payload occupies a distinct, contiguous span. Spans may not overlap, may not leave unlisted gaps between entries, before the first entry, or before the central directory — so no byte in the archive is ever "invisible" to structural validation.
- **Format limits**: entry count ≤ 65,535; every payload and the complete archive ≤ 4 GiB − 1 byte (checked with overflow-safe arithmetic while writing, not just while reading).

Beyond the ZIP layer:

- CRC-32 is checked before a payload is handed to any caller, then every payload is checked again against its SHA-256 manifest digest — a payload must pass both to be trusted.
- Manifest and report JSON are decoded with a strict, hand-rolled parser: duplicate object keys (at any nesting depth) are rejected, `NaN`/`Infinity`/`-Infinity` literals are rejected, and parsed objects have a `null` prototype (so a key literally named `__proto__` becomes an inert own property, never prototype pollution). The parser is otherwise permissive where the JSON grammar is permissive — for example, it accepts numeric literals beyond `Number.MAX_SAFE_INTEGER` (silently rounded via IEEE-754, exactly as the platform `JSON.parse` does) and lone (unpaired) surrogate escapes inside strings. Contract schema validation (`.safe()` integers, `portableResourcePathSchema`, etc.) is what catches values the parser itself has no opinion on.
- The manifest's entry list must exactly match the archive's actual contents in both directions: every archive entry must be listed in the manifest, and every manifest entry must exist in the archive.

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

## Error codes

Every failure raises a `SessionArchiveError` with one of exactly twelve stable `SessionArchiveErrorCode` values. Callers (including the web app's `describeSessionError`) may build an exhaustive `Record<SessionArchiveErrorCode, string>` over this set, so **this list must stay complete and no code may be renamed or removed** — a new code is a breaking change for any such exhaustive mapping and must be called out prominently when proposed.

| Code                  | Raised when                                                                                                                                                                                                                                                                                                                                                                                                |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `INVALID_REQUEST`     | The caller-supplied limits, load request, or transferred byte buffer do not satisfy their contract shape (including partial/non-owning `Uint8Array` views).                                                                                                                                                                                                                                                |
| `ARCHIVE_LIMIT`       | A caller resource limit is exceeded (archive bytes, entry count, entry bytes, aggregate expanded bytes, manifest/report bytes), or a version 1 ZIP format ceiling is hit (65,535 entries; 4 GiB − 1 bytes per payload or archive).                                                                                                                                                                         |
| `INVALID_ZIP`         | The byte stream is structurally malformed for this profile: truncated, a missing or misplaced signature, inconsistent stored sizes, disagreement between an entry's local and central header, overlapping or unlisted-gap byte ranges, a nonzero end-of-central-directory comment/trailing bytes, or a central-directory length mismatch.                                                                  |
| `UNSUPPORTED_ZIP`     | The byte stream is well-formed ZIP but uses a feature or field value this profile excludes: compression, encryption, data descriptors, multi-disk, extra fields, per-entry comments, or any header version/timestamp/attribute field that deviates from the fixed profile.                                                                                                                                 |
| `INVALID_PATH`        | An entry name is not valid UTF-8, or does not satisfy `portableResourcePathSchema` (canonical, relative, no dot segments), or exceeds the writer's path-length limit.                                                                                                                                                                                                                                      |
| `DUPLICATE_PATH`      | Two entries share the same path.                                                                                                                                                                                                                                                                                                                                                                           |
| `INVALID_JSON`        | `manifest.json` or `report.json` is not strict UTF-8 JSON per the hand-rolled parser (duplicate keys, non-finite number literals, and grammar violations included).                                                                                                                                                                                                                                        |
| `UNSUPPORTED_VERSION` | A parsed manifest or report's `contractVersion` is not `1`.                                                                                                                                                                                                                                                                                                                                                |
| `INVALID_MANIFEST`    | The parsed manifest does not satisfy `sessionManifestSchema`, or the archive has no single `manifest.json` entry.                                                                                                                                                                                                                                                                                          |
| `INVALID_REPORT`      | The parsed report does not satisfy `reportSchema`.                                                                                                                                                                                                                                                                                                                                                         |
| `MANIFEST_MISMATCH`   | The manifest's entry list and the archive's actual entries do not exactly correspond (an entry listed by one and missing from the other, in either direction), a required resource is missing, or the final archive-exchange contract (`sessionArchiveExchangeSchema`) does not hold. Also raised by `createSessionArchive` when the supplied source models do not exactly match the report's model paths. |
| `INTEGRITY_ERROR`     | A payload's CRC-32 does not match its ZIP header, or a payload's byte count or SHA-256 digest does not match its manifest entry.                                                                                                                                                                                                                                                                           |
