/// <reference lib="webworker" />

import { analyzeModelPair } from "@voxelspy/analysis";
import {
  WORKER_PROTOCOL_VERSION,
  getWorkerMessageTransferList,
  normalizedModelSchema,
  workerInboundMessageSchema,
  workerOutboundMessageSchema,
  type NormalizedModel,
  type RequestId,
  type WorkerOutboundMessage,
} from "@voxelspy/contracts";
import { importModel } from "@voxelspy/importers";

const scope = self as DedicatedWorkerGlobalScope;
const models = new Map<string, NormalizedModel>();
let initialized = false;
let disposed = false;
const completed = new Set<string>();

function send(message: WorkerOutboundMessage) {
  const value = workerOutboundMessageSchema.parse(message);
  scope.postMessage(value, getWorkerMessageTransferList(value));
}

send({
  protocolVersion: WORKER_PROTOCOL_VERSION,
  type: "ready",
  transport: "array-buffer-transfer",
  operations: ["import", "analysis"],
  maxActiveOperations: 1,
});

scope.addEventListener("message", (event: MessageEvent<unknown>) => {
  void handle(event.data);
});

async function handle(value: unknown) {
  const parsed = workerInboundMessageSchema.safeParse(value);
  if (!parsed.success) {
    send({
      protocolVersion: 1,
      type: "error",
      error: {
        code: "invalid-message",
        stage: "protocol",
        message: "Worker message did not satisfy protocol version 1.",
        retryable: false,
      },
    });
    return;
  }
  const message = parsed.data;
  if (message.type === "initialize") {
    if (disposed)
      return operationError(
        message.requestId,
        "initialization",
        "initialization-failed",
        "Disposed worker cannot be initialized.",
      );
    initialized = true;
    completed.add(message.requestId);
    send({
      protocolVersion: 1,
      type: "initialized",
      requestId: message.requestId,
    });
    return;
  }
  if (message.type === "dispose") {
    models.clear();
    initialized = false;
    disposed = true;
    completed.add(message.requestId);
    send({
      protocolVersion: 1,
      type: "disposed",
      requestId: message.requestId,
    });
    scope.close();
    return;
  }
  if (message.type === "cancel") {
    completed.add(message.requestId);
    send({
      protocolVersion: 1,
      type: "cancel-acknowledged",
      requestId: message.requestId,
      targetRequestId: message.targetRequestId,
      outcome: completed.has(message.targetRequestId)
        ? "already-completed"
        : "accepted",
    });
    return;
  }
  if (!initialized || disposed) {
    operationError(
      message.requestId,
      message.operation,
      "internal-failure",
      "Worker is not ready for execution.",
    );
    return;
  }
  send({
    protocolVersion: 1,
    type: "progress",
    operation: message.operation,
    requestId: message.requestId,
    completedWorkUnits: 0,
    totalWorkUnits: 1,
  });
  if (message.operation === "import") {
    try {
      const result = await importModel(message.request);
      if (result.ok)
        models.set(
          result.model.id,
          normalizedModelSchema.parse(structuredClone(result.model)),
        );
      completed.add(message.requestId);
      send({
        protocolVersion: 1,
        type: "progress",
        operation: "import",
        requestId: message.requestId,
        completedWorkUnits: 1,
        totalWorkUnits: 1,
      });
      send({
        protocolVersion: 1,
        type: "result",
        operation: "import",
        requestId: message.requestId,
        result,
      });
    } catch {
      operationError(
        message.requestId,
        "import",
        "import-failed",
        "Model import failed safely.",
      );
    }
    return;
  }
  const baseline = models.get(message.request.baseline.modelId);
  const candidate = models.get(message.request.candidate.modelId);
  if (!baseline || !candidate) {
    operationError(
      message.requestId,
      "analysis",
      "analysis-failed",
      "Imported model state is unavailable for analysis.",
    );
    return;
  }
  try {
    const result = analyzeModelPair({
      request: message.request,
      baseline,
      candidate,
    });
    completed.add(message.requestId);
    send({
      protocolVersion: 1,
      type: "progress",
      operation: "analysis",
      requestId: message.requestId,
      completedWorkUnits: 1,
      totalWorkUnits: 1,
    });
    send({
      protocolVersion: 1,
      type: "result",
      operation: "analysis",
      requestId: message.requestId,
      result,
    });
  } catch {
    operationError(
      message.requestId,
      "analysis",
      "analysis-failed",
      "Geometry analysis failed safely.",
    );
  }
}

function operationError(
  requestId: RequestId,
  stage: "initialization" | "import" | "analysis",
  code:
    | "initialization-failed"
    | "import-failed"
    | "analysis-failed"
    | "internal-failure",
  message: string,
) {
  completed.add(requestId);
  send({
    protocolVersion: 1,
    type: "error",
    requestId,
    error: { code, stage, message, retryable: false },
  });
}
