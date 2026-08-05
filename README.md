# VoxelSpy

VoxelSpy is a free, open-source toolkit for understanding geometric changes between 3D models. The first release is a local-first browser application: load two revisions, inspect what changed, measure the difference, annotate findings, and export a reproducible report without uploading the models during normal use.

The project is in a pre-release implementation stage. Versioned repository contracts are accepted, and the first browser-local comparison slice is implemented. Broader format support, accuracy claims, performance tiers, accessibility, and release readiness still require fixture and runtime evidence.

## Direction

VoxelSpy is being designed around three layers:

- A zero-install web inspector for STL, 3MF, OBJ, glTF/GLB, and STEP files.
- Reusable TypeScript packages and headless tooling for application and CI integrations.
- A future self-hosted product-data-management service for private teams.

The browser tool will normalize input into an explicit engineering coordinate system, keep source and user transforms auditable, run heavy analysis outside the UI thread, and distinguish exact, approximate, and indeterminate results. The initial workflow centers on synchronized old, new, and diff views with ranked change regions, compact measurements, saved views, markups, reports, and portable sessions.

## Repository status

This repository contains the public project foundation and the accepted version 1 data boundaries for geometry, import, analysis, review reports, portable sessions, worker transport, adapter evidence, and release gates. These contracts are an implementation baseline inside the repository; the package remains private and unpublished, and its `0.1.0` version is not an independent stability promise.

The static browser application currently imports bounded ASCII or binary STL and a documented OBJ subset. It starts each source in millimetres and right-handed Z-up, keeps alternate source frames available as expert settings, normalizes into the canonical frame, runs approximate sampled surface-distance analysis in a dedicated browser worker, and opens synchronized difference, baseline, and candidate views. Import provenance, warnings, method semantics, uncertainty, and useful geometry summaries remain visible in the result. Portable report/session export, annotations, hosted services, and the other formats in the project direction are not connected to this workflow.

Implementation ceilings are fail-closed safety bounds, not general model-size or production-readiness claims. See the web, importer, and analysis package READMEs for the exact supported subsets and method limits.

The intended workspace layout is:

```text
apps/       User-facing applications
packages/   Reusable runtime and UI packages
fixtures/   Licensed, attributable geometry fixtures
spikes/     Time-bounded technical evidence
```

## Development

Requirements:

- Node.js 24 or newer
- Corepack

```sh
corepack enable
pnpm install
pnpm check
```

Run the web application locally with:

```sh
pnpm --filter @voxelspy/web dev
```

Package-specific checks and limits are documented in the READMEs under `apps/` and `packages/`. See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution and verification expectations.

## Privacy and security

The implemented comparison path reads source files, imports geometry, and runs analysis locally in the browser without a model API, hosted identity, storage, or telemetry. Network behavior and third-party assets must remain explicit and auditable. This local boundary does not make the pre-release software production-ready. See [PRIVACY.md](PRIVACY.md) and [SECURITY.md](SECURITY.md).

## License

VoxelSpy is available under the [MIT License](LICENSE). Geometry fixtures and third-party components may carry their own compatible licenses and provenance records.
