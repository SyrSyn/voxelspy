import { describe, expect, it } from "vitest";
import { IDENTITY_MAT4, rigidTransformSchema } from "@voxelspy/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import {
  runEngineOperation,
  EngineCancelledError,
  EngineProtocolError,
  useModelAlignment,
  useModelClearance,
  useModelMeasurement,
  useModelPrintability,
  useModelSection,
  useModelSimplification,
  type EngineOperationInputs,
} from "../src/index.js";
import { createEngineWorkerHandler } from "../src/worker.js";
import { FakeEngineWorker } from "./fake-worker.js";
import { boxModel } from "./fixtures.js";
const identity = rigidTransformSchema.parse(IDENTITY_MAT4);
function inputs(): EngineOperationInputs {
  const model = boxModel("model");
  const second = boxModel("second");
  const translated = rigidTransformSchema.parse([
    1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 0, 0, 1,
  ]);
  return {
    clearance: {
      input: {
        first: { model, modelToComparison: identity },
        second: { model: second, modelToComparison: translated },
        desiredClearanceMillimetres: 1,
      },
    },
    measure: { model, query: { kind: "point-to-surface", point: [1, 1, 5] } },
    section: { model, plane: { point: [0, 0, 1], normal: [0, 0, 1] } },
    printability: {
      model,
      options: { buildVolume: { dimensionsMillimetres: [1, 1, 1] } },
    },
    simplify: {
      model,
      options: { target: { kind: "triangle-count", triangleCount: 10 } },
    },
    alignment: {
      input: {
        method: "correspondence-points",
        correspondences: [
          { moving: [0, 0, 0], fixed: [3, 4, 5] },
          { moving: [1, 0, 0], fixed: [4, 4, 5] },
          { moving: [0, 1, 0], fixed: [3, 5, 5] },
        ],
      },
    },
  };
}

describe("versioned engine operations", () => {
  it("dispatches all six operations through the actual handler with geometry oracles", async () => {
    const data = inputs();
    const factory = () =>
      new FakeEngineWorker({ cloneMessages: true }) as never;
    const clearance = await runEngineOperation(
      factory,
      "clearance",
      data.clearance,
    );
    expect(clearance.state).toBe("clear");
    if (clearance.state !== "indeterminate")
      expect(clearance.minimumDistanceMillimetres).toBe(3);
    expect(
      await runEngineOperation(factory, "measure", data.measure),
    ).toMatchObject({ kind: "point-to-surface", distanceMillimetres: 3 });
    const section = await runEngineOperation(factory, "section", data.section);
    expect(section.loops.loops[0]).toMatchObject({
      closed: true,
      perimeterMillimetres: 8,
      area: { absoluteSquareMillimetres: 4 },
    });
    const printability = await runEngineOperation(
      factory,
      "printability",
      data.printability,
    );
    expect(printability.buildVolume).toMatchObject({
      fitsInAnyOrientation: false,
    });
    expect(printability.disclaimer).toContain("not a printability verdict");
    const simplified = await runEngineOperation(
      factory,
      "simplify",
      data.simplify,
    );
    expect(simplified.simplified.triangleCount).toBeLessThan(12);
    expect(
      simplified.model.meshes[0]!.geometry.positions.byteLength,
    ).toBeGreaterThan(0);
    expect(simplified.certification.semantics).toBe(
      "approximate-sampled-bound",
    );
    const alignment = await runEngineOperation(
      factory,
      "alignment",
      data.alignment,
    );
    for (const [index, value] of [3, 4, 5].entries())
      expect(alignment.transform[index + 12]).toBeCloseTo(value, 12);
  });
  it("retains indeterminate clearance as a completed engine result", async () => {
    const input = inputs().clearance;
    const result = await runEngineOperation(
      () => new FakeEngineWorker() as never,
      "clearance",
      { ...input, options: { executionBudget: { maxMemoryBytes: 1 } } },
    );
    expect(result.state).toBe("indeterminate");
  });
  it("clones by default and actually detaches opted-in model buffers", async () => {
    const input = inputs().measure;
    const worker = new FakeEngineWorker({ cloneMessages: true });
    await runEngineOperation(() => worker as never, "measure", input);
    expect(worker.transfersPosted[0]).toEqual([]);
    expect(
      input.model.meshes[0]!.geometry.positions.byteLength,
    ).toBeGreaterThan(0);
    const transfer = new FakeEngineWorker({ cloneMessages: true });
    await runEngineOperation(() => transfer as never, "measure", input, {
      transferModel: true,
    });
    expect(input.model.meshes[0]!.geometry.positions.byteLength).toBe(0);
    expect(transfer.transfersPosted[0]).toHaveLength(2);
  });
  it("deduplicates shared clearance/ICP models and transfers simplified output", async () => {
    const input = inputs();
    const worker = new FakeEngineWorker({ cloneMessages: true });
    const shared = {
      ...input.clearance.input,
      second: input.clearance.input.first,
    };
    await runEngineOperation(
      () => worker as never,
      "clearance",
      { input: shared },
      { transferModel: true },
    );
    expect(worker.transfersPosted[0]).toHaveLength(2);
    const model = boxModel("icp");
    const icp = new FakeEngineWorker({ cloneMessages: true });
    await runEngineOperation(
      () => icp as never,
      "alignment",
      {
        input: {
          method: "iterative-closest-point",
          moving: model,
          fixed: { model, modelToComparison: identity },
        },
        options: { maxIterations: 1 },
      },
      { transferModel: true },
    );
    expect(icp.transfersPosted[0]).toHaveLength(2);
    const simplify = new FakeEngineWorker({ cloneMessages: true });
    await runEngineOperation(
      () => simplify as never,
      "simplify",
      inputs().simplify,
    );
    expect(simplify.responseTransfers[0]).toHaveLength(2);
    expect(simplify.responseTransfers[0]![0]!.byteLength).toBe(0);
  });
  it("cancels pending work, cleans listeners and recovers with a fresh call", async () => {
    const worker = new FakeEngineWorker({ delayMs: 20 });
    const controller = new AbortController();
    const result = runEngineOperation(
      () => worker as never,
      "section",
      inputs().section,
      { signal: controller.signal },
    );
    controller.abort();
    await expect(result).rejects.toBeInstanceOf(EngineCancelledError);
    expect(worker.terminated).toBe(true);
    expect(worker.listenerCount).toBe(0);
    expect(
      (
        await runEngineOperation(
          () => new FakeEngineWorker() as never,
          "section",
          inputs().section,
        )
      ).loops.loopCount,
    ).toBe(1);
  });
  it("reconstructs named resource failures without exposing arbitrary worker exceptions", async () => {
    await expect(
      runEngineOperation(() => new FakeEngineWorker() as never, "measure", {
        ...inputs().measure,
        options: { executionBudget: { maxMemoryBytes: 1 } },
      }),
    ).rejects.toMatchObject({ name: "MeasurementResourceLimitError" });
    let response: unknown;
    const handler = createEngineWorkerHandler({
      postMessage: (message) => {
        response = message;
      },
    });
    handler({
      data: {
        version: 2,
        kind: "measure",
        requestId: 1,
        input: inputs().measure,
      },
    } as never);
    expect(response).toMatchObject({
      version: 1,
      ok: false,
      errorName: "EngineError",
    });
    expect(JSON.stringify(response)).not.toContain("Unsupported protocol");
  });
  it.each([
    null,
    { version: 2, kind: "measure", requestId: 1, ok: true, result: {} },
    { version: 1, kind: "measure", requestId: 2, ok: true, result: {} },
    { version: 1, kind: "section", requestId: 1, ok: true, result: {} },
    { version: 1, kind: "measure", requestId: 1, ok: "yes" },
  ])(
    "rejects malformed/version-mismatched replies and cleans up: %j",
    async (message) => {
      const worker = new FakeEngineWorker({ delayMs: 20 });
      const result = runEngineOperation(
        () => worker as never,
        "measure",
        inputs().measure,
      );
      worker.simulateMessage(message);
      await expect(result).rejects.toBeInstanceOf(EngineProtocolError);
      expect(worker.terminated).toBe(true);
      expect(worker.listenerCount).toBe(0);
    },
  );
  it("handles an abort during worker construction before posting or transferring", async () => {
    const controller = new AbortController();
    const worker = new FakeEngineWorker({ cloneMessages: true });
    const input = inputs().measure;
    const result = runEngineOperation(
      () => {
        controller.abort();
        return worker as never;
      },
      "measure",
      input,
      { signal: controller.signal, transferModel: true },
    );
    await expect(result).rejects.toBeInstanceOf(EngineCancelledError);
    expect(worker.posted).toHaveLength(0);
    expect(worker.terminated).toBe(true);
    expect(
      input.model.meshes[0]!.geometry.positions.byteLength,
    ).toBeGreaterThan(0);
  });
  it("handles postMessage and worker-factory failures without leaking errors", async () => {
    const worker = new FakeEngineWorker();
    worker.postMessage = () => {
      throw new Error("sensitive internal text");
    };
    await expect(
      runEngineOperation(() => worker as never, "measure", inputs().measure),
    ).rejects.toMatchObject({
      name: "EngineProtocolError",
      message: "The analysis worker request could not be sent.",
    });
    expect(worker.listenerCount).toBe(0);
    expect(worker.terminated).toBe(true);
    await expect(
      runEngineOperation(
        () => {
          throw new Error("sensitive internal text");
        },
        "measure",
        inputs().measure,
      ),
    ).rejects.toMatchObject({
      name: "EngineProtocolError",
      message: "The analysis worker could not be created.",
    });
  });
  it("exports SSR-safe initial hooks without constructing workers or storing geometry", () => {
    let created = 0;
    const factory = () => {
      created++;
      return new FakeEngineWorker() as never;
    };
    function Consumer() {
      const hooks = [
        useModelClearance(factory),
        useModelMeasurement(factory),
        useModelSection(factory),
        useModelPrintability(factory),
        useModelAlignment(factory),
      ];
      const simplified = useModelSimplification(factory);
      expect(simplified.getSimplifiedModel()).toBeNull();
      for (const hook of [...hooks, simplified])
        expect(hook.status.status).toBe("idle");
      return createElement("span", null, "ready");
    }
    expect(renderToStaticMarkup(createElement(Consumer))).toBe(
      "<span>ready</span>",
    );
    expect(created).toBe(0);
  });
});
