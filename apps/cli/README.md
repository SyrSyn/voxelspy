# `@voxelspy/cli`

A headless Node command-line tool for the same bounded geometry comparison
and inspection `@voxelspy/analysis` and `@voxelspy/importers` provide to the
browser tool -- built so a CI pipeline (or any script) can gate on geometry
without a browser. It reads local files, writes text or JSON to stdout, and
makes no network requests and sends no telemetry.

This is `apps/cli`, a private, unpublished workspace package with a `voxelspy`
bin entry, matching the conventions of `apps/web` and the `packages/*`
libraries it depends on (`workspace:^`).

## Design principle: never overclaim

Every method this CLI calls (`analyzeModelPair`'s `surface-distance`,
`checkClearance`) is documented by `@voxelspy/analysis` as **approximate**:
distances are sampled at each triangle's vertices and centroid, not measured
everywhere on the surface. A passing exit code is not proof of anything
stronger than that sampling supports. Concretely:

- Every `compare` and `clearance` run -- **passing or failing** -- prints the
  sample-spacing bound (`uncertainty.parameters.maxSampleSpacingMillimetres`):
  the farthest any point on an analyzed triangle could be from the nearest
  sample. When that bound exceeds the requested tolerance/clearance, the run
  also prints an explicit `UNDERSAMPLED` line -- a feature confined to one
  coarse triangle's interior could have been missed entirely, with no defect
  in the tolerance value itself.
- `clearance`'s exact evidence (`interference.trianglePairs`, confirmed by a
  true triangle-triangle intersection test) is always reported and labeled
  separately from the sampled `minimumDistanceMillimetres` -- an
  `"interfering"` state driven by a detected pair is real; a `"clear"` state
  is a sampled result bounded by the spacing above, never a geometric
  guarantee.
- An indeterminate or resource-limited outcome is never silently treated as
  a pass. It gets its own exit code (`2`), distinct from both `0` and `1`,
  unless the caller explicitly opts into stricter gating with
  `--fail-on-indeterminate`.
- Import failures, resource-limit refusals, and indeterminate analysis
  outcomes always print their real code and message (or reasons), never a
  generic "something went wrong."

## Commands

Run `voxelspy <command> --help` for the full, current option list; this
section documents the policy semantics behind each option, which is easy to
get wrong from `--help` text alone.

### `voxelspy compare <baseline> <candidate>`

Runs `analyzeModelPair` with the `surface-distance` method (1.0.0) and
reports ranked changed regions -- the same method and semantics the browser
tool's comparison view uses.

**Source-frame options** (STL/OBJ never declare unit/axis, so one of each is
required for import to succeed): `--baseline-unit`, `--baseline-axis`,
`--candidate-unit`, `--candidate-axis`. Values: unit is one of
`micrometre|millimetre|centimetre|metre|inch|foot`; axis is one of
`right-handed-z-up|right-handed-y-up`. These are passed to `importModel` as
`userUnit`/`userAxis` (an explicit caller correction, not an embedded
declaration).

**Method options:** `--tolerance <mm>` (required; `surface-distance`'s
distance tolerance) and `--max-regions <n>` (caps ranked regions returned,
&le; 2048; the true detected count is always reported regardless).

**Resource options:** `--max-work-units`/`--max-memory-bytes` map to
`AnalysisRequest.executionBudget`; `--max-input-bytes`/`--max-triangles`
(applied to both files) lower -- never raise -- `@voxelspy/importers`'
`IMPORTER_SAFETY_LIMITS`.

**Policy options** (a completed run with none of these specified always
exits `0` -- it is informational only):

| Option | Fails when |
| --- | --- |
| `--max-deviation <mm>` | the true maximum distance (`surface.maximum-distance`, across *all* detected regions, independent of `--max-regions` truncation) exceeds `<mm>` |
| `--fail-on-regions <n>` | the true detected changed-region count exceeds `<n>` (pass `0` to fail on any change) |
| `--require-watertight` | either baseline or candidate is not closed (has boundary or non-manifold edges) |
| `--fail-on-indeterminate` | the analysis outcome is `indeterminate` (default: indeterminate exits `2`, not `0` or `1`) |

Both baseline and candidate are placed at identity in the comparison frame
(no alignment/pre-placement option is exposed yet -- see "Known limitations").

### `voxelspy inspect <model>`

Runs `inspectModel` -- topology findings, a watertightness verdict, a
per-mesh breakdown, and the same bounded geometry summary the browser's
Inspect view shows. This is a single-model report; it never compares two
files.

**Source-frame options:** `--unit`, `--axis` (same values as `compare`).

**Resource options:** `--max-input-bytes`/`--max-triangles` (import);
`--max-topology-examples` (0-50) / `--max-mesh-breakdown-entries` (0-2000)
bound the size of the returned report, not what is detected -- `count`
fields are always the true total.

**Policy options** (none specified &rarr; always exits `0`):

| Option | Fails when |
| --- | --- |
| `--require-watertight` | `watertightness.state !== "closed"` |
| `--fail-on-degenerate` | at least one degenerate (zero/non-finite-area) triangle is present |
| `--fail-on-non-manifold` | at least one non-manifold edge is present |
| `--fail-on-indeterminate` | inspection hit its own resource-limit ceiling (an internal `InspectionResourceLimitError`; default: exits `2`) |

`inspectModel`'s own findings are exact (not sampled) -- it reports on the
tessellated mesh's actual topology, so there is no sample-spacing bound to
print here, unlike `compare`/`clearance`.

### `voxelspy clearance <first> <second>`

Runs `checkClearance` -- collision regions, the sampled minimum
surface-to-surface distance, regions below a desired clearance, and *exact*
intersecting-triangle-pair interference evidence, between two independently
placed parts.

**Source-frame options:** `--first-unit`, `--first-axis`, `--second-unit`,
`--second-axis`.

**Method options:** `--clearance <mm>` (required; the desired minimum
clearance), `--max-tight-regions` (&le; 2048), `--max-interfering-pairs`
(&le; 2048).

**Resource options:** `--max-work-units`/`--max-memory-bytes`
(`CheckClearanceOptions.executionBudget`); `--max-input-bytes`/`--max-triangles`
(import, applied to both files).

**Policy: unlike `compare`/`inspect`, checking fit is this command's entire
purpose, not an opt-in extra.** By default, a completed check exits `0` only
when `state === "clear"`; `"tight"` or `"interfering"` exit `1`.
`--allow-tight` relaxes this so only `"interfering"` exits `1`.
`--fail-on-indeterminate` promotes an indeterminate outcome from exit `2` to
exit `1` (default: `2`).

Both parts are placed at identity in the shared comparison frame -- **this
command does not yet expose a placement/alignment option**, so the two files'
own coordinates must already share one frame (see "Known limitations").

## Exit codes

Every command returns exactly one of four stable codes, in this priority
order (a usage problem is caught before any engine runs; an indeterminate
result is reported before policy evaluation, since a policy cannot be
honestly evaluated against a result the engine did not produce):

| Code | Name | Meaning |
| --- | --- | --- |
| `0` | policy passed | The engine produced a complete result and every policy option the caller specified was satisfied. A run with no policy options specified always exits `0` when the engine completes -- there was nothing to gate on. |
| `1` | policy failed | The engine produced a complete result and at least one specified policy option was violated. Also used for an indeterminate outcome when `--fail-on-indeterminate` was passed. |
| `2` | indeterminate / fail-closed | The engine could not produce a decidable result: `state: "indeterminate"` from `analyzeModelPair`/`checkClearance`, an `InspectionResourceLimitError`, a `WorkBudgetExceeded`, or an import rejected with `code: "resource-limit"`. Nothing was proven either way -- never conflated with `0`. |
| `3` | usage or input error | The command line, an option value, or the input file was invalid before geometry analysis could meaningfully run: missing/unreadable files, an unrecognized extension, a bad option value, or an import rejected with `code: "invalid-input" \| "unsupported-input" \| "unsafe-archive" \| "needs-input"`. |

The full rationale (including why import's `resource-limit` code lands in
bucket `2` rather than `3`, and why `resource-limit` is distinguished from
every other import failure code) is documented in `src/exit-codes.ts`.

## Output

**Text (default).** Human-readable summary: the effective method, key
metrics, the sample-spacing bound and any `UNDERSAMPLED` line (`compare`,
`clearance`), topology findings (`inspect`), warnings, and a `Policy checks:`
section naming each specified option, its pass/fail state, and the concrete
observed value it was checked against -- so a failing (or passing) run is
never a bare exit code with no explanation.

**`--json`.** Emits one JSON object to stdout instead of the text summary
(warnings/errors from import still go to stderr as text). The object always
has a `command` field and carries the underlying library result verbatim
under `result` (or, for `inspect`'s resource-limit path, an `error` field),
plus the resolved input file paths/source names:

```jsonc
// compare --json
{ "command": "compare", "baseline": { "path", "sourceName" }, "candidate": { "path", "sourceName" }, "result": AnalysisResult }
// inspect --json
{ "command": "inspect", "model": { "path", "sourceName" }, "result": InspectionResult }
// clearance --json
{ "command": "clearance", "first": { "path", "sourceName" }, "second": { "path", "sourceName" }, "result": ClearanceCheckResult }
```

`compare`'s `result` is a full `@voxelspy/contracts` `AnalysisResult` --
schema-validated, with the same `warnings`, `uncertainty`, `metrics`, and
`regions` shape the browser tool renders. `inspect`'s `InspectionResult` and
`clearance`'s `ClearanceCheckResult` are `@voxelspy/analysis`-level result
types (there is no dedicated `@voxelspy/contracts` schema for either yet),
but both are the exact same values the library returns, including the
`MeshAssessment` validation evidence and (for `clearance`) the sampling
uncertainty and exact interference evidence.

**Determinism.** All three commands' JSON is deterministic for identical
inputs: model IDs, request IDs, and the comparison frame (identity) are
fixed constants chosen by this CLI, not generated (no timestamps, no random
IDs), and every underlying library call is itself pure and deterministic
given the same input bytes and options.

## Resource bounds

This CLI adds no new geometry ceilings of its own -- every `--max-*` option
only *lowers* an existing engine or importer ceiling, never raises it:

- Import: `IMPORTER_SAFETY_LIMITS` (32 MiB input, 500,000 triangles,
  1,500,000 vertices).
- Analysis (`compare`): `ANALYSIS_LIMITS` (3,000,000 combined expanded
  vertices, 1,000,000 combined expanded triangles, 768 MiB estimated
  memory, 2,200,000,000 work units, 2,048 reported regions).
- Clearance: the same `ANALYSIS_LIMITS` expanded-geometry/memory ceilings,
  plus its own `MAX_TIGHT_REGIONS`/`MAX_INTERFERING_TRIANGLE_PAIRS` (2,048
  each).
- Inspection: the same expanded-geometry ceilings, plus
  `MAX_TOPOLOGY_EXAMPLES` (50) / `MAX_MESH_BREAKDOWN_ENTRIES` (2,000).

A `--max-input-bytes` (or `--max-triangles`) smaller than the actual file
produces an exit-`2` `resource-limit` refusal with the exact configured
ceiling and actual size named -- not the generic "did not satisfy the
public contract" message `importModel` would otherwise give for the same
underlying cause.

## Known limitations

- Neither `compare` nor `clearance` exposes a placement/alignment option
  yet. `compare` always places both models at identity (comparing one model
  against a revision of itself, in its own frame); `clearance` always places
  both parts at identity in the shared comparison frame. Two clearance parts
  authored in unrelated coordinate systems must already share one frame
  before this CLI can check them -- `estimateAlignment` is not wired up.
  `analyzeModelPair`'s `axis-aligned-box-solid` exact method is not exposed
  either; `compare` always requests `surface-distance`.
- No `printability`/`simplify`/`measure`/`section`/`diagnoseMeshHealth`
  commands. Those `@voxelspy/analysis` entry points are not part of this
  slice's command surface.

## Verification

```sh
pnpm install
pnpm --filter @voxelspy/cli lint
pnpm --filter @voxelspy/cli typecheck
pnpm --filter @voxelspy/cli test
pnpm --filter @voxelspy/cli build
```

Tests (`vitest`) generate small STL/OBJ fixtures in a temporary directory
and exercise the command layer directly (no subprocess spawning): each
command's happy path, every policy option's pass and fail branch, `--json`
shape and determinism, a work-budget-exhausted indeterminate run, an
unresolved-source-frame import failure, and bad usage (missing arguments,
missing required options, out-of-range option values, unknown flags).

Within this workspace (the package is private and unpublished), run the
built CLI directly:

```sh
node apps/cli/dist/cli.js compare baseline.stl candidate.stl \
  --tolerance 0.05 --baseline-unit millimetre --baseline-axis right-handed-z-up \
  --candidate-unit millimetre --candidate-axis right-handed-z-up
```

A real install (`npm install -g` from a published tarball, which this
package does not currently produce) would expose this as the `voxelspy`
binary named in `package.json#bin`.
