# Phase 1 evidence synthesis

Status: reviewed research evidence. This record selects inputs for contract design; it does not freeze a public API, promote spike code into production, or establish release support claims.

## Reproduce the reviewed lanes

Each lane has its own lockfile and stays outside the production workspace. Install and run it with workspace discovery disabled as documented in that lane.

```sh
pnpm --dir spikes/phase-1/geometry-formats check
pnpm --dir spikes/phase-1/worker-performance check
pnpm --dir spikes/phase-1/reports-sessions check
pnpm --dir spikes/phase-1/three-view-workbench check
pnpm --dir spikes/phase-1/three-view-workbench test:e2e
pnpm --dir spikes/phase-1/site-docs check
pnpm --dir spikes/phase-1/site-docs --ignore-workspace audit
pnpm --dir spikes/phase-1/site-docs test:browser
```

The lane READMEs document prerequisite installation, generated-artifact checks, optional benchmarks, and evidence-specific limits. Browser runs require the matching Playwright browser binary.

## Accepted inputs for contract design

### Geometry and import

- Normalized geometry needs explicit source and target units, source and target axes, the applied transform, typed positions and indices, warnings, and importer provenance.
- Import results may carry a serializable source-document or assembly description and tessellation provenance. Importer runtime objects do not cross the boundary.
- Unknown STL and OBJ units or axes remain explicit warnings. Resolution policy and user interaction are still unresolved. Coordinates are never silently relabelled, scaled, recentered, aligned, or repaired.
- Static glTF/GLB, 3MF Core mesh data, and tessellator output can enter the normalized shape only through validated adapters. The exercised adapters fail explicitly for covered animation, morph, skin references, external resources, sparse accessors, unsupported primitives, and hostile or unsupported archive cases. Deflated 3MF entries require an explicit unbounded opt-in; compressed glTF and full-format coverage are not proven.
- Native STEP parsing and tessellation remain unresolved. The evidence covers normalization of a tessellator's output, not a production CAD engine or exact B-rep behavior.

### Analysis semantics

- An analysis request selects a method through validated preconditions; no distance, occupancy, or solid operation is the universal comparison path.
- Results need method and parameter provenance plus explicit exact, approximate, or indeterminate semantics. The Phase 2 proposal must define the concrete representation.
- Surface sampling is approximate and tessellation-sensitive. Occupancy is approximate and resolution-sensitive. Solid results are exact only within a narrowly validated domain.
- Invalid, open, empty, non-finite, degenerate, over-budget, or unsupported geometry produces a validation failure or indeterminate result rather than a misleading numeric result.
- Product accuracy thresholds, production kernels, method-selection policy, and release-size budgets still require accepted fixtures and benchmarks.

### Worker transport

- Transferable `ArrayBuffer` ownership is the baseline transport. A sender that transfers a buffer must treat it as detached; preserving an input requires an explicit copy.
- Shared memory is an optional capability candidate and may be selected only when the runtime exposes it and a browser is cross-origin isolated. The spike did not prove a browser synchronization protocol or performance benefit.
- Work must be divided into bounded chunks so progress and cancellation can be observed between synchronous operations.
- The protocol needs explicit initialization, progress, cancellation, completion, structured-error, and disposal behavior, plus version and request identifiers.
- Module and embedded Blob worker paths build as packaging candidates with different content-security-policy requirements. Browser and CSP runtime behavior is not yet proven, and the accepted contract must not require the Blob path.
- Node worker-thread behavior and production bundling are useful evidence, not browser or mobile runtime claims. Browser CSP, failure recovery, memory limits, and device tiers remain release-gate work.
- The intended product contract targets browser dedicated workers; current runtime evidence comes from Node worker threads. No serverless worker or application server is required for local comparison.
- Total job and input size, scratch and WebAssembly memory, queueing, concurrency, cancellation latency, and recovery after worker failure remain unbounded or unproven. Chunking makes cancellation observable between operations but does not bound an entire job.

### Findings, reports, and portable sessions

- Findings, markups, measurements, saved views, report content, figure primitives, and portable-session manifests need explicit schema versions and bounded serializable values.
- Automatic findings identify detector version and parameters. Markups and measurements use validated references, and stored distance values agree with their endpoints.
- Exporters consume deterministic review data and figure primitives rather than re-running geometry implicitly.
- A self-contained session lists every payload with media type, byte count, and hash. Import validates the exact archive/manifest match and rejects unsupported versions instead of guessing.
- Archive validation needs limits for compressed size, entry count, per-entry and aggregate expanded size, and compression ratio, plus checks for unsafe paths, duplicate names, encryption, unsupported methods, inconsistent headers, and trailing data.
- The current evidence importer uses synchronous decompression and materializes all payloads. Its 32 MiB compressed/expanded limits, 32-entry limit, and 100:1 ratio are evidence defaults rather than product limits.
- The demonstrated session embeds the original source models. Exporting or sharing that archive is therefore an explicit model-data transfer; the product's inclusion policy remains unresolved.
- Current PDF and DOCX fidelity is evidence only. Accessibility, pagination, Unicode, font, office-suite, migration, streaming, signing, encryption, and multi-gigabyte behavior remain unproven and are not release claims.

### Three-view workbench

- The interaction model can keep old, new, and difference renderers synchronized through compact camera, selection, clipping, and framing values while geometry and material objects stay renderer-local.
- Renderer-observed browser evidence covers wheel zoom convergence and stabilization, framing reset, matching material clipping planes, and cross-view selection labels. It does not establish physical drag, pan, pinch, or device gesture quality.
- The difference view can remain visually primary while old and new context stays available at desktop, tablet, and mobile breakpoints. Compact findings must use native hidden/inert semantics when closed rather than visual clipping alone.
- Difference cues combine colour with solid/wireframe treatment and selection rings. The accepted design must preserve non-colour semantics and reduced-motion behavior.
- A failed initial WebGL capability check needs an accessible non-canvas fallback that leaves findings and controls usable. Runtime context-loss recovery, non-Chromium GPU behavior, and assistive-technology combinations still require broader evidence.
- Shared UI state must not contain geometry or renderer buffers. Concrete camera, scene, component, and styling shapes remain prototype details rather than accepted package contracts.

### Static application and documentation shell

- The Vite and React Router evidence emits seven canonical routes with local search and no application-server dependency. Raw HTTP and JavaScript-disabled checks confirm that trailing-slash deep links return their matching prerendered HTML; hydrated loads produce no hydration errors.
- Theme selection needs a pre-render guard for system, light, and dark modes. Branded primitives need text alternatives and must not rely on colour alone.
- Local file selection and search must remain local operations. No telemetry, remote font, remote asset, hosted identity, model upload, or model/session persistence dependency is accepted. Theme preference may remain local browser state.
- The documentation content source should remain serializable and replaceable. The prototype does not make its route or component structure a public package contract.
- Unknown client-side routes have an in-app not-found view, but the static build does not yet emit a host-level `404.html`. Redirect and error-route behavior remains a deployment gate.
- Hosting headers, caching, redirects, analytics, preview deployments, and domain configuration remain deployment decisions. No hosting provider runtime is part of the application contract.

## Rejected shortcuts

- Accepting a prototype TypeScript shape because it passed one fixture.
- Treating source coordinates as millimetres or Z-up without evidence.
- Calling sampled distance, voxel estimates, or unsupported solids exact.
- Falling through to a different analysis method after a precondition failure.
- Requiring shared memory, cross-origin isolation, Blob workers, or a server runtime for the baseline workflow.
- Inflating an archive before validating its central-directory metadata and resource budgets.
- Silently opening an unknown session schema version.
- Coupling core data to React, DOM `File`, browser globals, hosting, persistence, or importer engine objects.
- Claiming cross-browser, mobile, report-reader, or large-model readiness from local automated evidence.

## Phase 2 contract modules

The evidence supports proposals for these independently reviewable modules:

1. normalized geometry, coordinate frames, validation, warnings, source metadata, and tessellation provenance;
2. analysis requests/results, tolerances, method provenance, uncertainty, and result semantics;
3. findings, markups, measurements, saved views, reports, figure primitives, and portable-session manifests;
4. worker messages, request lifecycle, cancellation, progress, errors, capability selection, and buffer ownership;
5. importer registry metadata, fixture manifests, benchmark observations, and release-gate results.

All accepted contracts must serialize predictably, validate hostile inputs, run in browser and Node consumers, and keep the core layer free of React and DOM dependencies. Cross-module identifiers, coordinate-frame semantics, compatibility policy, and resource-budget ownership require coordinated review before implementation lanes depend on them.

## Evidence still required before release claims

- Named desktop browsers and representative mobile devices, with versions and observable memory/cancellation results.
- A production STEP adapter with license, assembly, unit, tessellation, cancellation, size, and failure evidence.
- Accuracy fixtures and thresholds for every supported analysis method and model-size tier.
- Rendered PDF/DOCX compatibility and accessibility checks in representative readers.
- Streaming or origin-private storage behavior for sessions that exceed safe in-memory limits.
- Full keyboard, screen-reader, touch, contrast, reduced-motion, context-loss, and responsive workbench verification.
- A network audit showing that normal model comparison does not upload model data.
- Static-host deep links, error routes, response headers, caching, and preview behavior on the eventual deployment target.
