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
  type WorkerErrorCode,
  type WorkerErrorStage,
  type WorkerExecuteMessage,
  type WorkerOutboundMessage,
} from "@voxelspy/contracts";
import { importModel } from "@voxelspy/importers";

const scope = self as DedicatedWorkerGlobalScope;
const models = new Map<string, NormalizedModel>();
let initialized = false;
let disposed = false;
const completed = new Set<string>();
const seen = new Set<string>();
let active:
  | {
      requestId: RequestId;
      operation: "import" | "analysis";
      cancellationRequestId?: RequestId;
    }
  | undefined;

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
  handle(event.data);
});

function handle(value: unknown) {
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
  if (!claimRequestId(message.requestId)) return;
  if (message.type === "initialize") {
    if (disposed || initialized)
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
    if (active) {
      operationError(
        message.requestId,
        "disposal",
        "disposal-failed",
        "Active work must finish or be cancelled before disposal.",
      );
      return;
    }
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
    if (active?.requestId === message.targetRequestId) {
      if (active.cancellationRequestId) {
        operationError(
          message.requestId,
          "cancellation",
          "cancellation-failed",
          "Cancellation is already pending for this operation.",
        );
        return;
      }
      active.cancellationRequestId = message.requestId;
      completed.add(message.requestId);
      send({
        protocolVersion: 1,
        type: "cancel-acknowledged",
        requestId: message.requestId,
        targetRequestId: message.targetRequestId,
        outcome: "accepted",
      });
    } else if (completed.has(message.targetRequestId)) {
      completed.add(message.requestId);
      send({
        protocolVersion: 1,
        type: "cancel-acknowledged",
        requestId: message.requestId,
        targetRequestId: message.targetRequestId,
        outcome: "already-completed",
      });
    } else {
      operationError(
        message.requestId,
        "cancellation",
        "cancellation-failed",
        "Cancellation target is not active or completed.",
      );
    }
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
  if (active) {
    operationError(
      message.requestId,
      message.operation,
      "internal-failure",
      "Worker already has an active operation.",
    );
    return;
  }
  active = { requestId: message.requestId, operation: message.operation };
  send({
    protocolVersion: 1,
    type: "progress",
    operation: message.operation,
    requestId: message.requestId,
    completedWorkUnits: 0,
    totalWorkUnits: 1,
  });
  void execute(message);
}

async function execute(message: WorkerExecuteMessage) {
  // True mid-computation interruption of importModel/analyzeModelPair is not
  // possible: both are synchronous library calls once entered. This worker
  // is honest about that limit and only checks for a received cancellation
  // at stage boundaries (immediately before and after each such call); the
  // client covers the rest by terminating the worker outright on abort.
  if (message.operation === "import") {
    if (finishCancellation(message.requestId)) return;
    try {
      const result = await importModel(message.request);
      if (finishCancellation(message.requestId)) return;
      if (result.ok)
        models.set(
          result.model.id,
          normalizedModelSchema.parse(structuredClone(result.model)),
        );
      finishOperation(message.requestId);
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
      if (finishCancellation(message.requestId)) return;
      finishOperation(message.requestId);
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
    finishOperation(message.requestId);
    operationError(
      message.requestId,
      "analysis",
      "analysis-failed",
      "Imported model state is unavailable for analysis.",
    );
    return;
  }
  if (finishCancellation(message.requestId)) return;
  try {
    const result = analyzeModelPair({
      request: message.request,
      baseline,
      candidate,
    });
    if (finishCancellation(message.requestId)) return;
    finishOperation(message.requestId);
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
    if (finishCancellation(message.requestId)) return;
    finishOperation(message.requestId);
    operationError(
      message.requestId,
      "analysis",
      "analysis-failed",
      "Geometry analysis failed safely.",
    );
  }
}

function claimRequestId(requestId: RequestId): boolean {
  if (seen.has(requestId)) {
    send({
      protocolVersion: 1,
      type: "error",
      error: {
        code: "invalid-message",
        stage: "protocol",
        message: "Worker request identifiers must be unique.",
        retryable: false,
      },
    });
    return false;
  }
  seen.add(requestId);
  return true;
}

function finishOperation(requestId: RequestId) {
  if (active?.requestId === requestId) active = undefined;
  completed.add(requestId);
}

function finishCancellation(requestId: RequestId): boolean {
  if (active?.requestId !== requestId || !active.cancellationRequestId)
    return false;
  const cancellationRequestId = active.cancellationRequestId;
  finishOperation(requestId);
  send({
    protocolVersion: 1,
    type: "cancelled",
    requestId,
    cancellationRequestId,
  });
  return true;
}

function operationError(
  requestId: RequestId,
  stage: Exclude<WorkerErrorStage, "protocol">,
  code: Exclude<WorkerErrorCode, "invalid-message" | "unsupported-version">,
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
