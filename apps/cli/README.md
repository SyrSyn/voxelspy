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

## Automation output (`--sarif`, `--markdown`)

Every command additionally accepts two output-file options, independent of
(and combinable with) `--json`:

- **`--sarif <path>`** writes a [SARIF](https://sarifweb.azurewebsites.net/)
  2.1.0 log to `<path>`, for a code-scanning system (GitHub code scanning,
  or any other SARIF consumer) to ingest the same way it ingests a linter or
  SAST tool. `--sarif` (a file path) was chosen over a `--format sarif`
  stdout mode because SARIF, `--json`, and the human-readable text summary
  are three independent, simultaneously useful outputs for a CI step (a bot
  posts the Markdown as a PR comment, uploads the SARIF as a code-scanning
  artifact, and still wants the text summary in the job log) -- forcing a
  single `--format` choice would make that combination require running the
  command twice.
- **`--markdown <path>`** writes a compact Markdown summary to `<path>`,
  the kind of text a CI bot posts as a pull-request comment or a job
  summary: what was compared, the verdict, the key numbers, and the
  caveats.

**Neither option changes the process exit code.** Exit codes are decided
exactly as documented above, before either file is written; a policy
failure still exits `1` (and an indeterminate outcome still exits `2`)
whether or not `--sarif`/`--markdown` were passed. A usage error (exit `3`,
caught before any engine runs) writes neither file -- there is no result to
report, and stderr already carries the message.

### SARIF rule catalogue and level mapping

Every SARIF result maps to exactly one of these rule ids, with a level
fixed per rule (never chosen ad hoc per finding) -- defined in
`src/sarif.ts`:

| Rule id | Level | Emitted when |
| --- | --- | --- |
| `deviation-exceeds-threshold` | `error` | `compare --max-deviation` failed |
| `region-count-exceeds-threshold` | `error` | `compare --fail-on-regions` failed |
| `not-watertight` | `error` | `compare`/`inspect --require-watertight` failed |
| `non-manifold-edges` | `error` | `inspect --fail-on-non-manifold` failed |
| `degenerate-triangles` | `error` | `inspect --fail-on-degenerate` failed |
| `clearance-violation` | `error` | `clearance`'s fit-gate check failed (`"tight"` without `--allow-tight`, or `"interfering"`) |
| `indeterminate-analysis` | `error` | the outcome was indeterminate, a resource-limit refusal, or a work-budget ceiling -- **always recorded, independent of `--fail-on-indeterminate`**, which only changes the exit code, never whether this finding exists |
| `approximate-result` | `note` | **always recorded** on every `compare`/`clearance` run (their method is always `semantics: "approximate"`), whether the run passed or failed |
| `undersampled-region` | `warning` | on top of `approximate-result`, whenever the sample-spacing bound exceeds the requested tolerance/clearance |

### Honesty rules this mapping follows

- **An unproven pass is never silently "clean."** `compare`/`clearance` are
  always approximate methods (sampled at each triangle's vertices and
  centroid), so `approximate-result` is recorded on every run regardless of
  outcome -- `results: []` never means "nothing to disclose" for an
  approximate method, only "no policy violation." `inspect`'s topology
  findings are exact (not sampled), so a genuinely clean `inspect` run can
  legitimately produce zero results.
- **No invented source positions.** A geometry finding has no line number.
  Every result's `locations` point only at the model file(s) involved
  (`physicalLocation.artifactLocation.uri`, using the same source file name
  the text/`--json` output reports), with no `region` -- region/triangle
  evidence (changed-region ids and anchors, topology-finding examples,
  interfering-triangle-pair counts) goes in the result's `message` text and
  `properties` instead.
- **A policy failure is `error`; indeterminate is never a pass.** Both are
  SARIF's strongest severity short of a tool crash, matching that both are
  hard CI-gate conditions -- `error` regardless of whether the specific
  `--fail-on-*` flag that would promote the process exit code was passed.
- **Provenance travels with the run, not just the exit code.** Every SARIF
  log's `runs[0].properties` carries the same method id/version, effective
  tolerance (or desired clearance), `semantics`, and `uncertainty`
  (description + sample-spacing-bound parameters) the text/`--json` output
  already reports, so a SARIF consumer never has to re-derive them.

### Determinism

No SARIF result carries a generated timestamp or random identifier.
`invocations[].startTimeUtc` is the one place SARIF conventionally records
a timestamp; this CLI only ever sets it from an explicitly-supplied value
(exposed as an internal `timestampUtc` builder option, not currently wired
to a CLI flag since nothing in this slice needs it) and omits `invocations`
entirely by default. Running the same command with the same `--sarif`/
`--markdown` paths twice therefore produces byte-identical files, matching
the determinism guarantee `--json` already makes.

### Using the example workflow

`.github/workflows/geometry-check.yml` is a `workflow_dispatch`-triggered
example wiring this together: build the workspace, generate two tiny
synthetic STL fixtures, run `voxelspy compare --sarif --markdown` against
them, upload the SARIF (both as a build artifact and via
`github/codeql-action/upload-sarif` for code scanning), post the Markdown
to the job summary, and fail the job when the policy gate fails. It is a
template to copy and adapt -- as written it compares two throwaway
fixtures, not any real, versioned asset in this repository -- see the
comments at the top of that file for exactly what it does and does not
demonstrate.

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
