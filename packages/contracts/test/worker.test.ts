import { describe, expect, it } from "vitest";
import { CANONICAL_FRAME, IDENTITY_MAT4 } from "../src/primitives.js";
import {
  WORKER_PROTOCOL_VERSION,
  getWorkerMessageTransferList,
  hasExactWorkerMessageTransferList,
  validateWorkerProtocolTrace,
  workerErrorMessageSchema,
  workerExecuteMessageSchema,
  workerResultMessageSchema,
  workerWireMessageSchema,
  type WorkerWireMessage,
} from "../src/worker.js";

const wire = { protocolVersion: WORKER_PROTOCOL_VERSION } as const;
const digest = { algorithm: "sha256" as const, value: "a".repeat(64) };

function ready() {
  return {
    ...wire,
    type: "ready" as const,
    transport: "array-buffer-transfer" as const,
    operations: ["import", "analysis"] as const,
    maxActiveOperations: 1 as const,
  };
}

function initialize(requestId = "init.1") {
  return { ...wire, type: "initialize" as const, requestId };
}

function initialized(requestId = "init.1") {
  return { ...wire, type: "initialized" as const, requestId };
}

function importRequest(bytes = new Uint8Array([1, 2, 3])) {
  return {
    contractVersion: 1 as const,
    targetModelId: "model.imported",
    format: "stl",
    sourceName: "part.stl",
    bytes,
    options: {
      declaredUnit: "millimetre" as const,
      declaredAxis: "right-handed-z-up" as const,
      limits: { inputBytes: 1_024, triangleCount: 100 },
    },
  };
}

function executeImport(requestId = "operation.import") {
  return {
    ...wire,
    type: "execute" as const,
    operation: "import" as const,
    requestId,
    request: importRequest(),
  };
}

function importFailure(requestId = "operation.import") {
  return {
    ...wire,
    type: "result" as const,
    operation: "import" as const,
    requestId,
    result: {
      contractVersion: 1 as const,
      ok: false as const,
      code: "unsupported-input" as const,
      message: "Input is not supported",
      warnings: [],
    },
  };
}

function normalizedModel() {
  return {
    contractVersion: 1 as const,
    id: "model.imported",
    frame: CANONICAL_FRAME,
    meshes: [
      {
        id: "mesh.body",
        geometry: {
          positions: new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
          indices: new Uint32Array([0, 1, 2]),
        },
      },
    ],
    placement: {
      kind: "flat" as const,
      instances: [
        {
          id: "instance.body",
          meshId: "mesh.body",
          meshToModel: IDENTITY_MAT4,
        },
      ],
    },
    warnings: [],
    provenance: {
      formatId: "stl",
      importerId: "stl.reference",
      importerVersion: "1.0.0",
      sourceName: "part.stl",
      sourceDigest: digest,
      detectedSourceUnit: "unknown" as const,
      detectedSourceAxis: "unknown" as const,
      sourceUnit: "millimetre" as const,
      sourceAxis: "right-handed-z-up" as const,
      sourceResolution: {
        unit: "declared" as const,
        axis: "declared" as const,
      },
      appliedSourceToModel: IDENTITY_MAT4,
      notes: [],
    },
  };
}

function importSuccess(requestId = "operation.import") {
  return {
    ...wire,
    type: "result" as const,
    operation: "import" as const,
    requestId,
    result: {
      contractVersion: 1 as const,
      ok: true as const,
      model: normalizedModel(),
    },
  };
}

function analysisRequest(requestId = "operation.analysis") {
  return {
    contractVersion: 1 as const,
    requestId,
    baseline: {
      modelId: "model.baseline",
      modelToComparison: IDENTITY_MAT4,
    },
    candidate: {
      modelId: "model.candidate",
      modelToComparison: IDENTITY_MAT4,
    },
    method: {
      id: "surface-distance",
      version: "1.0.0",
      parameters: {},
    },
    tolerance: { distanceMillimetres: 0.01 },
  };
}

function executeAnalysis(requestId = "operation.analysis") {
  return {
    ...wire,
    type: "execute" as const,
    operation: "analysis" as const,
    requestId,
    request: analysisRequest(requestId),
  };
}

function analysisResult(requestId = "operation.analysis") {
  const request = analysisRequest(requestId);
  return {
    ...wire,
    type: "result" as const,
    operation: "analysis" as const,
    requestId,
    result: {
      contractVersion: 1 as const,
      requestId,
      baseline: request.baseline,
      candidate: request.candidate,
      warnings: [],
      outcome: {
        state: "indeterminate" as const,
        code: "unsupported-domain",
        reasons: ["Method preconditions are not satisfied"],
        requestedMethod: request.method,
        requestedTolerance: request.tolerance,
        validation: [],
      },
    },
  };
}

function progress(
  completedWorkUnits: number,
  totalWorkUnits = 10,
  requestId = "operation.import",
) {
  return {
    ...wire,
    type: "progress" as const,
    operation: "import" as const,
    requestId,
    completedWorkUnits,
    totalWorkUnits,
  };
}

function initializedTrace() {
  return [ready(), initialize(), initialized()] as const;
}

describe("worker wire schemas", () => {
  it("accepts strict V1 import and analysis messages", () => {
    expect(workerWireMessageSchema.parse(ready())).toBeTruthy();
    expect(workerExecuteMessageSchema.parse(executeImport())).toBeTruthy();
    expect(workerExecuteMessageSchema.parse(executeAnalysis())).toBeTruthy();
    expect(workerResultMessageSchema.parse(analysisResult())).toBeTruthy();

    expect(() =>
      workerWireMessageSchema.parse({ ...ready(), protocolVersion: 2 }),
    ).toThrow();
    expect(() =>
      workerWireMessageSchema.parse({ ...ready(), sharedMemory: true }),
    ).toThrow();
    expect(() =>
      workerExecuteMessageSchema.parse({
        ...executeAnalysis(),
        requestId: "operation.other",
      }),
    ).toThrow();
    expect(() =>
      workerExecuteMessageSchema.parse({ ...executeImport(), extra: true }),
    ).toThrow();
    expect(() =>
      workerWireMessageSchema.parse({
        ...wire,
        type: "cancel-acknowledged",
        requestId: "same",
        targetRequestId: "same",
        outcome: "accepted",
      }),
    ).toThrow();
    expect(() =>
      workerWireMessageSchema.parse({
        ...wire,
        type: "cancelled",
        requestId: "same",
        cancellationRequestId: "same",
      }),
    ).toThrow();
  });

  it("keeps shared memory and partial views out of V1 payloads", () => {
    const storage = new ArrayBuffer(4);
    expect(() =>
      workerExecuteMessageSchema.parse({
        ...executeImport(),
        request: importRequest(new Uint8Array(storage, 1, 3)),
      }),
    ).toThrow();

    if (typeof SharedArrayBuffer !== "undefined") {
      expect(() =>
        workerExecuteMessageSchema.parse({
          ...executeImport(),
          request: importRequest(
            new Uint8Array(
              new SharedArrayBuffer(3),
            ) as unknown as Uint8Array<ArrayBuffer>,
          ),
        }),
      ).toThrow();
    }
  });

  it("accepts only bounded, stage-consistent sanitized errors", () => {
    expect(
      workerErrorMessageSchema.parse({
        ...wire,
        type: "error",
        requestId: "operation.import",
        error: {
          code: "import-failed",
          stage: "import",
          message: "Importer stopped safely",
          retryable: false,
        },
      }),
    ).toBeTruthy();
    expect(() =>
      workerErrorMessageSchema.parse({
        ...wire,
        type: "error",
        requestId: "operation.import",
        error: {
          code: "import-failed",
          stage: "analysis",
          message: "Wrong stage",
          retryable: false,
        },
      }),
    ).toThrow();
    expect(() =>
      workerErrorMessageSchema.parse({
        ...wire,
        type: "error",
        error: {
          code: "invalid-message",
          stage: "protocol",
          message: "Error\nstack detail",
          retryable: false,
        },
      }),
    ).toThrow();
    expect(() =>
      workerErrorMessageSchema.parse({
        ...wire,
        type: "error",
        error: {
          code: "invalid-message",
          stage: "protocol",
          message: "Invalid message",
          retryable: false,
          stack: "not allowed",
        },
      }),
    ).toThrow();
    for (const unsafe of [
      "left\u0085right",
      "left\u2028right",
      "left\u2029right",
      "left\u202eright",
      "left\u2066right",
    ]) {
      expect(() =>
        workerErrorMessageSchema.parse({
          ...wire,
          type: "error",
          error: {
            code: "invalid-message",
            stage: "protocol",
            message: unsafe,
            retryable: false,
          },
        }),
      ).toThrow();
    }
  });
});

describe("worker protocol trace validation", () => {
  it("accepts correlated import and analysis lifecycles", () => {
    const importTrace = validateWorkerProtocolTrace([
      ...initializedTrace(),
      executeImport(),
      progress(0),
      progress(5),
      progress(10),
      importFailure(),
      { ...wire, type: "dispose", requestId: "dispose.1" },
      { ...wire, type: "disposed", requestId: "dispose.1" },
    ]);
    expect(importTrace).toEqual({
      valid: true,
      phase: "disposed",
      seenRequestIds: ["init.1", "operation.import", "dispose.1"],
    });

    expect(
      validateWorkerProtocolTrace([
        ...initializedTrace(),
        executeAnalysis(),
        analysisResult(),
      ]),
    ).toMatchObject({ valid: true, phase: "idle" });
  });

  it("rejects concurrent work and lifetime request-ID reuse", () => {
    expect(
      validateWorkerProtocolTrace([
        ...initializedTrace(),
        executeImport(),
        executeAnalysis(),
      ]),
    ).toMatchObject({
      valid: false,
      index: 4,
      code: "invalid-transition",
    });
    expect(
      validateWorkerProtocolTrace([
        ...initializedTrace(),
        executeImport(),
        importFailure(),
        executeImport(),
      ]),
    ).toMatchObject({
      valid: false,
      index: 5,
      code: "request-id-reused",
    });
  });

  it("requires monotonic, stable, correlated progress", () => {
    expect(
      validateWorkerProtocolTrace([
        ...initializedTrace(),
        executeImport(),
        progress(5),
        progress(4),
      ]),
    ).toMatchObject({ valid: false, code: "progress-regressed" });
    expect(
      validateWorkerProtocolTrace([
        ...initializedTrace(),
        executeImport(),
        progress(5),
        progress(6, 11),
      ]),
    ).toMatchObject({ valid: false, code: "progress-regressed" });
    expect(
      validateWorkerProtocolTrace([
        ...initializedTrace(),
        executeImport(),
        progress(5, 10, "operation.other"),
      ]),
    ).toMatchObject({ valid: false, code: "correlation-failed" });
  });

  it("requires acknowledgement before a correlated cancelled terminal", () => {
    const cancel = {
      ...wire,
      type: "cancel" as const,
      requestId: "cancel.1",
      targetRequestId: "operation.import",
    };
    const acknowledged = {
      ...wire,
      type: "cancel-acknowledged" as const,
      requestId: "cancel.1",
      targetRequestId: "operation.import",
      outcome: "accepted" as const,
    };
    const cancelled = {
      ...wire,
      type: "cancelled" as const,
      requestId: "operation.import",
      cancellationRequestId: "cancel.1",
    };
    expect(
      validateWorkerProtocolTrace([
        ...initializedTrace(),
        executeImport(),
        cancel,
        progress(1),
        acknowledged,
        cancelled,
      ]),
    ).toMatchObject({ valid: true, phase: "idle" });
    expect(
      validateWorkerProtocolTrace([
        ...initializedTrace(),
        executeImport(),
        cancel,
        cancelled,
      ]),
    ).toMatchObject({ valid: false, code: "correlation-failed" });
  });

  it("resolves a pre-acknowledgement completion race explicitly", () => {
    const cancel = {
      ...wire,
      type: "cancel" as const,
      requestId: "cancel.race",
      targetRequestId: "operation.import",
    };
    const alreadyCompleted = {
      ...wire,
      type: "cancel-acknowledged" as const,
      requestId: "cancel.race",
      targetRequestId: "operation.import",
      outcome: "already-completed" as const,
    };
    expect(
      validateWorkerProtocolTrace([
        ...initializedTrace(),
        executeImport(),
        cancel,
        importFailure(),
        alreadyCompleted,
      ]),
    ).toMatchObject({ valid: true, phase: "idle" });
    expect(
      validateWorkerProtocolTrace([
        ...initializedTrace(),
        executeImport(),
        cancel,
        {
          ...wire,
          type: "error",
          requestId: "operation.import",
          error: {
            code: "import-failed",
            stage: "import",
            message: "Import stopped before cancellation was observed",
            retryable: false,
          },
        },
        alreadyCompleted,
      ]),
    ).toMatchObject({ valid: true, phase: "idle" });
    expect(
      validateWorkerProtocolTrace([
        ...initializedTrace(),
        executeImport(),
        cancel,
        importFailure(),
        {
          ...alreadyCompleted,
          outcome: "accepted",
        },
      ]),
    ).toMatchObject({ valid: false, code: "correlation-failed" });
  });

  it("correlates structured failures and permits fresh retry IDs", () => {
    expect(
      validateWorkerProtocolTrace([
        ready(),
        initialize("init.failed"),
        {
          ...wire,
          type: "error",
          requestId: "init.failed",
          error: {
            code: "initialization-failed",
            stage: "initialization",
            message: "Initialization could not complete",
            retryable: true,
          },
        },
        initialize("init.retry"),
        initialized("init.retry"),
      ]),
    ).toMatchObject({ valid: true, phase: "idle" });
  });

  it("returns to the exact recoverable phase after correlated failures", () => {
    const importError = {
      ...wire,
      type: "error" as const,
      requestId: "operation.import",
      error: {
        code: "import-failed" as const,
        stage: "import" as const,
        message: "Import could not complete",
        retryable: true,
      },
    };
    expect(
      validateWorkerProtocolTrace([
        ...initializedTrace(),
        executeImport(),
        importError,
      ]),
    ).toMatchObject({ valid: true, phase: "idle" });
    expect(
      validateWorkerProtocolTrace([
        ...initializedTrace(),
        executeAnalysis(),
        {
          ...wire,
          type: "error",
          requestId: "operation.analysis",
          error: {
            code: "analysis-failed",
            stage: "analysis",
            message: "Analysis could not complete",
            retryable: true,
          },
        },
      ]),
    ).toMatchObject({ valid: true, phase: "idle" });

    const firstCancel = {
      ...wire,
      type: "cancel" as const,
      requestId: "cancel.failed",
      targetRequestId: "operation.import",
    };
    const cancellationError = {
      ...wire,
      type: "error" as const,
      requestId: "cancel.failed",
      error: {
        code: "cancellation-failed" as const,
        stage: "cancellation" as const,
        message: "Cancellation was not accepted",
        retryable: true,
      },
    };
    const secondCancel = {
      ...wire,
      type: "cancel" as const,
      requestId: "cancel.retry",
      targetRequestId: "operation.import",
    };
    expect(
      validateWorkerProtocolTrace([
        ...initializedTrace(),
        executeImport(),
        firstCancel,
        cancellationError,
        secondCancel,
        {
          ...wire,
          type: "cancel-acknowledged",
          requestId: "cancel.retry",
          targetRequestId: "operation.import",
          outcome: "accepted",
        },
        {
          ...wire,
          type: "cancelled",
          requestId: "operation.import",
          cancellationRequestId: "cancel.retry",
        },
      ]),
    ).toMatchObject({ valid: true, phase: "idle" });
    expect(
      validateWorkerProtocolTrace([
        ...initializedTrace(),
        executeImport(),
        firstCancel,
        cancellationError,
        firstCancel,
      ]),
    ).toMatchObject({ valid: false, code: "request-id-reused" });

    const disposalError = (requestId: string) => ({
      ...wire,
      type: "error" as const,
      requestId,
      error: {
        code: "disposal-failed" as const,
        stage: "disposal" as const,
        message: "Disposal could not complete",
        retryable: true,
      },
    });
    expect(
      validateWorkerProtocolTrace([
        ready(),
        { ...wire, type: "dispose", requestId: "dispose.uninitialized" },
        disposalError("dispose.uninitialized"),
      ]),
    ).toMatchObject({ valid: true, phase: "awaiting-initialize" });
    expect(
      validateWorkerProtocolTrace([
        ...initializedTrace(),
        { ...wire, type: "dispose", requestId: "dispose.failed" },
        disposalError("dispose.failed"),
        { ...wire, type: "dispose", requestId: "dispose.retry" },
        { ...wire, type: "disposed", requestId: "dispose.retry" },
      ]),
    ).toMatchObject({ valid: true, phase: "disposed" });
    expect(
      validateWorkerProtocolTrace([
        ...initializedTrace(),
        { ...wire, type: "dispose", requestId: "dispose.failed" },
        disposalError("dispose.failed"),
        { ...wire, type: "dispose", requestId: "dispose.failed" },
      ]),
    ).toMatchObject({ valid: false, code: "request-id-reused" });
  });

  it("treats sanitized protocol errors as state-neutral in live ready phases", () => {
    const protocolError = {
      ...wire,
      type: "error" as const,
      error: {
        code: "invalid-message" as const,
        stage: "protocol" as const,
        message: "Malformed input was rejected",
        retryable: false,
      },
    };
    const cancel = {
      ...wire,
      type: "cancel" as const,
      requestId: "cancel.protocol",
      targetRequestId: "operation.import",
    };
    expect(
      validateWorkerProtocolTrace([
        ready(),
        protocolError,
        initialize(),
        protocolError,
        initialized(),
        protocolError,
        executeImport(),
        protocolError,
        cancel,
        protocolError,
        {
          ...wire,
          type: "cancel-acknowledged",
          requestId: "cancel.protocol",
          targetRequestId: "operation.import",
          outcome: "accepted",
        },
        protocolError,
        {
          ...wire,
          type: "cancelled",
          requestId: "operation.import",
          cancellationRequestId: "cancel.protocol",
        },
        { ...wire, type: "dispose", requestId: "dispose.protocol" },
        protocolError,
        { ...wire, type: "disposed", requestId: "dispose.protocol" },
      ]),
    ).toMatchObject({ valid: true, phase: "disposed" });
    expect(validateWorkerProtocolTrace([protocolError])).toMatchObject({
      valid: false,
      code: "invalid-transition",
    });
    expect(
      validateWorkerProtocolTrace([
        ready(),
        { ...wire, type: "dispose", requestId: "dispose.early" },
        { ...wire, type: "disposed", requestId: "dispose.early" },
        protocolError,
      ]),
    ).toMatchObject({ valid: false, code: "invalid-transition" });
  });
});

describe("worker transfer ownership", () => {
  it("returns exact input and successful import result transfer lists", () => {
    const execute = workerExecuteMessageSchema.parse(executeImport());
    if (execute.operation !== "import")
      throw new TypeError("Expected an import execution");
    const inputTransfers = getWorkerMessageTransferList(execute);
    expect(inputTransfers).toEqual([execute.request.bytes.buffer]);
    expect(hasExactWorkerMessageTransferList(execute, inputTransfers)).toBe(
      true,
    );
    expect(
      hasExactWorkerMessageTransferList(execute, [
        ...inputTransfers,
        new ArrayBuffer(1),
      ]),
    ).toBe(false);
    expect(
      hasExactWorkerMessageTransferList(execute, [
        inputTransfers[0]!,
        inputTransfers[0]!,
      ]),
    ).toBe(false);

    const result = workerResultMessageSchema.parse(importSuccess());
    const resultTransfers = getWorkerMessageTransferList(result);
    expect(resultTransfers).toHaveLength(2);
    expect(
      hasExactWorkerMessageTransferList(result, [...resultTransfers].reverse()),
    ).toBe(false);
    expect(
      getWorkerMessageTransferList(
        workerResultMessageSchema.parse(importFailure()),
      ),
    ).toEqual([]);
    expect(
      getWorkerMessageTransferList(
        workerResultMessageSchema.parse(analysisResult()),
      ),
    ).toEqual([]);

    const duplicated = importSuccess();
    duplicated.result.model.meshes.push({
      id: "mesh.duplicate",
      geometry: duplicated.result.model.meshes[0]!.geometry,
    });
    expect(() => workerResultMessageSchema.parse(duplicated)).toThrow();
  });

  it("makes transferable input detachment explicit", () => {
    const execute = workerExecuteMessageSchema.parse(executeImport());
    if (execute.operation !== "import")
      throw new TypeError("Expected an import execution");
    const transfers = getWorkerMessageTransferList(execute);
    const clone = (
      globalThis as unknown as {
        structuredClone: (
          value: WorkerWireMessage,
          options: { transfer: ArrayBuffer[] },
        ) => WorkerWireMessage;
      }
    ).structuredClone(execute, { transfer: transfers });
    expect(execute.request.bytes.byteLength).toBe(0);
    expect(clone.type).toBe("execute");
    if (clone.type !== "execute" || clone.operation !== "import")
      throw new TypeError("Expected an import execution clone");
    expect(Array.from(clone.request.bytes)).toEqual([1, 2, 3]);
  });
});
