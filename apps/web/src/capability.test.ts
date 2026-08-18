import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ANALYSIS_MEMORY_MAX_MIB,
  ANALYSIS_MEMORY_MIN_MIB,
  ANALYSIS_MEMORY_STEP_MIB,
  DEFAULT_ANALYSIS_MEMORY_MIB,
} from "./worker-client";
import {
  estimateAnalysisFit,
  evaluateCapabilityPreflight,
  readEnvironmentReadings,
  type EnvironmentReadings,
} from "./capability";

const baseReadings: EnvironmentReadings = {
  deviceMemoryGiB: undefined,
  hardwareConcurrency: undefined,
  coarsePointer: undefined,
  workersAvailable: true,
  webglAvailable: true,
};

function isStepAligned(mib: number) {
  return (
    mib >= ANALYSIS_MEMORY_MIN_MIB &&
    mib <= ANALYSIS_MEMORY_MAX_MIB &&
    mib % ANALYSIS_MEMORY_STEP_MIB === 0
  );
}

describe("evaluateCapabilityPreflight: fail-safe defaults", () => {
  it("recommends today's default and explains why when every reading is unknown", () => {
    const result = evaluateCapabilityPreflight(baseReadings);
    expect(result.recommendedAnalysisMemoryMiB).toBe(
      DEFAULT_ANALYSIS_MEMORY_MIB,
    );
    expect(result.memoryNotes).toHaveLength(1);
    expect(result.memoryNotes[0]).toMatch(/not reported by this browser/u);
    expect(result.memoryNotes[0]).toMatch(
      new RegExp(String(DEFAULT_ANALYSIS_MEMORY_MIB)),
    );
  });

  it("never assumes capability from a missing coarse-pointer reading", () => {
    // High memory and cores, but pointer-type detection itself unavailable:
    // must not be silently treated as "not mobile" in a way that boosts the
    // recommendation beyond what the known readings alone justify, and must
    // not fabricate a mobile note either.
    const result = evaluateCapabilityPreflight({
      ...baseReadings,
      deviceMemoryGiB: 8,
      hardwareConcurrency: 16,
      coarsePointer: undefined,
    });
    expect(result.recommendedAnalysisMemoryMiB).toBe(ANALYSIS_MEMORY_MAX_MIB);
    expect(result.memoryNotes.some((note) => /mobile/u.test(note))).toBe(false);
  });
});

describe("evaluateCapabilityPreflight: memory bands", () => {
  it.each([
    [0.5, ANALYSIS_MEMORY_MIN_MIB],
    [1, ANALYSIS_MEMORY_MIN_MIB],
    [2, 256],
    [4, 384],
  ])("maps %s GB of memory to %s MiB on a desktop-like device", (giB, mib) => {
    const result = evaluateCapabilityPreflight({
      ...baseReadings,
      deviceMemoryGiB: giB,
      hardwareConcurrency: 4,
      coarsePointer: false,
    });
    expect(result.recommendedAnalysisMemoryMiB).toBe(mib);
    expect(result.memoryNotes[0]).toContain(`${giB} GB`);
    expect(result.memoryNotes[0]).toContain(`${mib} MiB`);
  });

  it("recommends 640 MiB for 8 GB of memory without core corroboration", () => {
    const result = evaluateCapabilityPreflight({
      ...baseReadings,
      deviceMemoryGiB: 8,
      hardwareConcurrency: undefined,
      coarsePointer: false,
    });
    expect(result.recommendedAnalysisMemoryMiB).toBe(640);
  });

  it("only reaches the 768 MiB ceiling when high memory is corroborated by high core count", () => {
    const lowCores = evaluateCapabilityPreflight({
      ...baseReadings,
      deviceMemoryGiB: 8,
      hardwareConcurrency: 4,
      coarsePointer: false,
    });
    expect(lowCores.recommendedAnalysisMemoryMiB).toBe(640);

    const highCores = evaluateCapabilityPreflight({
      ...baseReadings,
      deviceMemoryGiB: 8,
      hardwareConcurrency: 16,
      coarsePointer: false,
    });
    expect(highCores.recommendedAnalysisMemoryMiB).toBe(768);
    expect(
      highCores.memoryNotes.some((note) => /16 CPU cores/u.test(note)),
    ).toBe(true);
  });
});

describe("evaluateCapabilityPreflight: low-memory phone", () => {
  it("caps a touch device with modest memory at the mobile ceiling", () => {
    const result = evaluateCapabilityPreflight({
      ...baseReadings,
      deviceMemoryGiB: 2,
      hardwareConcurrency: 4,
      coarsePointer: true,
    });
    // The 2 GB band (256 MiB) already sits at the mobile cap, so no
    // reduction is needed, but the mobile signal is still surfaced.
    expect(result.recommendedAnalysisMemoryMiB).toBe(256);
    expect(
      result.memoryNotes.some((note) => /touch\/mobile device/u.test(note)),
    ).toBe(true);
  });

  it("overrides a high memory+core recommendation on a touch device", () => {
    const result = evaluateCapabilityPreflight({
      ...baseReadings,
      deviceMemoryGiB: 8,
      hardwareConcurrency: 16,
      coarsePointer: true,
    });
    expect(result.recommendedAnalysisMemoryMiB).toBe(256);
    expect(
      result.memoryNotes.some((note) => /capped at 256 MiB/u.test(note)),
    ).toBe(true);
  });
});

describe("evaluateCapabilityPreflight: low-core devices", () => {
  it("caps recommendation for a device with very few logical cores, independent of mobile status", () => {
    const result = evaluateCapabilityPreflight({
      ...baseReadings,
      deviceMemoryGiB: 8,
      hardwareConcurrency: 1,
      coarsePointer: false,
    });
    expect(result.recommendedAnalysisMemoryMiB).toBe(256);
    expect(
      result.memoryNotes.some((note) => /only 1 CPU core,/u.test(note)),
    ).toBe(true);
  });
});

describe("evaluateCapabilityPreflight: high-end desktop", () => {
  it("recommends the full 768 MiB ceiling for a capable, confirmed non-mobile workstation", () => {
    const result = evaluateCapabilityPreflight({
      deviceMemoryGiB: 8,
      hardwareConcurrency: 24,
      coarsePointer: false,
      workersAvailable: true,
      webglAvailable: true,
    });
    expect(result.recommendedAnalysisMemoryMiB).toBe(ANALYSIS_MEMORY_MAX_MIB);
    expect(result.analysisSupported).toBe(true);
    expect(result.blockingMessage).toBeUndefined();
  });
});

describe("evaluateCapabilityPreflight: missing worker support", () => {
  it("still computes a memory recommendation but reports the browser as unsupported with a clear message", () => {
    const result = evaluateCapabilityPreflight({
      ...baseReadings,
      deviceMemoryGiB: 4,
      hardwareConcurrency: 4,
      coarsePointer: false,
      workersAvailable: false,
    });
    expect(result.analysisSupported).toBe(false);
    expect(result.workersAvailable).toBe(false);
    expect(result.blockingMessage).toMatch(/does not support Web Workers/u);
    expect(result.recommendedAnalysisMemoryMiB).toBe(384);
  });
});

describe("evaluateCapabilityPreflight: webgl availability passthrough", () => {
  it("reports webglAvailable without affecting analysisSupported or the memory recommendation", () => {
    const result = evaluateCapabilityPreflight({
      ...baseReadings,
      webglAvailable: false,
    });
    expect(result.webglAvailable).toBe(false);
    expect(result.analysisSupported).toBe(true);
  });
});

describe("evaluateCapabilityPreflight: invariants", () => {
  it("always returns a value within the slider's bounds and step alignment", () => {
    const cases: EnvironmentReadings[] = [
      baseReadings,
      { ...baseReadings, deviceMemoryGiB: 0.25 },
      { ...baseReadings, deviceMemoryGiB: 16, hardwareConcurrency: 64 },
      {
        ...baseReadings,
        deviceMemoryGiB: 16,
        hardwareConcurrency: 64,
        coarsePointer: true,
      },
      { ...baseReadings, hardwareConcurrency: 1 },
      { ...baseReadings, workersAvailable: false, webglAvailable: false },
    ];
    for (const readings of cases) {
      const result = evaluateCapabilityPreflight(readings);
      expect(isStepAligned(result.recommendedAnalysisMemoryMiB)).toBe(true);
      expect(result.memoryNotes.length).toBeGreaterThan(0);
    }
  });
});

describe("estimateAnalysisFit", () => {
  it("does not flag a small combined input size against a generous allowance", () => {
    const result = estimateAnalysisFit(2 * 1024 * 1024, 768);
    expect(result.likelyExceedsAllowance).toBe(false);
    expect(result.estimatedMiB).toBeGreaterThan(0);
  });

  it("flags a large combined input size against a small allowance", () => {
    const result = estimateAnalysisFit(32 * 1024 * 1024, 128);
    expect(result.likelyExceedsAllowance).toBe(true);
    expect(result.estimatedMiB).toBeGreaterThan(128);
  });

  it("is a strict boundary: exactly matching the allowance does not count as exceeding it", () => {
    const allowanceMiB = 256;
    const totalInputBytes = (allowanceMiB * 1024 * 1024) / 8; // ESTIMATED_WORKING_SET_BYTES_PER_INPUT_BYTE
    const result = estimateAnalysisFit(totalInputBytes, allowanceMiB);
    expect(result.estimatedMiB).toBe(allowanceMiB);
    expect(result.likelyExceedsAllowance).toBe(false);
  });
});

describe("readEnvironmentReadings", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("degrades every signal to unknown/unsupported when the relevant globals are absent (e.g. server-side prerendering)", () => {
    vi.stubGlobal("navigator", undefined);
    vi.stubGlobal("window", undefined);
    vi.stubGlobal("document", undefined);
    vi.stubGlobal("Worker", undefined);

    const readings = readEnvironmentReadings();
    expect(readings).toEqual({
      deviceMemoryGiB: undefined,
      hardwareConcurrency: undefined,
      coarsePointer: undefined,
      workersAvailable: false,
      webglAvailable: false,
    });
  });

  it("reads deviceMemory, hardwareConcurrency, coarse-pointer, Worker, and WebGL availability when present", () => {
    vi.stubGlobal("navigator", { deviceMemory: 4, hardwareConcurrency: 8 });
    vi.stubGlobal("window", {
      matchMedia: (query: string) => ({
        matches: query === "(pointer: coarse)",
      }),
    });
    const context = { getExtension: () => ({ loseContext: () => {} }) };
    vi.stubGlobal("document", {
      createElement: () => ({ getContext: () => context }),
    });
    vi.stubGlobal("Worker", class {});

    const readings = readEnvironmentReadings();
    expect(readings).toEqual({
      deviceMemoryGiB: 4,
      hardwareConcurrency: 8,
      coarsePointer: true,
      workersAvailable: true,
      webglAvailable: true,
    });
  });

  it("reports webglAvailable as false when canvas context creation throws", () => {
    vi.stubGlobal("navigator", {});
    vi.stubGlobal("window", { matchMedia: () => ({ matches: false }) });
    vi.stubGlobal("document", {
      createElement: () => ({
        getContext: () => {
          throw new Error("no webgl in this sandbox");
        },
      }),
    });
    vi.stubGlobal("Worker", class {});

    expect(readEnvironmentReadings().webglAvailable).toBe(false);
  });
});
