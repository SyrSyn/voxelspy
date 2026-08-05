import { SURFACE_DISTANCE_METHOD, analyzeModelPair } from "@voxelspy/analysis";
import {
  IDENTITY_MAT4,
  analysisRequestSchema,
  importRequestSchema,
  modelIdSchema,
  requestIdSchema,
  type NormalizedModel,
} from "@voxelspy/contracts";
import { importModel } from "@voxelspy/importers";
import { describe, expect, it } from "vitest";
import { createBuiltInSamplePair } from "./sample-models";
import type { ComparisonSource } from "./worker-client";

async function importSample(
  role: "baseline" | "candidate",
  source: ComparisonSource,
): Promise<NormalizedModel> {
  const bytes = new Uint8Array(await source.file.arrayBuffer());
  const result = await importModel(
    importRequestSchema.parse({
      contractVersion: 1,
      targetModelId: modelIdSchema.parse(`model.${role}`),
      format: "stl",
      sourceName: source.file.name,
      bytes,
      options: {
        ...(source.frameSource === "expert"
          ? { userUnit: source.unit, userAxis: source.axis }
          : { declaredUnit: source.unit, declaredAxis: source.axis }),
        limits: { inputBytes: bytes.byteLength, triangleCount: 500 },
      },
    }),
  );
  if (!result.ok) throw new Error(result.message);
  return result.model;
}

describe("built-in sample model pair", () => {
  it("creates deterministic local sources with an analysis-ready frame", async () => {
    const first = createBuiltInSamplePair();
    const second = createBuiltInSamplePair();

    expect(first).toMatchObject({
      id: "mounting-bracket-reinforcement",
      title: "Mounting bracket reinforcement",
      change:
        "The candidate raises the mounting boss, enlarges one gusset, and adds a mirrored gusset.",
      baseline: {
        unit: "millimetre",
        axis: "right-handed-z-up",
      },
      candidate: {
        unit: "millimetre",
        axis: "right-handed-z-up",
      },
    });
    expect(first.baseline.file.name).toBe(
      "sample-mounting-bracket-baseline.stl",
    );
    expect(first.candidate.file.name).toBe(
      "sample-mounting-bracket-candidate.stl",
    );
    expect(first.baseline.file.lastModified).toBe(0);
    expect(first.candidate.file.lastModified).toBe(0);
    expect(await first.baseline.file.text()).toBe(
      await second.baseline.file.text(),
    );
    expect(await first.candidate.file.text()).toBe(
      await second.candidate.file.text(),
    );
    expect(await first.baseline.file.text()).not.toBe(
      await first.candidate.file.text(),
    );
  });

  it("imports through the production adapter and produces visible changes", async () => {
    const sample = createBuiltInSamplePair();
    const baseline = await importSample("baseline", sample.baseline);
    const candidate = await importSample("candidate", sample.candidate);
    const request = analysisRequestSchema.parse({
      contractVersion: 1,
      requestId: requestIdSchema.parse("analysis.sample"),
      baseline: { modelId: baseline.id, modelToComparison: IDENTITY_MAT4 },
      candidate: { modelId: candidate.id, modelToComparison: IDENTITY_MAT4 },
      method: SURFACE_DISTANCE_METHOD,
      tolerance: { distanceMillimetres: 0.1 },
      executionBudget: {
        maxWorkUnits: 2_000_000,
        maxMemoryBytes: 16 * 1024 * 1024,
      },
    });
    const analysis = analyzeModelPair({ request, baseline, candidate });

    expect(baseline.provenance.sourceName).toBe(
      "sample-mounting-bracket-baseline.stl",
    );
    expect(candidate.provenance.sourceName).toBe(
      "sample-mounting-bracket-candidate.stl",
    );
    const sharedBaseAndFlangeCoordinates = 24 * 9;
    expect(
      baseline.meshes[0]!.geometry.positions.slice(
        0,
        sharedBaseAndFlangeCoordinates,
      ),
    ).toEqual(
      candidate.meshes[0]!.geometry.positions.slice(
        0,
        sharedBaseAndFlangeCoordinates,
      ),
    );
    expect(candidate.meshes[0]!.geometry.indices.length).toBeGreaterThan(
      baseline.meshes[0]!.geometry.indices.length,
    );
    expect(analysis.outcome.state).toBe("complete");
    if (analysis.outcome.state !== "complete") return;
    expect(analysis.outcome.regions.length).toBeGreaterThan(1);
    expect(
      analysis.outcome.metrics.find(
        ({ id }) => id === "surface.maximum-distance",
      )?.value,
    ).toBeGreaterThan(2);
  });
});
