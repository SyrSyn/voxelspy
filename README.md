# VoxelSpy

VoxelSpy is a free, open-source toolkit for understanding geometric changes between 3D models. The first release is a local-first browser application: load two revisions, inspect what changed, measure the difference, annotate findings, and export a reproducible report without uploading the models during normal use.

The project is in its contract-foundation stage. Versioned repository contracts are accepted for the first implementation, but supported adapters, browser limits, and release claims still require fixture and runtime evidence.

## Direction

VoxelSpy is being designed around three layers:

- A zero-install web inspector for STL, 3MF, OBJ, glTF/GLB, and STEP files.
- Reusable TypeScript packages and headless tooling for application and CI integrations.
- A future self-hosted product-data-management service for private teams.

The browser tool will normalize input into an explicit engineering coordinate system, keep source and user transforms auditable, run heavy analysis outside the UI thread, and distinguish exact, approximate, and indeterminate results. The initial workflow centers on synchronized old, new, and diff views with ranked change regions, compact measurements, saved views, markups, reports, and portable sessions.

## Repository status

This repository contains the public project foundation and the accepted version 1 data boundaries for geometry, import, analysis, review reports, portable sessions, worker transport, adapter evidence, and release gates. These contracts are an implementation baseline inside the repository; the package remains private and unpublished, and its `0.1.0` version is not an independent stability promise.

The browser application and production adapters are not implemented yet. Format support, analysis accuracy, performance limits, accessibility, and browser readiness remain release-gated claims that require the evidence defined by the contracts.

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

Additional commands will be documented as runnable packages are added. See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution and verification expectations.

## Privacy and security

The public browser experience is intended to perform normal model comparison locally. Network behavior and third-party assets must remain explicit and auditable. This is a design target, not a claim that unfinished software is production-ready. See [PRIVACY.md](PRIVACY.md) and [SECURITY.md](SECURITY.md).

## License

VoxelSpy is available under the [MIT License](LICENSE). Geometry fixtures and third-party components may carry their own compatible licenses and provenance records.
