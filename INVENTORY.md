# Implementation inventory and acceptance

This inventory describes current local source, including the authorized backlog
implementation. Historical [release evidence](RELEASE-EVIDENCE.md) is retained;
its original feature and test counts are not a current inventory. Implemented
code does not establish physical-device performance or production readiness.

## Current capabilities

| Area                   | Available                                                                                                                                 | Boundary                                                                                                                              |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Import                 | ASCII/binary STL, OBJ subset, static glTF/GLB, 3MF Core, optional STEP kernel                                                             | Bounded subsets; explicit units, transforms, warnings and provenance; STEP tessellation is not analytic CAD preservation              |
| Compare                | Worker-based sampled surface distance, synchronized views, ranked changes, deliberate alignment                                           | Sampling can miss sub-spacing features; unsigned distances do not prove solid equivalence                                             |
| Inspect                | Dimensions, area, conditional volume, topology, visual diagnostics and evidence download                                                  | Volume remains conditional; normal inspection does not implicitly perform self-intersection detection                                 |
| Mesh Health            | Separate bounded self-intersection analysis with source triangle locations and evidence download                                          | Exact predicates on represented transformed coordinates; budget, degenerate and numerical refusals remain indeterminate; no repair    |
| Measure & Section      | Surface/coordinate measurements, plane sections, loops, perimeter and conditional area; evidence download                                 | Coincident faces and open sections retain limitations                                                                                 |
| Clearance & Fit        | Explicit rigid placement, sampled separation, tight regions and triangle intersections                                                    | No interference volume or guaranteed minimum separation                                                                               |
| Printability           | Thickness probes, overhangs, islands, build-volume fit and evidence download                                                              | Operator evidence, not printer/material approval                                                                                      |
| File Forensics         | Structure, digest, frame resolution, importer warnings/refusals and evidence download                                                     | Shows supported interpretation rather than arbitrary file contents                                                                    |
| Convert                | Simplification with measured sampled deviation, optional geometry preview; STL/OBJ/glTF/GLB/3MF exports                                   | Bounded preview; explicit export frames and precision/flattening warnings; sampled deviation is not a universal bound                 |
| Review                 | Callouts, distance markups, named camera views, HTML report and portable source-embedding session                                         | Source-bound references and stale-state checks; sharing a session shares model geometry                                               |
| CLI                    | Compare, inspect, clearance with rigid placements, measurements, sections and printability                                                | Existing engine limits and policy exit semantics remain; no stronger automated manufacturing verdict                                  |
| React                  | Comparison/inspection plus clearance, measurement, sections, printability, simplification and alignment hooks                             | Transferable ownership is explicit; heavy simplified geometry is held outside UI state                                                |
| Release infrastructure | Versioned contracts, bounded archives, static prerendering, privacy checks and cross-engine CSP test configuration                        | External CI, physical hardware and deployed headers need their own observed acceptance                                                |
| Team/PDM               | Self-hosted shared eight-tool workspace, private projects, immutable revisions/artifacts, annotations, saved sessions, comments and audit | Separate identity/storage boundary; local qualification only, with physical devices, public hosting and off-host recovery unqualified |

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

The initial PDM prototype passed its profile/theme/capability checks, lint,
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
acceptance. Package publication and public deployment are not established by local tests.
Observed repository CI is recorded below. No package publication or public
hosting change is part of this local implementation.

## Integrated self-hosted suite

The integrated workflows are built and qualified for the approved local scope.
The separate PDM consumer embeds the same eight toolkit components and workers
from pinned toolkit revision `8f79ca4`; it does not fork their UI or engines.
The free static toolkit continues to work without identity, PDM APIs, uploads
or persistence.

- Opening a project tool deliberately downloads currently authorized exact
  revisions and verifies their sizes, source digests and recorded frames.
- Native downloads remain local. A separate save action retains source-bound
  evidence, portable sessions, HTML reports or converted outputs as immutable
  project artifacts with append-only comments. HTML is attachment-only;
  converted outputs do not silently become source revisions.
- Reopening a session reauthorizes its exact source pair and restores authored
  callouts, distance markups and named views. Changing project, source, tool or
  authority clears the active frame and staged bytes.
- All eight tools support the shared workspace, including STEP. Explicit axis
  declarations and user corrections retain distinct provenance. Metadata key
  order may change in storage without changing any bound value or array order.
- Current permissions, replay identity, quotas, archive/history retention,
  corrupt-storage refusal and stale-message rejection are exercised through
  actual browser/API workflows.

### Observed qualification

The toolkit passes `pnpm check`: 28 tasks and 863 unit tests. Both GitHub CI jobs
passed at `8f79ca4`, including 617 browser cases and three intentional desktop
skips for the touch-only check. The optional embedded workbench passed 50 cases
across desktop/mobile Chromium, Firefox and desktop/mobile WebKit. These include
actual STEP staging and byte-identical saved-session reopening after metadata
key reordering; no page errors or off-origin requests were observed.

The PDM consumer passes its full check, clean dependency audit, 51 unit tests
and production build. Ten actual desktop/emulated-phone journeys pass without
skips or retries: all eight native tools, source/frame geometry oracles,
conversion downloads, annotations/views, retained comments, saved-session
reopening, STEP and Viewer revocation. A separate direct API matrix passes
source/provenance tampering, private authority, replay conflicts, quotas,
corrupt objects, archived history and STEP declaration/refusal checks.

The upgrade rehearsal retains all 13 original public-table fingerprints and
24 original source objects across the additive artifact migration. A fresh
same-version integrated restore retains all 15 tables / 3,259 rows and every
one of 1,005 stored objects, with exact sizes, SHA-256 digests and revision or
artifact bindings. Authenticated legacy/report downloads, anonymous/outsider
refusals and an actual annotated-session/named-view reopening pass; all table
and object fingerprints remain identical afterward. A tampered bundle refuses
before creating target resources. Restore workers remain absent and qualified
restore services are stopped with their data retained.

The original local PDM app and worker are upgraded to the qualified runtime.
All 13 original table fingerprints matched before the deliberate sign-in
check, all 24 original source objects remain byte-identical, and both new
artifact tables started empty. Health, jobs, authenticated legacy downloads,
all eight protected tool routes and actual inspection of an existing revision
pass. No other application installation was upgraded.

Physical devices, external hosting/identity/mail, off-host recovery and
production acceptance remain unqualified. Local restore requires the retained
exact application image; it does not establish recovery after host loss.
