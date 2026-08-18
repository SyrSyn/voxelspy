import {
  ANALYSIS_MEMORY_MAX_MIB,
  ANALYSIS_MEMORY_MIN_MIB,
  DEFAULT_ANALYSIS_MEMORY_MIB,
} from "./worker-client";

/**
 * Capability preflight: derives a conservative, explainable default for the
 * analysis RAM allowance from whatever device signals the browser happens to
 * expose, and separately estimates whether a chosen pair of files is likely
 * to exceed a given allowance.
 *
 * Every signal here is optional and imprecise by nature:
 *  - `navigator.deviceMemory` is Chromium-only, quantized, and capped at 8
 *    GiB regardless of actual installed memory.
 *  - `navigator.hardwareConcurrency` counts logical CPU cores, not available
 *    headroom (other tabs and processes compete for the same cores).
 *  - a coarse primary pointer is a heuristic for touch/mobile, not a
 *    reliable device class (a touch-enabled desktop reports coarse too).
 *
 * The policy below never *upgrades* the recommendation past the existing
 * conservative default on the strength of a missing reading -- an
 * unavailable reading always degrades toward today's default rather than
 * toward a larger allowance ("fail-safe"). Every reading that does move the
 * recommendation away from the default is accompanied by a plain-language
 * note explaining which reading drove it, meant to sit next to the RAM
 * control rather than only in a tooltip.
 *
 * `evaluateCapabilityPreflight` touches no browser API -- it is pure and
 * fully unit-testable with injected readings. `readEnvironmentReadings` is
 * the thin, DOM-touching adapter a client calls once to build those
 * readings; it degrades every signal to `undefined`/conservative when the
 * API it reads (or the DOM itself, e.g. during server-side prerendering) is
 * unavailable.
 */

/** Environment signals a capability preflight is built from. Every optional
 * field can legitimately be `undefined` -- either because the browser does
 * not implement the underlying API, or because a test wants to exercise
 * that "unknown" path directly without a DOM. */
export interface EnvironmentReadings {
  /** `navigator.deviceMemory` in GiB. Chromium-only; `undefined` elsewhere. */
  deviceMemoryGiB?: number | undefined;
  /** `navigator.hardwareConcurrency`, logical CPU cores. */
  hardwareConcurrency?: number | undefined;
  /** A coarse primary pointer (`matchMedia("(pointer: coarse)")`), used as a
   * touch/mobile signal. `undefined` when pointer-type detection itself is
   * unavailable (never assumed `false` in that case). */
  coarsePointer?: boolean | undefined;
  /** Whether the dedicated-worker constructor exists at all; local
   * comparison cannot run without it. */
  workersAvailable: boolean;
  /** Whether a WebGL context could be created; mirrors the workbench's own
   * render probe. */
  webglAvailable: boolean;
}

export interface CapabilityPreflight {
  /** Always one of the ANALYSIS_MEMORY_* step values, within
   * [ANALYSIS_MEMORY_MIN_MIB, ANALYSIS_MEMORY_MAX_MIB]. This is a starting
   * point for the RAM slider, never a hard cap -- callers must still allow
   * the full slider range and free user override. */
  recommendedAnalysisMemoryMiB: number;
  /** Plain-language reasons for `recommendedAnalysisMemoryMiB`, in the order
   * they were applied. Always has at least one entry. */
  memoryNotes: readonly string[];
  workersAvailable: boolean;
  webglAvailable: boolean;
  /** False when local comparison cannot run in this browser at all (no
   * Worker support). Independent of `recommendedAnalysisMemoryMiB`, which is
   * still computed even when this is false. */
  analysisSupported: boolean;
  /** Set only when `analysisSupported` is false: a user-facing explanation
   * suitable for display, not a raw error message. */
  blockingMessage?: string | undefined;
}

/** Mobile/touch devices never get a recommendation above this, regardless of
 * reported memory -- a phone that misreports (or does not report) memory
 * should not be steered toward a large allowance. */
const MOBILE_MEMORY_CAP_MIB = 256;
/** Devices reporting very few logical cores are capped the same way: a large
 * memory ceiling is not useful if there is little compute to spend it with,
 * and `analysisExecutionBudget` ties compute time to this same allowance. */
const LOW_CORE_MEMORY_CAP_MIB = 256;
const LOW_CORE_THRESHOLD = 2;
/** Corroborates the top memory band before recommending the maximum
 * allowance: `deviceMemory` alone caps out at 8 GiB for privacy reasons, so
 * cores are the only remaining signal that distinguishes a modest 8 GiB
 * laptop from a genuinely capable workstation. */
const HIGH_CORE_THRESHOLD = 8;

/**
 * `deviceMemory` (GiB) -> recommended allowance, ascending and inclusive of
 * `maxGiB`. The last band's allowance is also the fallback used when
 * `deviceMemory` is reported above every band (deviceMemory is capped at 8
 * by the browser today, so this is future-proofing rather than a reachable
 * case).
 */
const MEMORY_BANDS: readonly {
  readonly maxGiB: number;
  readonly mib: number;
}[] = [
  { maxGiB: 1, mib: ANALYSIS_MEMORY_MIN_MIB }, // 128
  { maxGiB: 2, mib: 256 },
  { maxGiB: 4, mib: 384 },
  { maxGiB: 8, mib: 640 },
];

function memoryBandRecommendation(deviceMemoryGiB: number): {
  mib: number;
  note: string;
} {
  const band = MEMORY_BANDS.find((entry) => deviceMemoryGiB <= entry.maxGiB);
  const mib = band?.mib ?? ANALYSIS_MEMORY_MAX_MIB;
  return {
    mib,
    note: `This device reports ${deviceMemoryGiB} GB of memory; the recommended allowance is ${mib} MiB.`,
  };
}

/**
 * Derives a recommended analysis RAM allowance and the reasoning behind it
 * from a set of (possibly incomplete) device readings. Pure and
 * DOM-free -- see the module doc comment for the fail-safe policy this
 * implements.
 */
export function evaluateCapabilityPreflight(
  readings: EnvironmentReadings,
): CapabilityPreflight {
  const memoryNotes: string[] = [];
  let recommendedAnalysisMemoryMiB: number = DEFAULT_ANALYSIS_MEMORY_MIB;

  if (readings.deviceMemoryGiB === undefined) {
    memoryNotes.push(
      `Device memory is not reported by this browser, so the recommended allowance stays at the conservative default of ${DEFAULT_ANALYSIS_MEMORY_MIB} MiB.`,
    );
  } else {
    const { mib, note } = memoryBandRecommendation(readings.deviceMemoryGiB);
    recommendedAnalysisMemoryMiB = mib;
    memoryNotes.push(note);
    const topBandMiB = MEMORY_BANDS[MEMORY_BANDS.length - 1]!.mib;
    if (
      mib === topBandMiB &&
      mib < ANALYSIS_MEMORY_MAX_MIB &&
      readings.hardwareConcurrency !== undefined &&
      readings.hardwareConcurrency >= HIGH_CORE_THRESHOLD
    ) {
      recommendedAnalysisMemoryMiB = ANALYSIS_MEMORY_MAX_MIB;
      memoryNotes.push(
        `This device also reports ${readings.hardwareConcurrency} CPU cores, so the recommended allowance is increased to ${ANALYSIS_MEMORY_MAX_MIB} MiB.`,
      );
    }
  }

  if (
    readings.hardwareConcurrency !== undefined &&
    readings.hardwareConcurrency <= LOW_CORE_THRESHOLD &&
    recommendedAnalysisMemoryMiB > LOW_CORE_MEMORY_CAP_MIB
  ) {
    recommendedAnalysisMemoryMiB = LOW_CORE_MEMORY_CAP_MIB;
    memoryNotes.push(
      `This device reports only ${readings.hardwareConcurrency} CPU core${
        readings.hardwareConcurrency === 1 ? "" : "s"
      }, so the recommended allowance is capped at ${LOW_CORE_MEMORY_CAP_MIB} MiB to avoid overloading limited compute.`,
    );
  }

  if (readings.coarsePointer === true) {
    if (recommendedAnalysisMemoryMiB > MOBILE_MEMORY_CAP_MIB) {
      recommendedAnalysisMemoryMiB = MOBILE_MEMORY_CAP_MIB;
      memoryNotes.push(
        `This device appears to be a touch/mobile device, so the recommended allowance is capped at ${MOBILE_MEMORY_CAP_MIB} MiB regardless of reported memory.`,
      );
    } else {
      memoryNotes.push("This device appears to be a touch/mobile device.");
    }
  }

  recommendedAnalysisMemoryMiB = Math.min(
    Math.max(recommendedAnalysisMemoryMiB, ANALYSIS_MEMORY_MIN_MIB),
    ANALYSIS_MEMORY_MAX_MIB,
  );

  const analysisSupported = readings.workersAvailable;
  return {
    recommendedAnalysisMemoryMiB,
    memoryNotes,
    workersAvailable: readings.workersAvailable,
    webglAvailable: readings.webglAvailable,
    analysisSupported,
    blockingMessage: analysisSupported
      ? undefined
      : "This browser does not support Web Workers, so local comparison cannot run here. Try a recent desktop or mobile browser.",
  };
}

/** Shared with `Workbench`'s per-viewport render probe, so there is one
 * definition of "can this browser create a WebGL context" for both the
 * pre-run advisory and the actual render-time fallback decision. */
export function probeWebGLAvailability(): boolean {
  if (typeof document === "undefined") return false;
  try {
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
    context?.getExtension("WEBGL_lose_context")?.loseContext();
    return context !== null;
  } catch {
    return false;
  }
}

/**
 * Reads live browser signals for `evaluateCapabilityPreflight`. Kept
 * separate so the policy itself stays unit-testable without a DOM. Safe to
 * call during server-side prerendering: every browser-only global it reads
 * (`navigator`, `window`, `document`, `Worker`) is guarded, and an
 * unavailable global degrades to the same "unknown" values a client-side
 * caller would see for an unsupported browser, not a thrown error.
 */
export function readEnvironmentReadings(): EnvironmentReadings {
  const nav = typeof navigator === "undefined" ? undefined : navigator;
  const deviceMemoryGiB = (nav as { deviceMemory?: number } | undefined)
    ?.deviceMemory;
  const hardwareConcurrency = nav?.hardwareConcurrency;
  const coarsePointer =
    typeof window === "undefined" || typeof window.matchMedia !== "function"
      ? undefined
      : window.matchMedia("(pointer: coarse)").matches;
  return {
    deviceMemoryGiB,
    hardwareConcurrency,
    coarsePointer,
    workersAvailable: typeof Worker !== "undefined",
    webglAvailable: probeWebGLAvailability(),
  };
}

/** Rough, order-of-magnitude multiplier from raw input-file bytes to the
 * in-memory working set `@voxelspy/analysis` builds from them (flattened
 * Float64Array positions, Uint32Array indices, spatial-index construction
 * buffers, and per-triangle deviation tracking). Grounded in the analysis
 * package's own accounting of ~24 bytes/vertex + ~300 bytes/triangle of
 * working memory against a typical binary-STL on-disk encoding of ~50
 * bytes/triangle (worst case ~3 unshared vertices/triangle) -- roughly 7.4x,
 * rounded up here for margin. OBJ and ASCII STL are usually less dense on
 * disk, so this intentionally over-estimates for those formats rather than
 * under-estimates for any of them. This is advisory only: it is not the
 * fail-closed check the analysis package itself performs before running. */
const ESTIMATED_WORKING_SET_BYTES_PER_INPUT_BYTE = 8;

export interface AnalysisFitEstimate {
  /** Rough estimated working-set memory, in MiB, for the given input size. */
  estimatedMiB: number;
  /** True when the estimate exceeds the chosen allowance. An estimate, not a
   * guarantee -- the analysis package's own resource budget check is what
   * actually fails closed at run time. */
  likelyExceedsAllowance: boolean;
}

/**
 * Rough pre-run estimate of whether a comparison is likely to exceed a
 * chosen analysis RAM allowance, from the combined size of the two input
 * files. Intentionally conservative (see
 * `ESTIMATED_WORKING_SET_BYTES_PER_INPUT_BYTE`) and explicitly not a
 * guarantee in either direction: a "fits" estimate can still fail the
 * analysis package's own resource-budget check for a denser mesh, and a
 * "likely exceeds" estimate can still succeed for a sparse one.
 */
export function estimateAnalysisFit(
  totalInputBytes: number,
  allowanceMiB: number,
): AnalysisFitEstimate {
  const estimatedMiB = Math.ceil(
    (totalInputBytes * ESTIMATED_WORKING_SET_BYTES_PER_INPUT_BYTE) /
      (1024 * 1024),
  );
  return { estimatedMiB, likelyExceedsAllowance: estimatedMiB > allowanceMiB };
}
