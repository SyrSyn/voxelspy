# VoxelSpy web application

This package contains the static public site, browser-local comparison entry point, and documentation routes.

## Development

From the repository root:

```sh
pnpm --filter @voxelspy/web dev
```

The production build prerenders every declared route and emits static files in `apps/web/dist`. Run the package checks with:

```sh
pnpm --filter @voxelspy/web lint
pnpm --filter @voxelspy/web typecheck
pnpm --filter @voxelspy/web test
pnpm --filter @voxelspy/web build
```

## Privacy boundary

Normal model selection and comparison are browser-local. The application does not require hosted identity, storage, telemetry, or a model API. Any future network-backed feature must expose its destination and require a deliberate action.

STL and OBJ import plus sampled surface-distance analysis run in a dedicated browser worker. Because those formats do not authoritatively declare units or an up-axis, the interface begins with millimetres and right-handed Z-up and exposes alternate interpretations as expert settings.

The comparison form exposes an analysis RAM allowance from 128 MiB to 768 MiB, in 128 MiB steps. It is a fail-closed estimate ceiling rather than preallocated memory; raising it also gives the worker a proportionally larger compute budget. The slider's starting value is a device-aware recommendation from `src/capability.ts`, computed client-side from whatever of `navigator.deviceMemory`, `navigator.hardwareConcurrency`, and a coarse-pointer (touch/mobile) signal the browser happens to expose. Every reading is optional and can be unavailable (`deviceMemory` is Chromium-only); an unavailable reading always degrades toward the previous fixed default of 256 MiB rather than a larger allowance, and mobile/touch or low-core devices are capped at 256 MiB regardless of reported memory. A plain-language explanation of the recommendation is shown next to the control, and the recommendation is never a hard cap -- the full 128-768 MiB range stays selectable. Before running, the form also shows a rough, non-binding estimate of whether the chosen files are likely to exceed the chosen allowance, based on file size alone; it is honestly approximate, not a substitute for the analysis package's own fail-closed resource-budget check. The browser client reports at most the 24 highest-ranked changed regions so rendering evidence remains bounded. Larger allowances can take longer or exhaust the resources available to a browser tab. A browser without Web Worker support cannot run local comparison at all; the form detects this during the same capability preflight and disables the run with a clear explanation instead of letting it fail with a raw error.

The workbench keeps the selected source frame, normalization transform, importer provenance, import warnings and notes, analysis warnings, and approximation uncertainty available alongside the result. Selecting a replacement file restores the common source-frame defaults so an expert override cannot accidentally carry to a different model.

The compare workbench can save a completed comparison as a portable `.voxelspy` session (both source models, the analysis result, and the comparison configuration, written with `@voxelspy/session-archive`) and reopen one later, restoring the workbench directly without re-running the analysis. Saving is a deliberate, explicitly-labeled action; because the archive embeds both models' original geometry, saving one is itself a model-data transfer once you share the file.

The workbench also has an "Export report" action next to "Save session": it renders the comparison's findings, overview saved view, and geometry-summary narrative to one self-contained `.html` file (via `apps/web/src/report/`) and downloads it directly, with no network step. Unlike a saved session, an export does not embed either model's raw geometry -- it embeds provenance, analysis findings, and metrics. Both actions depend on an asynchronous geometry-presentation summary computed in a dedicated worker, so each button stays disabled -- with a visible, explained reason -- until that summary is ready.

## Static hosting

The build produces route-specific HTML for direct navigation and a static `404.html`, plus a `_headers` file declaring the security policy and caching rules. No provider-specific runtime, server function, or fallback rewrite is required. A production origin and provider configuration are intentionally outside this package.

See [DEPLOYMENT.md](DEPLOYMENT.md) for build output, host requirements, the verification list to run against a deployment target, cutover, and rollback.
