import { describe, expect, it } from "vitest";

import { EngineCancelledError, EngineProtocolError } from "../src/index.js";
import {
  runModelComparison,
  runModelInspection,
} from "../src/worker-client.js";
import { FakeEngineWorker } from "./fake-worker.js";
import { analysisRequestFor, boxModel } from "./fixtures.js";

/**
 * Internal plumbing tests for `worker-client.ts` -- the main-thread half of
 * the wire protocol `worker-handler.test.ts` covers from the other side.
 * Not part of this package's public surface (see `test/consumer.test.ts`
 * for tests that only import through `@voxelspy/react`'s entry point); this
 * file exists to pin the request/response/cancellation contract the public
 * hooks (`useModelInspection`/`useModelComparison`) build on.
 */
describe("runModelInspection", () => {
  it("resolves with the engine's InspectionResult on success", async () => {
    const worker = new FakeEngineWorker();
    const model = boxModel("m");
    const result = await runModelInspection(
      () => worker as never,
      model,
      undefined,
      {},
    );
    expect(result.watertightness).toEqual({ state: "closed" });
  });

  it("does not include a transfer list by default (clone semantics)", async () => {
    const worker = new FakeEngineWorker();
    await runModelInspection(
      () => worker as never,
      boxModel("m"),
      undefined,
      {},
    );
    expect(worker.transfersPosted[0]).toEqual([]);
  });

  it("includes every mesh geometry buffer in the transfer list when transferModel is true", async () => {
    const worker = new FakeEngineWorker();
    const model = boxModel("m");
    await runModelInspection(() => worker as never, model, undefined, {
      transferModel: true,
    });
    const transferred = worker.transfersPosted[0]!;
    expect(transferred).toContain(model.meshes[0]!.geometry.positions.buffer);
    expect(transferred).toContain(model.meshes[0]!.geometry.indices.buffer);
  });

  it("rejects with EngineCancelledError, and terminates the worker, when the signal fires before the worker responds", async () => {
    const worker = new FakeEngineWorker({ delayMs: 20 });
    const controller = new AbortController();
    const run = runModelInspection(
      () => worker as never,
      boxModel("m"),
      undefined,
      {
        signal: controller.signal,
      },
    );
    controller.abort();
    await expect(run).rejects.toBeInstanceOf(EngineCancelledError);
    expect(worker.terminated).toBe(true);
  });

  it("rejects immediately, without creating a worker, when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    let created = false;
    const run = runModelInspection(
      () => {
        created = true;
        return new FakeEngineWorker() as never;
      },
      boxModel("m"),
      undefined,
      { signal: controller.signal },
    );
    await expect(run).rejects.toBeInstanceOf(EngineCancelledError);
    expect(created).toBe(false);
  });

  it("throws a named Error reconstructed from an ok: false response", async () => {
    const worker = new FakeEngineWorker();
    const run = runModelInspection(
      () => worker as never,
      boxModel("m"),
      { maxTopologyExamples: -1 },
      {},
    );
    await expect(run).rejects.toThrow();
    try {
      await run;
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).name).toBe("RangeError");
    }
  });

  it("rejects with EngineProtocolError when the worker itself errors before responding", async () => {
    const worker = new FakeEngineWorker({ delayMs: 20 });
    const run = runModelInspection(
      () => worker as never,
      boxModel("m"),
      undefined,
      {},
    );
    worker.simulateError();
    await expect(run).rejects.toBeInstanceOf(EngineProtocolError);
  });
});

describe("runModelComparison", () => {
  it("resolves with the engine's AnalysisResult, including an indeterminate outcome, on success", async () => {
    const worker = new FakeEngineWorker();
    const baseline = boxModel("baseline");
    const candidate = boxModel("candidate");
    const result = await runModelComparison(
      () => worker as never,
      analysisRequestFor(baseline, candidate, "surface-distance", {
        executionBudget: { maxMemoryBytes: 1, maxWorkUnits: 1 },
      }),
      baseline,
      candidate,
      {},
    );
    expect(result.outcome.state).toBe("indeterminate");
  });

  it("deduplicates a buffer shared by baseline and candidate transfer lists", async () => {
    const worker = new FakeEngineWorker();
    const baseline = boxModel("baseline");
    const candidate = boxModel("candidate");
    await runModelComparison(
      () => worker as never,
      analysisRequestFor(baseline, candidate, "surface-distance"),
      baseline,
      candidate,
      { transferModel: true },
    );
    const transferred = worker.transfersPosted[0]!;
    expect(new Set(transferred).size).toBe(transferred.length);
  });
});
