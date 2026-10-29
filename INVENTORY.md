# Implementation inventory and acceptance

This inventory describes current local source, including the authorized backlog
implementation. Historical [release evidence](RELEASE-EVIDENCE.md) is retained;
its original feature and test counts are not a current inventory. Implemented
code does not establish physical-device performance or production readiness.

## Current capabilities

| Area                   | Available                                                                                                                     | Boundary                                                                                                                           |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Import                 | ASCII/binary STL, OBJ subset, static glTF/GLB, 3MF Core, optional STEP kernel                                                 | Bounded subsets; explicit units, transforms, warnings and provenance; STEP tessellation is not analytic CAD preservation           |
| Compare                | Worker-based sampled surface distance, synchronized views, ranked changes, deliberate alignment                               | Sampling can miss sub-spacing features; unsigned distances do not prove solid equivalence                                          |
| Inspect                | Dimensions, area, conditional volume, topology, visual diagnostics and evidence download                                      | Volume remains conditional; normal inspection does not implicitly perform self-intersection detection                              |
| Mesh Health            | Separate bounded self-intersection analysis with source triangle locations and evidence download                              | Exact predicates on represented transformed coordinates; budget, degenerate and numerical refusals remain indeterminate; no repair |
| Measure & Section      | Surface/coordinate measurements, plane sections, loops, perimeter and conditional area; evidence download                     | Coincident faces and open sections retain limitations                                                                              |
| Clearance & Fit        | Explicit rigid placement, sampled separation, tight regions and triangle intersections                                        | No interference volume or guaranteed minimum separation                                                                            |
| Printability           | Thickness probes, overhangs, islands, build-volume fit and evidence download                                                  | Operator evidence, not printer/material approval                                                                                   |
| File Forensics         | Structure, digest, frame resolution, importer warnings/refusals and evidence download                                         | Shows supported interpretation rather than arbitrary file contents                                                                 |
| Convert                | Simplification with measured sampled deviation, optional geometry preview; STL/OBJ/glTF/GLB/3MF exports                       | Bounded preview; explicit export frames and precision/flattening warnings; sampled deviation is not a universal bound              |
| Review                 | Callouts, distance markups, named camera views, HTML report and portable source-embedding session                             | Source-bound references and stale-state checks; sharing a session shares model geometry                                            |
| CLI                    | Compare, inspect, clearance with rigid placements, measurements, sections and printability                                    | Existing engine limits and policy exit semantics remain; no stronger automated manufacturing verdict                               |
| React                  | Comparison/inspection plus clearance, measurement, sections, printability, simplification and alignment hooks                 | Transferable ownership is explicit; heavy simplified geometry is held outside UI state                                             |
| Release infrastructure | Versioned contracts, bounded archives, static prerendering, privacy checks and cross-engine CSP test configuration            | External CI, physical hardware and deployed headers need their own observed acceptance                                             |
| Team/PDM               | Separate approved TanStack consumer with local identity, private workspaces, immutable revisions, reviews, comments and audit | Separate repository/storage boundary; qualified local prototype uses a historical five-format engine snapshot; no production claim |

The catalog now exposes eight tools. Scale, Volume and Watertightness remain
focused Inspect entry points. See [analysis](packages/analysis/README.md),
[importers/exporters](packages/importers/README.md), [CLI](apps/cli/README.md),
[React](packages/react/README.md), and [PDM plan](PDM-PLAN.md).

## Current improvements and backlog disposition

| Original inventory item    | Implementation and acceptance boundary                                                                                             |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Bound CLI allocation       | Size checked before allocation, growth guarded and resource refusal preserved                                                      |
| Bound encoded exports      | 32 MiB output ceiling; Float32 overflow refused; previous accepted STL/OBJ output retained                                         |
| Resilient theme            | Blocked storage tolerated; System follows OS changes; explicit preference remains stable                                           |
| Single-model downloads     | Versioned local JSON with source/provenance, evidence and limitations; no source buffers                                           |
| CLI coverage               | Measurement, section, printability and explicit clearance placement implemented                                                    |
| Conversion preview         | Bounded geometry clones displayed deliberately; worker originals retained for later exports                                        |
| Annotations and views      | Authored markups and actual camera views retained in session/report with stale binding checks                                      |
| Self-intersection evidence | Bounded detector, independent fixtures and separate Mesh Health workflow implemented                                               |
| STEP import                | Reviewed optional kernel, worker isolation, explicit tessellation provenance and corresponding source/license delivery implemented |
| Reusable integration       | Six additional operation hooks with versioned transport, cancellation, recovery and explicit buffer ownership                      |
| Release qualification      | Repository and full cross-engine/CSP qualification passed; physical acceptance checklist prepared                                  |
| Future team/PDM            | Owner-approved local application qualified with authorization, integrity, desktop/phone and same-version restore checks            |
| Wider conversion output    | Deterministic glTF/GLB and 3MF writers with explicit format frame requirements and encoded-byte limits                             |

No geometry repair, silent alignment, source rescaling or universal Boolean
comparison is introduced by these changes. Approximate methods retain their
own qualifications; complete and indeterminate outcomes are distinguished.

## Verification

The initial safety batch passed an uncached `pnpm check`: 28 tasks and 758 unit
tests, followed by 67 CSP browser passes and one intentional mobile keyboard
skip. Those counts describe the earlier batch only.

The security-patched integration passed an uncached `pnpm check`: all 28 tasks
and 856 unit tests (53 contracts, 59 session archives, 251 analysis, 146 importers,
56 React, 113 CLI and 178 web). `pnpm audit` reports no known vulnerabilities
across production and development dependencies. CI now enforces that audit.
The security upgrade also makes test-only Node types explicit and handles a
missing offline package tarball during installed-consumer verification.

Additional real-browser React checks passed in all five browser configurations:
all six operation hooks, independent geometry oracles, cancellation, recovery,
superseded runs, input-buffer detachment and unmount cleanup. All 75 workers
terminated; no page errors or off-origin requests were observed. The built CLI's
isolated STEP worker preserved an original inch fixture's independent dimensions
and offset. An additional real STEP comparison/session check passed in Chromium,
Firefox and WebKit: an independent 1 mm offset oracle, source and report digests,
reopen, byte-identical resave, second reopen and rendered HTML all matched.
Reopening a session now retains its source bytes for subsequent saves instead of
transferring away the retained archive buffers. A maintained browser regression
checks the full reopen/resave/reopen workflow.

The final complete application-browser run passed 617 cases with three
intentional desktop skips for the touch-only check, across desktop/mobile
Chromium, desktop Firefox and desktop/mobile WebKit with shipped CSP headers.
This includes STEP integrity refusal/recovery, conversion downloads, review
authoring and portable-session resaving. All 67 shipped build files matched
their recorded sizes and SHA-256 digests after qualification.

The separate PDM consumer passed its profile/theme/capability checks, lint,
typecheck, production build, 24 unit tests, clean dependency audit, additional
email/storage/file UI/jobs checks and six desktop/emulated-phone journeys.
Independent review verified same-version restore fingerprints for 13 complete
tables and all 24 retained source objects, matching authenticated download
digests, anonymous denial and corrupt-bundle refusal. Restore services were
stopped with their data retained; the source prototype remains available locally.
Recovery requires its retained exact local image; off-host/host-loss recovery
and physical-device acceptance are not claimed. Its engine snapshot supports
STL/OBJ/glTF/GLB/3MF, uses patched Zod and labels computation as client submitted.

Use the task runner so dependencies build before their consumers:

```sh
pnpm check
pnpm exec turbo run lint typecheck test build --filter=@voxelspy/web
pnpm --filter @voxelspy/web exec playwright test --config=playwright.complete.config.ts
```

The complete browser configuration runs Chromium, Firefox and WebKit, including
mobile Chromium/WebKit layouts, against the shipped security headers. The
repository check does not itself execute Playwright. STEP first builds fetch
hash-pinned corresponding source archives; a populated local source cache permits
offline rebuilds. See [STEP distribution notices](third-party/step/README.md).

Physical checks remain pending. [DEVICE-ACCEPTANCE.md](DEVICE-ACCEPTANCE.md)
covers phones and Windows/Linux laptops; emulation is not physical-device
acceptance. Publication, public deployment and external CI are not established
by local tests. No package publication or public hosting change is part of this
local implementation.

## Stopping checkpoint

### Integrated self-hosted suite: in progress

The earlier checkpoint below describes the standalone toolkit and bounded PDM
prototype. It does **not** establish completion of the integrated self-hosted
product. The authorized integration now requires:

- One pinned toolkit source revision and engine build for all eight tools in
  the self-hosted workspace, including STEP; no independently forked tool UI.
- Deliberate, currently authorized project-revision loading with verified source
  digests and recorded frame interpretation.
- Explicit saving of source-bound tool evidence, comparison sessions with
  annotations/views, reports and derived conversion outputs as immutable
  project artifacts, with retained comments and reopening.
- Current permission checks, resource bounds, tamper/stale-message refusal,
  archive/history retention, migration/restore checks and integrated browser
  acceptance.
- Independent free-site behavior: no required identity, PDM API, persistence or
  model uploads.

Implementation and final integrated acceptance remain in progress until these
workflows have been exercised together. The shared workbench and source-bound
artifact APIs are built and committed. The free toolkit passed `pnpm check`
(all 28 tasks; 862 unit tests), then its complete browser run passed 617 cases
with three intentional desktop touch-only skips. All 67 shipped files retained
their recorded hashes. The optional embedded workbench passed 50 browser cases
across all five browser configurations. Toolkit CI passed both jobs at
`5a82ffe`.

The PDM integration and pinned-source packaging are pushed in `c612b99`; its
GitHub check passes, including a fresh shared-workbench build, 47 unit tests,
type checking, lint, clean dependency audit and production build. Final
integrated desktop/phone journeys and retained-data upgrade/restore checks
remain active. These checkpoints do not establish integrated acceptance yet.

### Earlier standalone checkpoint

All original inventory implementation slices and the approved local PDM scope
are present. The qualified toolkit implementation is committed in `8198640` and
pushed to the existing repository with maintainer authorization. GitHub CI is
separate from the local evidence above; no public application deployment or
package release is claimed. The local PDM source services remain running for
review, while its restore rehearsal is stopped with retained data. Subagents
have finished and their temporary check servers are stopped.

The next acceptance work is the physical-device checklist, followed by any
separately authorized release or hosting qualification. Off-host recovery
needs an actual destination and rehearsal. The local PDM deliberately retains
its qualified historical engine snapshot rather than claiming the toolkit's
newer STEP and authored-review features.
