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

The workbench keeps the selected source frame, normalization transform, importer provenance, import warnings and notes, analysis warnings, and approximation uncertainty available alongside the result. Selecting a replacement file restores the common source-frame defaults so an expert override cannot accidentally carry to a different model.

Portable report and session contracts exist in the workspace, but browser save and export actions are not connected yet.

## Static hosting

The build produces route-specific HTML for direct navigation and a static `404.html`. No provider-specific runtime, server function, or fallback rewrite is required. A production origin and provider configuration are intentionally outside this package.
