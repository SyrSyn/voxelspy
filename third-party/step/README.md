# Replaceable STEP runtime

The optional STEP adapter uses occt-import-js **0.0.23** and OpenCascade
**7.6.1**. The main toolkit remains MIT; these separately replaceable runtime
assets are LGPL 2.1, with the OpenCascade exception supplied here. Read the
included license texts before redistributing or modifying the runtime.

The manifest pins the exact npm runtime bytes and both corresponding source
archives. The wrapper source archive contains its CMake configuration, build
scripts and Emscripten build workflow. Place the OCCT source tree at its `occt`
submodule path when rebuilding. The upstream workflow identifies Emscripten
3.1.69 and MinGW 7.1.0 build tools; consult its build flags and platform
requirements when reproducing or modifying the module. Preserve the published API and geometry
semantics when replacing the runtime. No application code is linked into the
WASM module; the adapter communicates through explicit serializable messages.

A web build copies the unmodified JS/WASM, licenses, notice and corresponding
source archives to `dist/step/`. On a cold cache, its explicit STEP asset
preparation downloads only the two public, commit-pinned source archives and
checks their SHA-256 digests. A warm cache builds offline. Original source
models and comparison data are never part of this operation. The source
archives remain available alongside the runtime; do not remove them from a
redistributed build. No runtime source download occurs while comparing models.

The STEP worker has a dedicated response CSP permitting only its same-origin
runtime and the dynamic function construction required by this Emscripten
build. The page policy retains its prohibition on dynamic evaluation. A host
must implement the documented worker-specific header replacement, or STEP fails
closed. Other importers do not depend on this exception.

OpenCascade tessellates rather than preserving exact CAD surfaces. Upstream
transfer/healing and omitted entities are not completely auditable through
this wrapper; importer warnings and tessellation parameters remain part of the
result. Runtime input/output ceilings and worker termination are safety
controls, not a proof of per-file memory consumption or CAD semantic fidelity.

Before kernel initialization, the browser verifies received WASM bytes against
the manifest SHA-256. STEP therefore requires Web Crypto in a secure context
(HTTPS or localhost). An unavailable hash API or mismatched asset produces an
actionable refusal; ordinary mesh importers remain usable. A modified runtime
must ship its matching manifest, provenance metadata and corresponding source.
