import { IDENTITY_MAT4, requestIdSchema } from "@voxelspy/contracts";
import type { RequestId, WorkerOutboundMessage } from "@voxelspy/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CANCEL_GRACE_PERIOD_MS,
  ComparisonCancelledError,
  ComparisonProtocolError,
  INACTIVITY_TIMEOUT_MS,
  reimportSessionModels,
  runComparison,
  type ComparisonSource,
  type SessionImportSpec,
} from "./worker-client";

type Listener = (event: { data: unknown }) => void;

/**
 * A minimal stand-in for a DedicatedWorkerGlobalScope-backed `Worker`. It
 * records every posted message and every `terminate()` call so tests can
 * assert on client behavior without spinning up a real worker thread.
 */
class FakeWorker {
  static instances: FakeWorker[] = [];
  readonly posted: unknown[] = [];
  terminated = false;
  private readonly messageListeners: Listener[] = [];
  private readonly errorListeners: (() => void)[] = [];

  constructor(
    readonly url: URL,
    readonly options?: unknown,
  ) {
    FakeWorker.instances.push(this);
  }

  addEventListener(
    type: "message" | "error",
    listener: Listener | (() => void),
  ) {
    if (type === "message") this.messageListeners.push(listener as Listener);
    else this.errorListeners.push(listener as () => void);
  }

  removeEventListener(
    type: "message" | "error",
    listener: Listener | (() => void),
  ) {
    const list =
      type === "message" ? this.messageListeners : this.errorListeners;
    const index = list.indexOf(listener as never);
    if (index >= 0) list.splice(index, 1);
  }

  postMessage(data: unknown) {
    this.posted.push(data);
  }

  terminate() {
    this.terminated = true;
  }

  emit(data: WorkerOutboundMessage | Record<string, unknown>) {
    for (const listener of this.messageListeners) listener({ data });
  }

  emitTransportError() {
    for (const listener of this.errorListeners) listener();
  }
}

const readyMessage = {
  protocolVersion: 1,
  type: "ready",
  transport: "array-buffer-transfer",
  operations: ["import", "analysis"],
  maxActiveOperations: 1,
} as const;

/**
 * Flushes pending microtasks (Promise reactions), including any that were
 * scheduled via Node's File/Blob async I/O, without advancing fake timers by
 * more than an already-due 0ms.
 */
async function flushMicrotasks() {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
  await vi.advanceTimersByTimeAsync(0);
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

function lastPostedRequestId(worker: FakeWorker): RequestId {
  const last = worker.posted.at(-1) as { requestId: RequestId };
  return last.requestId;
}

const dummySource = (name: string): ComparisonSource => ({
  file: new File(["irrelevant"], name),
  unit: "millimetre",
  axis: "right-handed-z-up",
});

/**
 * Starts a run and immediately registers a no-op rejection handler so a
 * later, deliberately delayed `await expect(...).rejects...` assertion does
 * not race Node's unhandled-rejection detector. The returned promise is
 * unchanged and still safe to assert on.
 */
function start(...args: Parameters<typeof runComparison>) {
  const runPromise = runComparison(...args);
  runPromise.catch(() => {});
  return runPromise;
}

beforeEach(() => {
  FakeWorker.instances.length = 0;
  vi.stubGlobal("Worker", FakeWorker as unknown as typeof Worker);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("runComparison protocol-level failure handling", () => {
  it("resolves the wait instead of deadlocking when a protocol error carries no request ID", async () => {
    const runPromise = start(
      dummySource("baseline.stl"),
      dummySource("candidate.stl"),
      () => {},
    );
    const worker = FakeWorker.instances.at(-1)!;

    // Simulate a contracts-version skew: the worker rejects the wire message
    // outright, before any requestId exists to correlate against.
    worker.emit({
      protocolVersion: 1,
      type: "error",
      error: {
        code: "invalid-message",
        stage: "protocol",
        message: "Worker message did not satisfy protocol version 1.",
        retryable: false,
      },
    });

    await expect(runPromise).rejects.toBeInstanceOf(ComparisonProtocolError);
    await expect(runPromise).rejects.toMatchObject({
      message: "Worker message did not satisfy protocol version 1.",
      code: "invalid-message",
    });
  });

  it("fails the run and terminates the worker after 120s of total silence", async () => {
    const runPromise = start(
      dummySource("baseline.stl"),
      dummySource("candidate.stl"),
      () => {},
    );
    const worker = FakeWorker.instances.at(-1)!;
    const assertion = expect(runPromise).rejects.toBeInstanceOf(
      ComparisonProtocolError,
    );

    // No "ready", no "initialized" — nothing at all — arrives from the worker.
    await vi.advanceTimersByTimeAsync(INACTIVITY_TIMEOUT_MS);

    await assertion;
    await expect(runPromise).rejects.toMatchObject({
      code: "inactivity-timeout",
    });
    expect(worker.terminated).toBe(true);
  });

  it("resets the inactivity timer on any message, including progress, and does not fire early", async () => {
    const runPromise = start(
      dummySource("baseline.stl"),
      dummySource("candidate.stl"),
      () => {},
    );
    const worker = FakeWorker.instances.at(-1)!;
    worker.emit(readyMessage);
    await flushMicrotasks();
    const initializeId = lastPostedRequestId(worker);
    worker.emit({
      protocolVersion: 1,
      type: "initialized",
      requestId: initializeId,
    });
    await flushMicrotasks();

    // Keep sending progress just under the inactivity window; the run must
    // not fail while the worker is still visibly alive, and these
    // informational messages must not pile up waiting for a predicate that
    // never matches "progress".
    for (let i = 0; i < 3; i += 1) {
      await vi.advanceTimersByTimeAsync(INACTIVITY_TIMEOUT_MS - 1_000);
      worker.emit({
        protocolVersion: 1,
        type: "progress",
        operation: "import",
        requestId: lastPostedRequestId(worker),
        completedWorkUnits: 0,
        totalWorkUnits: 1,
      });
      await flushMicrotasks();
    }
    expect(worker.terminated).toBe(false);
  });
});

describe("runComparison cancellation", () => {
  it("rejects with ComparisonCancelledError and terminates the worker when aborted before any operation is active", async () => {
    const controller = new AbortController();
    const runPromise = start(
      dummySource("baseline.stl"),
      dummySource("candidate.stl"),
      () => {},
      undefined,
      controller.signal,
    );
    const worker = FakeWorker.instances.at(-1)!;
    worker.emit(readyMessage);
    await flushMicrotasks();

    // No active execute operation yet (still waiting on "initialized"), so
    // cancellation should not need to round-trip through the worker at all.
    controller.abort();
    await flushMicrotasks();

    await expect(runPromise).rejects.toBeInstanceOf(ComparisonCancelledError);
    expect(worker.terminated).toBe(true);
    expect(
      worker.posted.some(
        (message) => (message as { type: string }).type === "cancel",
      ),
    ).toBe(false);
  });

  it("posts a protocol cancel for the active operation, grants a grace period, then terminates and rejects", async () => {
    const controller = new AbortController();
    const runPromise = start(
      dummySource("baseline.stl"),
      dummySource("candidate.stl"),
      () => {},
      undefined,
      controller.signal,
    );
    const worker = FakeWorker.instances.at(-1)!;
    worker.emit(readyMessage);
    await flushMicrotasks();
    const initializeId = lastPostedRequestId(worker);
    worker.emit({
      protocolVersion: 1,
      type: "initialized",
      requestId: initializeId,
    });
    await flushMicrotasks();
    // The client is now importing the baseline model and has posted an
    // "execute" import message; that is the active operation to cancel.
    const importRequestId = lastPostedRequestId(worker);

    controller.abort();
    await flushMicrotasks();

    const cancelMessage = worker.posted.at(-1) as {
      type: string;
      targetRequestId: RequestId;
    };
    expect(cancelMessage.type).toBe("cancel");
    expect(cancelMessage.targetRequestId).toBe(importRequestId);
    // The worker has not been given up on yet; the grace period is still running.
    expect(worker.terminated).toBe(false);

    await vi.advanceTimersByTimeAsync(CANCEL_GRACE_PERIOD_MS);

    await expect(runPromise).rejects.toBeInstanceOf(ComparisonCancelledError);
    expect(worker.terminated).toBe(true);
  });

  it("ignores a signal that is already aborted before the run starts", async () => {
    const controller = new AbortController();
    controller.abort();
    const runPromise = start(
      dummySource("baseline.stl"),
      dummySource("candidate.stl"),
      () => {},
      undefined,
      controller.signal,
    );
    await expect(runPromise).rejects.toBeInstanceOf(ComparisonCancelledError);
    const worker = FakeWorker.instances.at(-1)!;
    expect(worker.terminated).toBe(true);
  });
});

describe("requestIdSchema sanity", () => {
  it("accepts the synthesized cancel request id shape used by the client", () => {
    expect(() =>
      requestIdSchema.parse("cancel.import.baseline.1"),
    ).not.toThrow();
  });
});

function minimalNormalizedModel(role: "baseline" | "candidate") {
  const id = `model.${role}`;
  return {
    contractVersion: 1,
    id,
    frame: { unit: "millimetre", coordinateSystem: "right-handed-z-up" },
    meshes: [
      {
        id: `mesh.${role}`,
        geometry: {
          positions: new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
          indices: new Uint32Array([0, 1, 2]),
        },
      },
    ],
    placement: {
      kind: "flat",
      instances: [
        {
          id: `instance.${role}`,
          meshId: `mesh.${role}`,
          meshToModel: IDENTITY_MAT4,
        },
      ],
    },
    warnings: [],
    provenance: {
      formatId: "stl",
      importerId: "test.reimport",
      importerVersion: "1.0.0",
      sourceName: `${role}.stl`,
      detectedSourceUnit: "unknown",
      detectedSourceAxis: "unknown",
      sourceUnit: "millimetre",
      sourceAxis: "right-handed-z-up",
      sourceResolution: { unit: "declared", axis: "declared" },
      appliedSourceToModel: IDENTITY_MAT4,
      notes: [],
    },
  };
}

function dummySessionSpec(role: "baseline" | "candidate"): SessionImportSpec {
  return {
    targetModelId: `model.${role}` as SessionImportSpec["targetModelId"],
    format: "stl",
    sourceName: `${role}.stl`,
    bytes: new TextEncoder().encode("irrelevant"),
    options: { declaredUnit: "millimetre", declaredAxis: "right-handed-z-up" },
  };
}

describe("reimportSessionModels", () => {
  it("re-runs only the two import operations, never analysis, and returns both models", async () => {
    const runPromise = reimportSessionModels(
      dummySessionSpec("baseline"),
      dummySessionSpec("candidate"),
      () => {},
    );
    const worker = FakeWorker.instances.at(-1)!;
    worker.emit(readyMessage);
    await flushMicrotasks();
    const initializeId = lastPostedRequestId(worker);
    worker.emit({
      protocolVersion: 1,
      type: "initialized",
      requestId: initializeId,
    });
    await flushMicrotasks();

    const baselineRequestId = lastPostedRequestId(worker);
    expect(baselineRequestId).toBe("import.baseline.1");
    worker.emit({
      protocolVersion: 1,
      type: "result",
      operation: "import",
      requestId: baselineRequestId,
      result: {
        contractVersion: 1,
        ok: true,
        model: minimalNormalizedModel("baseline"),
      },
    });
    await flushMicrotasks();

    const candidateRequestId = lastPostedRequestId(worker);
    expect(candidateRequestId).toBe("import.candidate.1");
    worker.emit({
      protocolVersion: 1,
      type: "result",
      operation: "import",
      requestId: candidateRequestId,
      result: {
        contractVersion: 1,
        ok: true,
        model: minimalNormalizedModel("candidate"),
      },
    });

    const result = await runPromise;
    expect(result.baseline.id).toBe("model.baseline");
    expect(result.candidate.id).toBe("model.candidate");
    expect(
      worker.posted.filter(
        (message) => (message as { type: string }).type === "execute",
      ),
    ).toHaveLength(2);
    expect(
      worker.posted.some(
        (message) =>
          (message as { operation?: string }).operation === "analysis",
      ),
    ).toBe(false);
  });

  it("rejects with ComparisonCancelledError and terminates the worker when aborted before any operation is active", async () => {
    const controller = new AbortController();
    const runPromise = reimportSessionModels(
      dummySessionSpec("baseline"),
      dummySessionSpec("candidate"),
      () => {},
      controller.signal,
    );
    runPromise.catch(() => {});
    const worker = FakeWorker.instances.at(-1)!;
    worker.emit(readyMessage);
    await flushMicrotasks();

    controller.abort();
    await flushMicrotasks();

    await expect(runPromise).rejects.toBeInstanceOf(ComparisonCancelledError);
    expect(worker.terminated).toBe(true);
  });
});
