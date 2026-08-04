# Reproducible evidence record

This file records what the checked-in harness proves and distinguishes it from follow-up work. Timing output belongs in a run log or review artifact, not in source control.

## Automated assertions

- Runtime tests cover registered initialization hooks, structured invalid-request errors, progress, cancellation at a host yield, result checksums, and transfer-list selection.
- A real Node ESM worker-thread test confirms that transferring input detaches the sender's typed array and returns a usable typed-array result.
- A real Node ESM worker-thread test sends cancellation after observed progress and receives `cancelled` instead of `result`.
- Capability tests cover a non-isolated browser fallback and an isolated browser shared-memory selection without claiming browser execution.
- The Vite production build consumes the package by its bare package name and includes both worker factories.
- The bounded server bundle imports the same package entry and executes capability detection without starting browser-only work.
- The benchmark validates a deterministic checksum for clone, transfer, and available shared-memory modes before reporting environment-scoped samples.

## Interpretation limits

- Node worker threads validate JavaScript event-loop, structured-clone, and transfer behavior but do not validate browser CSP, memory limits, or scheduling.
- A production Vite build proves resolution and bundling, not runtime behavior in a specific browser.
- Capability detection says whether shared memory may be used; it does not prove that shared memory improves a representative workload.
- The numeric transform is intentionally not representative of parsing, tessellation, distance, Boolean, or voxel work.
- There are no mobile, desktop-browser, peak-memory, long-task, crash-recovery, or hostile-input results in this evidence set.

## Browser follow-up template

Record each run separately:

```text
Browser and exact version:
Operating system and architecture:
Consumer build revision:
Response headers:
Module or inline path:
crossOriginIsolated value:
Input element count and bytes:
Chunk size:
Completion or cancellation result:
Input detached after transfer:
Peak memory observation and measurement method:
Console/network errors:
```
