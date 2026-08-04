# Dependency and license evidence

This directory has no runtime dependency. Its three direct development dependencies are pinned by the lane-local lockfile.

| Package        | Version | Purpose                                | Registry license metadata |
| -------------- | ------: | -------------------------------------- | ------------------------- |
| TypeScript     |   6.0.3 | Static type checking                   | Apache-2.0                |
| `@types/node`  | 24.10.0 | Test and evidence script types         | MIT                       |
| Prettier       |   3.9.6 | Deterministic source formatting checks | MIT                       |
| `undici-types` |  7.16.0 | Transitive types used by `@types/node` | MIT                       |

The import probes otherwise use JavaScript typed arrays and platform `Blob`, `DecompressionStream`, and `TextDecoder` APIs. `DecompressionStream` does not expose a dependable output-memory limit, so raw-deflate input is rejected unless the caller explicitly opts into unbounded decompression. That opt-in is evidence for format decoding only and is unsuitable for hostile input. A production browser implementation needs a reviewed archive library with enforceable streaming limits.

## Candidate snapshot, not a selection

Registry metadata was queried while producing the spike to identify integration risks. These packages are not installed or approved by this evidence:

| Candidate        | Observed version | Registry license metadata | Relevant question                                                                                                        |
| ---------------- | ---------------: | ------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `occt-import-js` |           0.0.23 | LGPL-2.1                  | STEP fidelity, attribution/source obligations, WebAssembly size, cancellation, and assembly/unit behavior require review |
| `three`          |          0.185.1 | MIT                       | Loader subset, transform fidelity, worker use, and bundle cost require measurement                                       |
| `fflate`         |            0.8.3 | MIT                       | Expanded-size, entry-count, ratio, and cancellation limits require wrapping and tests                                    |
| `three-mesh-bvh` |           0.9.14 | MIT                       | Distance sampling accuracy and transferable acceleration structures require measurement                                  |
| `manifold-3d`    |            3.5.1 | Apache-2.0                | Accepted solid preconditions, conversion loss, WebAssembly cost, and Boolean failure semantics require tests             |

Versions and registry metadata are an evidence snapshot, not a recommendation. Before adoption, verify the package contents, complete dependency tree, bundled native or WebAssembly notices, current license texts, security posture, and browser/worker behavior.
