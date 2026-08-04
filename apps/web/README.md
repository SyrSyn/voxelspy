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

The comparison action currently remains visible but disabled until validated importer and analysis packages are connected. The interface states that boundary directly instead of implying unavailable behavior.

## Static hosting

The build produces route-specific HTML for direct navigation and a static `404.html`. No provider-specific runtime, server function, or fallback rewrite is required. A production origin and provider configuration are intentionally outside this package.
