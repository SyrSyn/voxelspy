# VoxelSpy web application

This package contains the static public site, browser-local comparison entry point, and documentation routes.

## Development

From the repository root:

```sh
pnpm exec turbo run build --filter=@voxelspy/web
pnpm --filter @voxelspy/web dev
```

The production build prerenders every declared route and emits static files in `apps/web/dist`. Run the package checks with:

```sh
pnpm exec turbo run lint typecheck test build --filter=@voxelspy/web
```

## Privacy boundary

Normal model selection and comparison are browser-local. The application does not require hosted identity, storage, telemetry, or a model API. Any future network-backed feature must expose its destination and require a deliberate action.

Every tool's file input accepts the same subset `@voxelspy/importers` reads -- STL, OBJ, glTF/GLB (static mesh geometry only), 3MF (Core mesh geometry only), and STEP (bounded tessellation through the optional isolated kernel) -- derived from that package's own `SupportedFormat`/`importerDescriptor` in `src/formats.ts`, the single place this app's accepted-extension list and `accept` attribute are defined, so a file with an unsupported extension is refused up front with a message naming what is supported. Import plus sampled surface-distance analysis run in a dedicated browser worker.

STL and OBJ do not authoritatively declare a unit or an up-axis, so the interface begins with millimetres and right-handed Z-up for those two formats and exposes alternate interpretations as expert settings. glTF/GLB and 3MF are different: both declare their own frame in the file itself (glTF/GLB always metres and right-handed Y-up per specification; 3MF its own declared unit, defaulting to millimetre, and right-handed Z-up per the Core specification's coordinate-space section), so the interface never asks for a unit/axis choice it does not need for these two formats -- it resolves and shows the declared frame, with an explicit override still available and recorded distinctly (as a user override, not as if the file itself had declared it) from the file's own declaration. Every provenance panel in this app shows the detected value, the resolved value, and which of "embedded in the file", "import default", or "expert override" produced it.

The comparison form exposes an analysis RAM allowance from 128 MiB to 768 MiB, in 128 MiB steps. It is a fail-closed estimate ceiling rather than preallocated memory; raising it also gives the worker a proportionally larger compute budget. The slider's starting value is a device-aware recommendation from `src/capability.ts`, computed client-side from whatever of `navigator.deviceMemory`, `navigator.hardwareConcurrency`, and a coarse-pointer (touch/mobile) signal the browser happens to expose. Every reading is optional and can be unavailable (`deviceMemory` is Chromium-only); an unavailable reading always degrades toward the previous fixed default of 256 MiB rather than a larger allowance, and mobile/touch or low-core devices are capped at 256 MiB regardless of reported memory. A plain-language explanation of the recommendation is shown next to the control, and the recommendation is never a hard cap -- the full 128-768 MiB range stays selectable. Before running, the form also shows a rough, non-binding estimate of whether the chosen files are likely to exceed the chosen allowance, based on file size alone; it is honestly approximate, not a substitute for the analysis package's own fail-closed resource-budget check. The browser client reports at most the 24 highest-ranked changed regions so rendering evidence remains bounded. Larger allowances can take longer or exhaust the resources available to a browser tab. A browser without Web Worker support cannot run local comparison at all; the form detects this during the same capability preflight and disables the run with a clear explanation instead of letting it fail with a raw error.

The workbench keeps the selected source frame, normalization transform, importer provenance, import warnings and notes, analysis warnings, and approximation uncertainty available alongside the result. Selecting a replacement file restores the common source-frame defaults so an expert override cannot accidentally carry to a different model.

The compare workbench can save a completed comparison as a portable `.voxelspy` session (both source models, the analysis result, and the comparison configuration, written with `@voxelspy/session-archive`) and reopen one later, restoring the workbench directly without re-running the analysis. Saving is a deliberate, explicitly-labeled action; because the archive embeds both models' original geometry, saving one is itself a model-data transfer once you share the file.

The workbench also has an "Export report" action next to "Save session": it renders the comparison's findings, overview saved view, and geometry-summary narrative to one self-contained `.html` file (via `apps/web/src/report/`) and downloads it directly, with no network step. Unlike a saved session, an export does not embed either model's raw geometry -- it embeds provenance, analysis findings, and metrics. Both actions depend on an asynchronous geometry-presentation summary computed in a dedicated worker, so each button stays disabled -- with a visible, explained reason -- until that summary is ready.

## Static hosting

The build produces route-specific HTML for direct navigation and a static `404.html`, plus a `_headers` file declaring the security policy and caching rules. No provider-specific runtime, server function, or fallback rewrite is required. A production origin and provider configuration are intentionally outside this package.

See [DEPLOYMENT.md](DEPLOYMENT.md) for build output, host requirements, the verification list to run against a deployment target, cutover, and rollback.

## Expanded local workflows

Inspect, Forensics, Measure & Section and Printability provide local
versioned evidence JSON downloads, including source provenance, limits and
qualifications without original mesh buffers. Mesh Health deliberately runs a
separate bounded self-intersection check, reporting source triangle locations
and indeterminate outcomes rather than promising repair or solid validity.

Comparison review supports callouts, distance markups and named camera views.
Their references are bound to source digests, normalization and analysis
interpretation; changing those inputs invalidates stale review state. Portable
sessions retain review state and model geometry; HTML reports escape user text.

Convert offers a bounded optional original/result preview and glTF/GLB/3MF
exports in addition to STL/OBJ. A deliberate format choice selects and displays
the format's required output frame. Precision, flattened hierarchy and
simplification qualifications remain visible beside downloads.

STEP uses separately replaceable same-origin JS/WASM assets. Static builds
include license notices and hash-pinned corresponding sources. Its classic
kernel worker needs the exact worker-specific header replacement in
`public/_headers`; application pages retain their stricter CSP. See
[distribution details](../../third-party/step/README.md). The worker has a
60-second termination limit; upstream kernel memory and semantic behavior are
not proven bounded by that deadline. STEP units are resolved from supported
source declarations, while the up-axis is declared explicitly.

Run all browser engines under shipped headers with
`playwright.complete.config.ts`. Headless Firefox environments without WebGL
exercise accessible renderer fallbacks; the other configured engines exercise
real canvases. Physical-device acceptance remains separate.

## Optional same-origin hosted workbench

The free site has no API or authentication dependency. An opt-in iframe build
reuses the same eight tools with a mount-local source provider; it never sends
model data to a server. Build its dependencies with Turbo first, then produce
only the separate relative-asset bundle:

```sh
pnpm exec turbo run build --filter=@voxelspy/web
VOXELSPY_EMBED_BUILD=1 pnpm --filter @voxelspy/web exec vite build
```

Serve `dist-embed/` beneath `/workbench/` and open
`/workbench/embed.html?tool=inspect`. Supported tool identifiers are `compare`,
`inspect`, `mesh-health`, `measure-section`, `clearance-fit`, `printability`,
`file-forensics` and `convert`. The host must replace the free site's
`frame-ancestors 'none'` response policy with `frame-ancestors 'self'` only for
this authenticated route, and retain the dedicated STEP kernel worker policy.
Do not change the free site's headers to enable embedding.

The public `@voxelspy/contracts/hosted` version 1 protocol carries no credentials
or authorization claims. The iframe accepts loads only from its exact parent
window and origin, verifies bounded original source bytes against SHA-256 and
recorded normalization provenance, then supplies `File` objects directly to
React source selections. Compare and Clearance require two ordered revisions;
the other tools require one. Recorded unit/axis resolution origins are replayed
independently. An optional comparison session must match those exact source
names, digests and provenance. A new load remounts tools and cancels their
workers; stale callbacks cannot emit artifacts for a newer request.

An explicit evidence, report, session or conversion download also stages an
artifact with the current request and revision identities for deliberate saving
by the parent. Local downloads keep their existing native format. Hosted
`evidence-json` uses `hostedEvidenceSchema` to wrap that native evidence with its
ordered source metadata. Converted attachments include the actual output format,
unit and axis; they are never automatically registered as a new revision.
Changing a source or its frame makes a result ineligible for host staging.
HTML reports remain untrusted client-submitted attachments: the host should
force download and sandbox them, not inject their markup into its application.

The separate `playwright.embed.config.ts` suite exercises this optional build
under a same-origin frame policy, including actual preload, worker output,
artifact bytes and comparison session restoration. The default free-site build
and browser suite do not require or serve the hosted entry.
