# Three-view workbench evidence spike

This local prototype tests whether three linked model views can remain legible and controllable across desktop and touch layouts. It uses deterministic generated geometry only; displayed findings are illustrative interaction evidence, not measurement results or accepted product contracts.

## Evidence questions

- Can orbit, pan, zoom, framing, clipping, selection, and ranked-region navigation share one compact interaction state across three independent renderers?
- Does a larger central difference view preserve enough context in the baseline and candidate views?
- Can added, removed, and shifted regions remain distinguishable without relying on color alone?
- Can compact layouts retain all three views while gating the analysis list behind an explicit control?

Geometry is created inside each rendering boundary and is not stored in React state. Shared state contains only camera coordinates, zoom, clipping percentage, theme, and selected region identifiers. This is intentionally a prototype and does not define import, analysis, report, or persistence APIs.

## Run locally

```sh
pnpm install
pnpm dev
```

Use drag to orbit, right-drag to pan, wheel or pinch to zoom, `F` to fit all, and the arrow or bracket keys to step through ranked regions.

## Verify

```sh
pnpm check
pnpm exec playwright install chromium
pnpm test:e2e
```

The browser suite exercises renderer-observed camera synchronization, framing, material clipping, theme changes, keyboard navigation, compact-layout accessibility gating, horizontal-overflow checks, and an explicit disabled-WebGL fallback at representative desktop, tablet, and mobile viewports.
