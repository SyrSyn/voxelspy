import { describe, expect, it, vi } from "vitest";
import {
  SPIKE_PROTOCOL_VERSION,
  type WorkerResponse,
} from "../src/protocol.js";
import { createWorkerRuntime, type RuntimePort } from "../src/runtime.js";

function harness(overrides: Partial<RuntimePort> = {}) {
  const messages: WorkerResponse[] = [];
  const transfers: Transferable[][] = [];
  const port: RuntimePort = {
    post(message, transfer = []) {
      messages.push(message);
      transfers.push(transfer);
    },
    close: vi.fn(),
    yieldToHost: async () => {},
    ...overrides,
  };
  const hooks = {
    initializeGeometry: vi.fn(async () => ({ provider: "test-geometry" })),
    initializeCad: vi.fn(async () => ({ provider: "test-cad" })),
  };
  return {
    messages,
    transfers,
    port,
    hooks,
    runtime: createWorkerRuntime(port, hooks),
  };
}

describe("experimental worker runtime", () => {
  it("initializes registered geometry and optional CAD hooks", async () => {
    const { messages, hooks, runtime } = harness();
    await runtime.receive({
      type: "initialize",
      requestId: "init-1",
      protocolVersion: SPIKE_PROTOCOL_VERSION,
      geometry: { scratchBytes: 4096 },
      cad: { wasmUrl: "/optional.wasm", required: true },
    });

    expect(hooks.initializeGeometry).toHaveBeenCalledWith({
      scratchBytes: 4096,
    });
    expect(hooks.initializeCad).toHaveBeenCalledWith({
      wasmUrl: "/optional.wasm",
      required: true,
    });
    expect(messages.at(-1)).toMatchObject({
      type: "initialized",
      geometryProvider: "test-geometry",
      cadProvider: "test-cad",
    });
  });

  it("distinguishes optional initialization warnings from required failures", async () => {
    const optional = harness();
    optional.hooks.initializeCad.mockRejectedValueOnce(
      new Error("demonstration module unavailable"),
    );
    await optional.runtime.receive({
      type: "initialize",
      requestId: "optional-init",
      protocolVersion: SPIKE_PROTOCOL_VERSION,
      geometry: { scratchBytes: 0 },
      cad: { wasmUrl: "/optional.wasm", required: false },
    });
    expect(optional.messages.at(-1)).toEqual({
      type: "initialized",
      requestId: "optional-init",
      geometryProvider: "test-geometry",
      warnings: [
        "Optional CAD initialization failed: demonstration module unavailable",
      ],
    });

    const required = harness();
    required.hooks.initializeCad.mockRejectedValueOnce(
      new Error("required module unavailable"),
    );
    await required.runtime.receive({
      type: "initialize",
      requestId: "required-init",
      protocolVersion: SPIKE_PROTOCOL_VERSION,
      geometry: { scratchBytes: 0 },
      cad: { wasmUrl: "/required.wasm", required: true },
    });
    expect(required.messages.at(-1)).toEqual({
      type: "error",
      requestId: "required-init",
      code: "INITIALIZATION_FAILED",
      message: "required module unavailable",
    });
  });

  it("reports progress and marks the result buffer for transfer", async () => {
    const { messages, transfers, runtime } = harness();
    await initialize(runtime.receive);
    await runtime.receive({
      type: "run",
      requestId: "run-1",
      values: new Float64Array([1, 2, 3, 4]),
      chunkSize: 2,
      multiplier: 2,
    });
    await vi.waitFor(() =>
      expect(messages.some((message) => message.type === "result")).toBe(true),
    );

    const resultIndex = messages.findIndex(
      (message) => message.type === "result",
    );
    expect(
      messages.filter((message) => message.type === "progress"),
    ).toHaveLength(2);
    expect(messages[resultIndex]).toMatchObject({
      type: "result",
      checksum: 20,
    });
    const result = messages[resultIndex];
    expect(result?.type === "result" ? Array.from(result.values) : []).toEqual([
      2, 4, 6, 8,
    ]);
    expect(transfers[resultIndex]).toEqual([
      result?.type === "result" ? result.values.buffer : null,
    ]);
  });

  it("accepts cancellation while a chunked job yields", async () => {
    let releaseYield: (() => void) | undefined;
    const yielding = new Promise<void>((resolve) => {
      releaseYield = resolve;
    });
    const { messages, runtime } = harness({ yieldToHost: () => yielding });
    await initialize(runtime.receive);
    await runtime.receive({
      type: "run",
      requestId: "cancel-me",
      values: new Float64Array([1, 2, 3, 4]),
      chunkSize: 1,
      multiplier: 1,
    });
    await vi.waitFor(() =>
      expect(messages.some((message) => message.type === "progress")).toBe(
        true,
      ),
    );
    await runtime.receive({ type: "cancel", targetRequestId: "cancel-me" });
    releaseYield?.();
    await vi.waitFor(() =>
      expect(messages.some((message) => message.type === "cancelled")).toBe(
        true,
      ),
    );
    expect(messages.some((message) => message.type === "result")).toBe(false);
  });

  it("turns invalid input and work before initialization into serializable errors", async () => {
    const { messages, runtime } = harness();
    await runtime.receive({
      type: "run",
      requestId: "bad",
      values: [],
      chunkSize: 0,
    });
    await runtime.receive({
      type: "run",
      requestId: "early",
      values: new Float64Array([1]),
      chunkSize: 1,
      multiplier: 1,
    });
    expect(messages.slice(-2)).toEqual([
      {
        type: "error",
        code: "INVALID_REQUEST",
        message: "Invalid worker request",
      },
      {
        type: "error",
        requestId: "early",
        code: "NOT_INITIALIZED",
        message: "Initialize the worker before starting work",
      },
    ]);
  });

  it("closes on disposal and ignores subsequent work", async () => {
    const { messages, port, runtime } = harness();
    await runtime.receive({ type: "dispose" });
    await runtime.receive({ type: "initialize" });
    expect(port.close).toHaveBeenCalledOnce();
    expect(messages).toEqual([
      { type: "ready", protocolVersion: SPIKE_PROTOCOL_VERSION },
    ]);
  });
});

async function initialize(
  receive: (message: unknown) => Promise<void>,
): Promise<void> {
  await receive({
    type: "initialize",
    requestId: "init",
    protocolVersion: SPIKE_PROTOCOL_VERSION,
    geometry: { scratchBytes: 0 },
  });
}
