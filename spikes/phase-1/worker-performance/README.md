# Worker and transport evidence spike

This directory is a disposable, self-contained investigation of worker packaging, control messages, buffer ownership, and runtime capability detection. It is evidence for later design work, not an accepted package, protocol, benchmark baseline, or application API.

The spike deliberately uses a small deterministic numeric transform in place of product geometry. It proves the transport and lifecycle behavior without selecting a geometry algorithm.

## Questions exercised

- Can the same worker runtime ship as a standard module worker and as source embedded in an npm package?
- Can initialization remain behind injectable hooks for a typed-array geometry provider and an optional CAD WebAssembly provider?
- Can the control path report progress and serializable errors, accept cancellation between bounded chunks, and dispose cleanly?
- Does the baseline transferable path make ownership changes observable and testable?
- Can shared memory stay an optional capability rather than a requirement?
- Can a Vite browser consumer and a bounded server bundle import the package shape?

## Reproduce

Run from this directory. `--ignore-workspace` keeps installation and its lockfile inside the spike.

```sh
pnpm install --ignore-workspace --frozen-lockfile
pnpm build
pnpm typecheck
pnpm lint
pnpm test
pnpm consumer:build
pnpm benchmark
pnpm check
```

Benchmark sizing is explicit and optional:

```sh
SPIKE_ELEMENTS=1000000 SPIKE_ITERATIONS=5 SPIKE_CHUNK_SIZE=16384 pnpm benchmark
```

The benchmark prints JSON to standard output. It identifies the runtime, version, platform, architecture, input size, iteration count, capabilities, and per-mode samples. Results are intentionally not committed because timings are environment-specific.

## Package paths

`createModuleWorker()` starts `dist/browser-worker.js` using `new Worker(url, { type: "module" })`. This keeps the worker as a separate package artifact and is the preferred path when a consumer and its content-security policy permit it.

`createInlineWorker()` starts a Blob URL containing a build-time bundle of that same browser entry. The package build embeds the source in `dist/index.js`; consumers do not need a worker-loader plug-in or a source-tree-relative worker URL. The Blob path trades a larger main package artifact and a more permissive `worker-src` policy for packaging independence.

The included Vite consumer imports the package by its bare package name and references both factories. Its production build proves static bundler compatibility. The included server consumer bundles the browser-capable package entry for Node, imports capability detection without creating a worker, and executes the resulting server bundle.

## Lifecycle and ownership findings

The experimental protocol has `initialize`, `run`, `cancel`, and `dispose` requests. Responses include `ready`, `initialized`, `progress`, `result`, `cancelled`, and structured `error` messages. The version marker only prevents accidental mixing inside this spike; it does not make the protocol stable.

Initialization invokes a required geometry hook and, when configured, an optional CAD hook. The demonstration CAD hook fetches and instantiates a WebAssembly module. It is deliberately generic: no engine selection, import object, persistence behavior, cache policy, or production error contract is implied.

The work loop yields after each bounded chunk. That yield is necessary: a cancel message cannot interrupt a long synchronous JavaScript call already occupying the worker event loop. Chunk size therefore affects cancellation latency, progress frequency, and overhead and needs workload-specific evidence before adoption.

For normal `ArrayBuffer` input, callers include the input buffer in the transfer list. The sender's typed array becomes detached immediately, making the ownership handoff explicit. Results use a new typed array whose buffer is transferred back. Callers that need to preserve their input must copy before dispatch; the worker should not create an implicit defensive copy.

`SharedArrayBuffer` is only selected when it exists and, in browsers, `crossOriginIsolated` is true. Otherwise the capability result selects transfer. This spike does not require shared memory and does not implement a shared-memory synchronization protocol. Node capability output is useful for harness operation but does not stand in for browser isolation behavior.

## Security and hosting constraints

Baseline module worker response headers:

```text
Content-Security-Policy: default-src 'self'; script-src 'self'; worker-src 'self'
```

The Blob worker additionally requires `blob:` in `worker-src` (and in legacy environments may fall back to `child-src`). The generated worker source does not use `eval` or `new Function`. A policy that intentionally disallows Blob workers should use the module-worker path.

The optional WebAssembly demonstration may require `wasm-unsafe-eval` in `script-src` depending on the browser and policy. Its URL must also be allowed by `connect-src`; a same-origin, immutable module is the simplest deployment shape. Cross-origin modules additionally need compatible CORS and resource policies.

Shared memory in a browser requires a cross-origin-isolated document. A typical starting point is:

```text
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Every embedded cross-origin resource then needs a compatible CORS or `Cross-Origin-Resource-Policy` response. `Cross-Origin-Embedder-Policy: credentialless` is an alternative with different credential behavior. These headers can affect integrations and window relationships; they are deployment decisions, not defaults established by this spike.

Worker inputs remain local in this harness. The optional CAD URL is the only demonstrated network operation, and it only runs when explicitly configured during initialization.

## Evidence matrix

| Runtime / consumer         | Module worker                         | Embedded Blob worker     | Transfer ownership               | Cancellation                     | Shared memory                  | Evidence status     |
| -------------------------- | ------------------------------------- | ------------------------ | -------------------------------- | -------------------------------- | ------------------------------ | ------------------- |
| Current Node worker thread | Equivalent ESM entry exercised        | Not applicable           | Executed test                    | Executed test                    | Capability/benchmark only      | Automated           |
| Vite production consumer   | Package URL built                     | Embedded source built    | Manual browser harness available | Manual browser harness available | Detection built                | Build evidence only |
| Bundled server consumer    | Import-safe; not started              | Import-safe; not started | Not applicable                   | Not applicable                   | Node detection executed        | Automated           |
| Chromium desktop           | To test                               | To test with CSP         | To test                          | To test                          | To test with isolation headers | No claim            |
| Firefox desktop            | To test                               | To test with CSP         | To test                          | To test                          | To test with isolation headers | No claim            |
| WebKit desktop             | To test                               | To test with CSP         | To test                          | To test                          | To test with isolation headers | No claim            |
| Mobile browsers            | To test on named devices and versions | To test                  | To test under memory pressure    | To test                          | To test                        | No claim            |

The Vite page can be served for a named browser run after `pnpm build`; that follow-up should record exact browser versions, headers, input sizes, memory observations, and whether both paths complete. This repository does not infer mobile behavior from desktop or Node results.

## Decisions intentionally left open

- accepted protocol fields, request identifier rules, version negotiation, and error taxonomy;
- geometry/CAD provider selection and how WASM assets are resolved, verified, cached, and initialized;
- queueing, concurrency, priorities, cancellation latency targets, and recovery after worker failure;
- buffer pool ownership, whether outputs may alias inputs, and memory ceilings per workload;
- whether shared memory's operational complexity produces enough benefit to support;
- package export names and whether an inline artifact should be shipped at all;
- browser support floor, SSR framework matrix, CSP defaults, and cross-origin-isolation deployment policy;
- representative fixtures, benchmark budgets, device tiers, and pass/fail thresholds.

## Dependency and license note

All dependencies are development-only and locked locally. esbuild creates the proof bundles; Vite creates the browser consumer; Vitest executes behavior; TypeScript checks contracts; ESLint and Prettier check source quality. Before any approach is promoted into production, dependency licenses and transitive packages must be reviewed in the repository's normal dependency process. The spike bundles only locally authored source and does not include model fixtures or third-party WebAssembly binaries.
