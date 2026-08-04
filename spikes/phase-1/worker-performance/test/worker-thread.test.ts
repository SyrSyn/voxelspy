import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it } from "vitest";
import {
  SPIKE_PROTOCOL_VERSION,
  type WorkerRequest,
  type WorkerResponse,
} from "../src/protocol.js";

const activeWorkers = new Set<Worker>();

afterEach(async () => {
  await Promise.all([...activeWorkers].map((worker) => worker.terminate()));
  activeWorkers.clear();
});

describe("real worker-thread transport", () => {
  it("detaches input ownership and returns output ownership", async () => {
    const worker = await initializedWorker();
    const values = new Float64Array([1, 2, 3, 4]);
    worker.postMessage(
      {
        type: "run",
        requestId: "transfer",
        values,
        chunkSize: 2,
        multiplier: 4,
      },
      [values.buffer],
    );
    expect(values.byteLength).toBe(0);

    const result = await nextMessage(
      worker,
      (message) => message.type === "result",
    );
    expect(result.type).toBe("result");
    if (result.type !== "result") throw new Error("Expected a result");
    expect(result.values.byteLength).toBe(32);
    expect(Array.from(result.values)).toEqual([4, 8, 12, 16]);
    expect(result.checksum).toBe(40);
  });

  it("delivers cancellation while processing is in progress", async () => {
    const worker = await initializedWorker();
    const values = new Float64Array(200_000).fill(1);
    worker.postMessage(
      {
        type: "run",
        requestId: "cancel",
        values,
        chunkSize: 1_000,
        multiplier: 2,
      },
      [values.buffer],
    );
    await nextMessage(worker, (message) => message.type === "progress");
    worker.postMessage({
      type: "cancel",
      targetRequestId: "cancel",
    } satisfies WorkerRequest);
    const cancelled = await nextMessage(
      worker,
      (message) => message.type === "cancelled",
    );
    expect(cancelled).toEqual({ type: "cancelled", requestId: "cancel" });
  });
});

async function initializedWorker(): Promise<Worker> {
  const worker = new Worker(new URL("../dist/node-worker.js", import.meta.url));
  activeWorkers.add(worker);
  await nextMessage(worker, (message) => message.type === "ready");
  worker.postMessage({
    type: "initialize",
    requestId: "init",
    protocolVersion: SPIKE_PROTOCOL_VERSION,
    geometry: { scratchBytes: 1024 },
  } satisfies WorkerRequest);
  await nextMessage(worker, (message) => message.type === "initialized");
  return worker;
}

function nextMessage(
  worker: Worker,
  predicate: (message: WorkerResponse) => boolean,
): Promise<WorkerResponse> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => finish(new Error("Timed out waiting for worker message")),
      5_000,
    );
    const onMessage = (message: WorkerResponse) => {
      if (predicate(message)) finish(undefined, message);
    };
    const onError = (error: Error) => finish(error);
    function finish(error?: Error, message?: WorkerResponse) {
      clearTimeout(timeout);
      worker.off("message", onMessage);
      worker.off("error", onError);
      if (error) reject(error);
      else if (message) resolve(message);
    }
    worker.on("message", onMessage);
    worker.on("error", onError);
  });
}
