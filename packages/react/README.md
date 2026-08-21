# `@voxelspy/react`

Optional React hooks and components over `@voxelspy/analysis`'s public engine surface (`inspectModel`, `analyzeModelPair`). This package is `private: true` and unpublished, like every other package in this repository.

## What this package is for

`apps/web` proved a specific lesson the hard way: heavy geometry -- typed-array positions and indices, sometimes a million triangles -- must never sit in React state or run inside a render pass. Its geometry summary froze the UI until it was moved into a Web Worker. `@voxelspy/react` generalizes that fix into a small, reusable set of bindings so a new consumer gets the worker-backed, cancellable, non-blocking pattern by default, not as an opt-in a busy team skips under deadline pressure.

This package does not implement geometry math itself. Every measurement, verdict, and uncertainty figure it surfaces comes from `@voxelspy/analysis`, unmodified. This package's own job is narrower: run those calls off the main thread, expose their lifecycle as an honest status a component can render, and provide small presentational components that show a result without ever dressing up an approximation as exact or an indeterminate outcome as a pass.

## Install

Not published; consumed as a workspace package (`workspace:*`) inside this monorepo.

### Peer dependency

```json
{
  "peerDependencies": {
    "react": "^19.2.8"
  }
}
```

React is a peer dependency, not a bundled dependency -- this package ships no React of its own and does not pin a copy into your bundle. `react-dom` is not a dependency of this package at all: neither the hooks nor the components import it. If you use the components in a DOM app, you already have `react-dom` from your own app setup.

## Worker supply contract

**This is the part most likely to trip up a new consumer. Read it before writing any code against this package.**

`@voxelspy/react` cannot construct your Web Worker for you. `new Worker(new URL("./my-worker.ts", import.meta.url), { type: "module" })` has to be written in _your own source_, so _your own bundler_ (Vite, webpack, Rspack, ...) can recognize it, trace the worker's own module graph, and bundle it correctly. If this package tried to hide that call inside its own compiled code, most bundlers would no longer bundle the worker file at all -- it would try to load bare package source at runtime and fail.

So the contract is split in two:

- **This package owns the protocol.** `@voxelspy/react/worker` exports `createEngineWorkerHandler`, a function that builds the message handler your worker file registers. It runs `inspectModel`/`analyzeModelPair` from `@voxelspy/analysis` and posts back a structured response. This is the entire implementation your worker file needs -- it has no dependency on React, so it is safe to bundle standalone into a worker chunk.
- **You own construction.** Your application writes one small worker file that calls `createEngineWorkerHandler`, and one `new Worker(new URL(...))` call (usually in a small factory function) that your bundler can see and trace.

### Copy-pasteable example

```ts
// src/voxelspy-engine.worker.ts -- your own worker entry file
/// <reference lib="webworker" />
import { createEngineWorkerHandler } from "@voxelspy/react/worker";

self.addEventListener("message", createEngineWorkerHandler(self));
```

```ts
// src/voxelspy-engine.ts -- ordinary application code, not inside the worker
import type { EngineWorkerFactory } from "@voxelspy/react";

export const createVoxelspyWorker: EngineWorkerFactory = () =>
  new Worker(new URL("./voxelspy-engine.worker.ts", import.meta.url), {
    type: "module",
  });
```

```tsx
// src/InspectPanel.tsx
import { InspectionFindings, useModelInspection } from "@voxelspy/react";
import { createVoxelspyWorker } from "./voxelspy-engine";

export function InspectPanel({ model }: { model: NormalizedModel }) {
  const { status, run, cancel } = useModelInspection(createVoxelspyWorker);

  return (
    <div>
      <button onClick={() => run(model)} disabled={status.status === "running"}>
        Inspect
      </button>
      {status.status === "running" && <button onClick={cancel}>Cancel</button>}
      <InspectionFindings status={status} />
    </div>
  );
}
```

Each `run()` call spins up a fresh worker (via your `createWorker` factory), sends one request, and terminates the worker once that request settles -- there is no persistent worker session to manage. This mirrors `apps/web`'s own `inspect-worker-client.ts`: a single bounded engine call does not need a multi-request session, only `apps/web`'s two-model _comparison workflow_ (import both models, then analyze) did, because it chains several requests against already-imported geometry. If your application later needs that richer session shape (e.g. importing a model once and running several queries against it), build it the same way `apps/web/src/worker-client.ts` does, on top of the same `@voxelspy/react/worker` protocol handler -- `createEngineWorkerHandler`'s handler is stateless per message, so nothing here prevents reusing one worker for more than one request if you choose to.

## What the hooks accept

Both hooks operate on **already-normalized models** (`NormalizedModel` from `@voxelspy/contracts`), not raw files. Importing a file (STL, OBJ, ...) is `@voxelspy/importers`' job, entirely outside this package's scope -- get a `NormalizedModel` however your application already does (an importer worker, a saved session, a fixture), and pass it in.

- **`useModelInspection(createWorker)`** -- wraps `inspectModel`. `run(model, options?)` where `options.inspect` is `InspectOptions` (`@voxelspy/analysis`) and `options.transferModel` controls buffer ownership (see below).
- **`useModelComparison(createWorker)`** -- wraps `analyzeModelPair`. `run(analysisRequest, baseline, candidate, options?)` where `analysisRequest` is a full `AnalysisRequest` (`@voxelspy/contracts`) you construct yourself -- this hook does not default or infer the method, tolerance, or model bindings for you, matching this repository's "never silently reinterpret a caller's request" rule. `analysisRequest.baseline.modelId`/`candidate.modelId` must equal `baseline.id`/`candidate.id`, the same binding `analyzeModelPair` itself requires.

Both hooks return `{ status, run, cancel, reset }`. `cancel()` aborts an in-flight run; `run()` while already running aborts the previous call first (only the latest request can ever complete); `reset()` cancels and returns to `{ status: "idle" }`. Both hooks abort their in-flight run automatically on unmount.

## Status model

Exactly four top-level statuses, matching this package's actual lifecycle -- no fifth invented for cancellation, no boolean `ok` flattening the engine's own result:

```ts
type EngineStatus<TResult> =
  | { status: "idle" }
  | { status: "running" }
  | { status: "complete"; result: TResult }
  | { status: "failed"; reason: EngineFailureReason };

type EngineFailureReason =
  { kind: "cancelled" } | { kind: "error"; error: Error };
```

A cancelled run is reported as `"failed"` with `reason.kind === "cancelled"` rather than as its own top-level status, so code that only switches on `status` still gets a safe non-`"complete"` answer, while code that cares about the distinction can read `reason.kind`. `isCancelledStatus(status)` is a ready-made type guard for that check.

**`"complete"` always carries the engine's real result, completely unmodified.** For `useModelComparison`, this includes the case where `result.outcome.state === "indeterminate"` -- `analyzeModelPair` finished and returned a validated answer; that answer happening to be "no method could produce a conclusive result for this input" is a fact about the geometry, not about whether the asynchronous call succeeded. This hook's `status` describes only the call's own lifecycle. It is deliberately a different question from what `@voxelspy/analysis`'s result itself reports (semantics, uncertainty, warnings, indeterminate/complete) -- see that package's README, "How failure is reported", for the vocabulary this package never re-derives or duplicates.

## Model ownership: clone vs. transfer

`useModelInspection`/`useModelComparison`'s `run()` accepts `{ transferModel?: boolean }` (default `false`).

- **`false` (default): clone.** The model is posted to the worker without an explicit transfer list, so the browser's structured-clone algorithm copies its typed-array buffers. Your `NormalizedModel` instance stays fully valid and usable afterward -- e.g. also handed to a 3D viewer alongside the analysis call.
- **`true`: transfer.** Every geometry buffer in the model(s) is transferred (zero-copy) into the worker and **detached from the calling thread**. Only use this when you are certain nothing else on the main thread still needs that exact model instance -- a detached buffer throws if read afterward.

Cloning is the safe default. Transfer is available because `AGENTS.md` requires this repository's worker transport to support transferable buffers as a baseline, and because zero-copy matters for very large meshes -- but it is opt-in, not implicit, because this package's hooks accept a model you already own and may still need, unlike `apps/web`'s import workers, which transfer freshly read file bytes that are never needed again for that call.

Regardless of which mode is used, **no geometry buffer is ever kept in React state.** The model is handed to the worker inside `run()`'s own async call; only the plain, serializable result (`InspectionResult`/`AnalysisResult`) that comes back ever reaches a hook's `status`.

## Presentational components

`InspectionFindings` and `ComparisonFindings` render an `EngineStatus<InspectionResult>`/`EngineStatus<AnalysisResult>` directly -- the exact value a hook's `status` already is. They are unstyled (a handful of semantic class names for a consumer to hook a stylesheet onto, nothing else) and make three guarantees:

- **Never presents an approximate result as exact.** `ComparisonFindings` labels a `"complete"` outcome `"Exact"` only when `outcome.semantics === "exact-within-validated-preconditions"`; every other complete outcome is labelled `"Approximate"`, with the engine's own uncertainty description shown alongside it.
- **Never presents an indeterminate outcome as a pass.** `outcome.state === "indeterminate"` renders with `role="alert"`, a heading that says "Comparison indeterminate", and the engine's own `code`/`reasons` -- the same treatment a failure gets, because "no method could produce a validated answer" is exactly as actionable as one, not a quiet non-event.
- **No colour-only meaning.** Watertightness (`"Closed"`/`"Not closed"`/`"Indeterminate"`), severities (`"Error"`/`"Warning"`/`"Info"`), and semantics labels are always spelled out in text; any `className` on these elements is presentation only, never the only way the state is conveyed.

Both components render every status, not just `"complete"`: `"running"` uses a `role="status"`/`aria-live="polite"` region; `"failed"` uses `role="alert"`, with cancellation and genuine failure worded distinctly. Headings carry stable `id`s (`idPrefix` prop, default `"voxelspy-inspection"`/`"voxelspy-comparison"`) so more than one instance can appear on a page without colliding ids, and content sections use `aria-labelledby` to reference them.

Neither component has any interactive element today -- both are read-only report views. A consumer wrapping them in interactive controls (a "run again" button, a collapsible section) is responsible for that control's own accessibility.

## Accessibility: what is verified and what is not

**This repository has no DOM test environment.** `apps/web` deliberately splits its own testing this way: pure logic in Vitest, DOM interaction in Playwright. Adding `jsdom` or `@testing-library/*` to this package would be a new dependency, which this bead's constraints disallow.

So `test/accessibility.test.tsx` verifies accessibility **structurally**: it renders `InspectionFindings`/`ComparisonFindings` to a static HTML string with React's own `react-dom/server` (`renderToStaticMarkup`, available through the `react`/`react-dom` dev dependency already needed to build and test this package -- not a new dependency) and asserts on the emitted markup for every status this package's status model can produce: correct `role`s (`status`, `alert`), `aria-live`/`aria-labelledby` wiring, and that watertightness/severity/semantics are stated in visible text rather than only through a class name.

**What this proves:** the markup these components emit has the right structure for assistive technology to key off of.

**What this does NOT prove:** that a screen reader announces any of this correctly, that keyboard focus behaves as expected, that live-region timing works the way a real browser implements it, or anything about interaction. If you build interactive controls around these components, test that interaction in a real browser (e.g. with Playwright, the way `apps/web` already does for its own UI).

## Testing this package

- `test/status.test.ts` -- the status reducer, tested as a pure function with no rendering involved.
- `test/runner.test.ts` -- the async run/cancel/reset control flow (`createEngineRunner`), extracted out of the hooks specifically so it is testable without a renderer. Covers a completed run, a genuine failure, a cancellation, a newer `run()` superseding an in-flight one (and discarding the stale result even if it resolves later), and `reset()`.
- `test/worker-handler.test.ts` -- `createEngineWorkerHandler` directly: both request kinds, a thrown-error failure path, and an indeterminate `analyzeModelPair` outcome reported as `ok: true` (not a thrown error).
- `test/worker-client.test.ts` -- the main-thread request/response/cancellation/transfer-list plumbing, against an in-process fake worker wired to the real handler.
- `test/consumer.test.ts` -- imports only through this package's entry point (`@voxelspy/react`) and asserts the documented status shape for the three paths the acceptance criteria call out by name: cancellation, genuine failure, and an indeterminate engine outcome.
- `test/accessibility.test.tsx` -- see "Accessibility" above.
- `test/browser-safety.test.ts` -- scans built `dist/**/*.js` for any `node:`-scheme import, and confirms `dist/worker.js` has no reference to `"react"` (mirrors `packages/analysis/test/browser-safety.test.ts`).

`useModelInspection`/`useModelComparison` themselves are not rendered in any test, because they are documented as thin `useReducer`/`useRef` wrappers around `createEngineRunner` with no control-flow logic of their own -- see that module's doc comment. A consumer adding a DOM renderer to their own app is free to render them directly; this package does not need to duplicate that coverage without one.

## Compatibility

Not yet published (`0.1.0`, `private: true`). No compatibility guarantees beyond what `@voxelspy/analysis`/`@voxelspy/contracts` already document for the values this package passes through unmodified.
