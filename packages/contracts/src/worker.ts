import { z } from "zod";
import {
  analysisExchangeSchema,
  analysisRequestSchema,
  analysisResultSchema,
} from "./analysis.js";
import {
  importExchangeSchema,
  importRequestSchema,
  importResultSchema,
} from "./import.js";
import {
  isPortableJson,
  requestIdSchema,
  type RequestId,
} from "./primitives.js";

export const WORKER_PROTOCOL_VERSION = 1 as const;

const wireShape = { protocolVersion: z.literal(WORKER_PROTOCOL_VERSION) };
export const workerOperationSchema = z.enum(["import", "analysis"]);
const sanitizedErrorMessageSchema = z
  .string()
  .min(1)
  .max(1_000)
  .refine((value) => value.trim() === value, "Error messages must be trimmed")
  .refine(
    (value) =>
      isPortableJson(value) &&
      !/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028-\u202e\u2066-\u2069]/u.test(
        value,
      ),
    "Error messages must be portable single-line text",
  );

export const workerReadyMessageSchema = z.strictObject({
  ...wireShape,
  type: z.literal("ready"),
  transport: z.literal("array-buffer-transfer"),
  operations: z.tuple([z.literal("import"), z.literal("analysis")]),
  maxActiveOperations: z.literal(1),
});

export const workerInitializeMessageSchema = z.strictObject({
  ...wireShape,
  type: z.literal("initialize"),
  requestId: requestIdSchema,
});

export const workerInitializedMessageSchema = z.strictObject({
  ...wireShape,
  type: z.literal("initialized"),
  requestId: requestIdSchema,
});

export const workerExecuteImportMessageSchema = z.strictObject({
  ...wireShape,
  type: z.literal("execute"),
  operation: z.literal("import"),
  requestId: requestIdSchema,
  request: importRequestSchema,
});

export const workerExecuteAnalysisMessageSchema = z
  .strictObject({
    ...wireShape,
    type: z.literal("execute"),
    operation: z.literal("analysis"),
    requestId: requestIdSchema,
    request: analysisRequestSchema,
  })
  .refine((message) => message.requestId === message.request.requestId, {
    path: ["request", "requestId"],
    message: "Analysis request IDs must match the wire request ID",
  });

export const workerExecuteMessageSchema = z.discriminatedUnion("operation", [
  workerExecuteImportMessageSchema,
  workerExecuteAnalysisMessageSchema,
]);

export const workerProgressMessageSchema = z
  .strictObject({
    ...wireShape,
    type: z.literal("progress"),
    operation: workerOperationSchema,
    requestId: requestIdSchema,
    completedWorkUnits: z.number().int().safe().nonnegative(),
    totalWorkUnits: z.number().int().safe().positive(),
  })
  .refine((message) => message.completedWorkUnits <= message.totalWorkUnits, {
    path: ["completedWorkUnits"],
    message: "Completed work cannot exceed total work",
  });

export const workerImportResultMessageSchema = z.strictObject({
  ...wireShape,
  type: z.literal("result"),
  operation: z.literal("import"),
  requestId: requestIdSchema,
  result: importResultSchema,
});

export const workerAnalysisResultMessageSchema = z
  .strictObject({
    ...wireShape,
    type: z.literal("result"),
    operation: z.literal("analysis"),
    requestId: requestIdSchema,
    result: analysisResultSchema,
  })
  .refine((message) => message.requestId === message.result.requestId, {
    path: ["result", "requestId"],
    message: "Analysis result IDs must match the wire request ID",
  });

export const workerResultMessageSchema = z.discriminatedUnion("operation", [
  workerImportResultMessageSchema,
  workerAnalysisResultMessageSchema,
]);

export const workerCancelMessageSchema = z
  .strictObject({
    ...wireShape,
    type: z.literal("cancel"),
    requestId: requestIdSchema,
    targetRequestId: requestIdSchema,
  })
  .refine((message) => message.requestId !== message.targetRequestId, {
    path: ["requestId"],
    message: "Cancellation and operation request IDs must differ",
  });

export const workerCancelAcknowledgedMessageSchema = z
  .strictObject({
    ...wireShape,
    type: z.literal("cancel-acknowledged"),
    requestId: requestIdSchema,
    targetRequestId: requestIdSchema,
    outcome: z.enum(["accepted", "already-completed"]),
  })
  .refine((message) => message.requestId !== message.targetRequestId, {
    path: ["requestId"],
    message: "Cancellation and operation request IDs must differ",
  });

export const workerCancelledMessageSchema = z
  .strictObject({
    ...wireShape,
    type: z.literal("cancelled"),
    requestId: requestIdSchema,
    cancellationRequestId: requestIdSchema,
  })
  .refine((message) => message.requestId !== message.cancellationRequestId, {
    path: ["cancellationRequestId"],
    message: "Cancellation and operation request IDs must differ",
  });

export const workerDisposeMessageSchema = z.strictObject({
  ...wireShape,
  type: z.literal("dispose"),
  requestId: requestIdSchema,
});

export const workerDisposedMessageSchema = z.strictObject({
  ...wireShape,
  type: z.literal("disposed"),
  requestId: requestIdSchema,
});

export const workerErrorCodeSchema = z.enum([
  "invalid-message",
  "unsupported-version",
  "initialization-failed",
  "import-failed",
  "analysis-failed",
  "resource-limit",
  "cancellation-failed",
  "disposal-failed",
  "internal-failure",
]);

export const workerErrorStageSchema = z.enum([
  "protocol",
  "initialization",
  "import",
  "analysis",
  "cancellation",
  "disposal",
]);

export const workerErrorMessageSchema = z
  .strictObject({
    ...wireShape,
    type: z.literal("error"),
    requestId: requestIdSchema.optional(),
    error: z.strictObject({
      code: workerErrorCodeSchema,
      stage: workerErrorStageSchema,
      message: sanitizedErrorMessageSchema,
      retryable: z.boolean(),
    }),
  })
  .superRefine((message, context) => {
    const { code, stage } = message.error;
    const protocolCode =
      code === "invalid-message" || code === "unsupported-version";
    if (stage === "protocol") {
      if (!protocolCode || message.requestId !== undefined)
        context.addIssue({
          code: "custom",
          path: ["error"],
          message:
            "Protocol errors must use a protocol code and omit request IDs",
        });
      return;
    }
    if (protocolCode || message.requestId === undefined)
      context.addIssue({
        code: "custom",
        path: ["requestId"],
        message: "Non-protocol errors require a correlated request ID",
      });
    const stageCodes: Record<
      Exclude<typeof stage, "protocol">,
      readonly string[]
    > = {
      initialization: ["initialization-failed", "internal-failure"],
      import: ["import-failed", "resource-limit", "internal-failure"],
      analysis: ["analysis-failed", "resource-limit", "internal-failure"],
      cancellation: ["cancellation-failed", "internal-failure"],
      disposal: ["disposal-failed", "internal-failure"],
    };
    if (!stageCodes[stage].includes(code))
      context.addIssue({
        code: "custom",
        path: ["error", "code"],
        message: "Error code does not match its lifecycle stage",
      });
  });

export const workerInboundMessageSchema = z.union([
  workerInitializeMessageSchema,
  workerExecuteMessageSchema,
  workerCancelMessageSchema,
  workerDisposeMessageSchema,
]);

export const workerOutboundMessageSchema = z.union([
  workerReadyMessageSchema,
  workerInitializedMessageSchema,
  workerProgressMessageSchema,
  workerResultMessageSchema,
  workerCancelAcknowledgedMessageSchema,
  workerCancelledMessageSchema,
  workerDisposedMessageSchema,
  workerErrorMessageSchema,
]);

export const workerWireMessageSchema = z.union([
  workerInboundMessageSchema,
  workerOutboundMessageSchema,
]);

export type WorkerReadyMessage = z.infer<typeof workerReadyMessageSchema>;
export type WorkerOperation = z.infer<typeof workerOperationSchema>;
export type WorkerInitializeMessage = z.infer<
  typeof workerInitializeMessageSchema
>;
export type WorkerInitializedMessage = z.infer<
  typeof workerInitializedMessageSchema
>;
export type WorkerExecuteImportMessage = z.infer<
  typeof workerExecuteImportMessageSchema
>;
export type WorkerExecuteAnalysisMessage = z.infer<
  typeof workerExecuteAnalysisMessageSchema
>;
export type WorkerExecuteMessage = z.infer<typeof workerExecuteMessageSchema>;
export type WorkerProgressMessage = z.infer<typeof workerProgressMessageSchema>;
export type WorkerImportResultMessage = z.infer<
  typeof workerImportResultMessageSchema
>;
export type WorkerAnalysisResultMessage = z.infer<
  typeof workerAnalysisResultMessageSchema
>;
export type WorkerResultMessage = z.infer<typeof workerResultMessageSchema>;
export type WorkerCancelMessage = z.infer<typeof workerCancelMessageSchema>;
export type WorkerCancelAcknowledgedMessage = z.infer<
  typeof workerCancelAcknowledgedMessageSchema
>;
export type WorkerCancelledMessage = z.infer<
  typeof workerCancelledMessageSchema
>;
export type WorkerDisposeMessage = z.infer<typeof workerDisposeMessageSchema>;
export type WorkerDisposedMessage = z.infer<typeof workerDisposedMessageSchema>;
export type WorkerErrorMessage = z.infer<typeof workerErrorMessageSchema>;
export type WorkerErrorCode = z.infer<typeof workerErrorCodeSchema>;
export type WorkerErrorStage = z.infer<typeof workerErrorStageSchema>;
export type WorkerInboundMessage = z.infer<typeof workerInboundMessageSchema>;
export type WorkerOutboundMessage = z.infer<typeof workerOutboundMessageSchema>;
export type WorkerWireMessage = z.infer<typeof workerWireMessageSchema>;

/**
 * Returns the complete, deterministic transfer list for one validated V1
 * message. The caller relinquishes every listed buffer when posting it.
 */
export function getWorkerMessageTransferList(
  message: WorkerWireMessage,
): ArrayBuffer[] {
  const buffers: ArrayBuffer[] = [];
  if (message.type === "execute" && message.operation === "import") {
    buffers.push(ownedBuffer(message.request.bytes));
  } else if (
    message.type === "result" &&
    message.operation === "import" &&
    message.result.ok
  ) {
    for (const mesh of message.result.model.meshes) {
      buffers.push(ownedBuffer(mesh.geometry.positions));
      buffers.push(ownedBuffer(mesh.geometry.indices));
    }
  }
  if (new Set(buffers).size !== buffers.length)
    throw new TypeError("Wire payload buffers must have distinct ownership");
  return buffers;
}

/** Checks transfer-list identity, order, and cardinality without copying. */
export function hasExactWorkerMessageTransferList(
  message: WorkerWireMessage,
  transferList: readonly ArrayBuffer[],
): boolean {
  let expected: readonly ArrayBuffer[];
  try {
    expected = getWorkerMessageTransferList(message);
  } catch {
    return false;
  }
  return (
    expected.length === transferList.length &&
    new Set(transferList).size === transferList.length &&
    expected.every((buffer, index) => buffer === transferList[index])
  );
}

function ownedBuffer(
  view: Uint8Array | Float64Array | Uint32Array,
): ArrayBuffer {
  if (
    !(view.buffer instanceof ArrayBuffer) ||
    view.buffer.byteLength === 0 ||
    view.byteOffset !== 0 ||
    view.byteLength !== view.buffer.byteLength
  )
    throw new TypeError("Wire payload views must own complete ArrayBuffers");
  return view.buffer;
}

export type WorkerProtocolTracePhase =
  | "awaiting-ready"
  | "awaiting-initialize"
  | "initializing"
  | "idle"
  | "executing"
  | "cancelling"
  | "disposing"
  | "disposed";

export type WorkerProtocolTraceValidation =
  | {
      valid: true;
      phase: WorkerProtocolTracePhase;
      seenRequestIds: readonly RequestId[];
    }
  | {
      valid: false;
      index: number;
      code:
        | "invalid-message"
        | "invalid-transition"
        | "request-id-reused"
        | "correlation-failed"
        | "progress-regressed";
      message: string;
    };

interface ActiveOperation {
  readonly execute: WorkerExecuteMessage;
  lastCompleted?: number;
  total?: number;
  cancellationRequestId: RequestId | undefined;
  cancellationAcknowledged: boolean;
}

/**
 * Validates a complete ordered host/worker trace without I/O or retained state.
 * Request identifiers are unique for the whole trace, including completed work.
 */
export function validateWorkerProtocolTrace(
  values: readonly unknown[],
): WorkerProtocolTraceValidation {
  let phase: WorkerProtocolTracePhase = "awaiting-ready";
  const seen = new Set<string>();
  const orderedIds: RequestId[] = [];
  let initializationRequestId: RequestId | undefined;
  let active: ActiveOperation | undefined;
  let completedCancellation:
    { requestId: RequestId; targetRequestId: RequestId } | undefined;
  let disposeRequestId: RequestId | undefined;
  let disposeReturnPhase: "awaiting-initialize" | "idle" =
    "awaiting-initialize";

  const fail = (
    index: number,
    code: Exclude<WorkerProtocolTraceValidation, { valid: true }>["code"],
    message: string,
  ): WorkerProtocolTraceValidation => ({
    valid: false,
    index,
    code,
    message,
  });
  const remember = (
    requestId: RequestId,
    index: number,
  ): WorkerProtocolTraceValidation | undefined => {
    if (seen.has(requestId))
      return fail(
        index,
        "request-id-reused",
        "Request IDs must be unique for the worker lifetime",
      );
    seen.add(requestId);
    orderedIds.push(requestId);
    return undefined;
  };

  for (let index = 0; index < values.length; index += 1) {
    const parsed = workerWireMessageSchema.safeParse(values[index]);
    if (!parsed.success)
      return fail(
        index,
        "invalid-message",
        "Trace contains an invalid wire message",
      );
    const message = parsed.data;

    if (message.type === "ready") {
      if (phase !== "awaiting-ready")
        return fail(
          index,
          "invalid-transition",
          "Ready must be the first message",
        );
      phase = "awaiting-initialize";
      continue;
    }

    if (message.type === "initialize") {
      if (phase !== "awaiting-initialize")
        return fail(
          index,
          "invalid-transition",
          "Initialization is not allowed now",
        );
      const duplicate = remember(message.requestId, index);
      if (duplicate) return duplicate;
      initializationRequestId = message.requestId;
      phase = "initializing";
      continue;
    }

    if (message.type === "initialized") {
      if (
        phase !== "initializing" ||
        message.requestId !== initializationRequestId
      )
        return fail(
          index,
          "correlation-failed",
          "Initialization response is uncorrelated",
        );
      initializationRequestId = undefined;
      phase = "idle";
      continue;
    }

    if (message.type === "execute") {
      if (phase !== "idle")
        return fail(
          index,
          "invalid-transition",
          "Only one operation may be active",
        );
      const duplicate = remember(message.requestId, index);
      if (duplicate) return duplicate;
      active = {
        execute: message,
        cancellationRequestId: undefined,
        cancellationAcknowledged: false,
      };
      phase = "executing";
      continue;
    }

    if (message.type === "progress") {
      if (
        !active ||
        (phase !== "executing" && phase !== "cancelling") ||
        active.cancellationAcknowledged ||
        message.requestId !== active.execute.requestId ||
        message.operation !== active.execute.operation
      )
        return fail(
          index,
          "correlation-failed",
          "Progress is not correlated to active work",
        );
      if (active.total !== undefined && message.totalWorkUnits !== active.total)
        return fail(
          index,
          "progress-regressed",
          "Progress total cannot change",
        );
      if (
        active.lastCompleted !== undefined &&
        message.completedWorkUnits < active.lastCompleted
      )
        return fail(index, "progress-regressed", "Progress cannot decrease");
      active.total = message.totalWorkUnits;
      active.lastCompleted = message.completedWorkUnits;
      continue;
    }

    if (message.type === "result") {
      if (
        !active ||
        (phase !== "executing" &&
          !(phase === "cancelling" && !active.cancellationAcknowledged)) ||
        message.requestId !== active.execute.requestId ||
        message.operation !== active.execute.operation
      )
        return fail(
          index,
          "correlation-failed",
          "Result is not correlated to active work",
        );
      const correlated =
        active.execute.operation === "import" && message.operation === "import"
          ? importExchangeSchema.safeParse({
              request: active.execute.request,
              result: message.result,
            }).success
          : active.execute.operation === "analysis" &&
              message.operation === "analysis"
            ? analysisExchangeSchema.safeParse({
                request: active.execute.request,
                result: message.result,
              }).success
            : false;
      if (!correlated)
        return fail(
          index,
          "correlation-failed",
          "Result payload does not match its request",
        );
      if (phase === "cancelling" && active.cancellationRequestId) {
        completedCancellation = {
          requestId: active.cancellationRequestId,
          targetRequestId: active.execute.requestId,
        };
      } else {
        phase = "idle";
      }
      active = undefined;
      continue;
    }

    if (message.type === "cancel") {
      if (
        !active ||
        phase !== "executing" ||
        message.targetRequestId !== active.execute.requestId
      )
        return fail(
          index,
          "invalid-transition",
          "Cancellation requires matching active work",
        );
      const duplicate = remember(message.requestId, index);
      if (duplicate) return duplicate;
      active.cancellationRequestId = message.requestId;
      phase = "cancelling";
      continue;
    }

    if (message.type === "cancel-acknowledged") {
      if (completedCancellation) {
        if (
          message.requestId !== completedCancellation.requestId ||
          message.targetRequestId !== completedCancellation.targetRequestId ||
          message.outcome !== "already-completed"
        )
          return fail(
            index,
            "correlation-failed",
            "Completed cancellation acknowledgement is uncorrelated",
          );
        completedCancellation = undefined;
        phase = "idle";
        continue;
      }
      if (
        !active ||
        phase !== "cancelling" ||
        message.requestId !== active.cancellationRequestId ||
        message.targetRequestId !== active.execute.requestId ||
        message.outcome !== "accepted"
      )
        return fail(
          index,
          "correlation-failed",
          "Cancellation acknowledgement is uncorrelated",
        );
      active.cancellationAcknowledged = true;
      continue;
    }

    if (message.type === "cancelled") {
      if (
        !active ||
        phase !== "cancelling" ||
        !active.cancellationAcknowledged ||
        message.requestId !== active.execute.requestId ||
        message.cancellationRequestId !== active.cancellationRequestId
      )
        return fail(
          index,
          "correlation-failed",
          "Cancelled response is uncorrelated",
        );
      active = undefined;
      phase = "idle";
      continue;
    }

    if (message.type === "dispose") {
      if (phase !== "idle" && phase !== "awaiting-initialize")
        return fail(
          index,
          "invalid-transition",
          "Disposal requires an inactive worker",
        );
      const duplicate = remember(message.requestId, index);
      if (duplicate) return duplicate;
      disposeRequestId = message.requestId;
      disposeReturnPhase = phase;
      phase = "disposing";
      continue;
    }

    if (message.type === "disposed") {
      if (phase !== "disposing" || message.requestId !== disposeRequestId)
        return fail(
          index,
          "correlation-failed",
          "Disposal response is uncorrelated",
        );
      phase = "disposed";
      disposeRequestId = undefined;
      continue;
    }

    if (message.type === "error") {
      if (message.error.stage === "protocol") {
        if (phase === "awaiting-ready" || phase === "disposed")
          return fail(
            index,
            "invalid-transition",
            "Protocol errors require a live ready worker",
          );
        continue;
      }
      if (
        message.error.stage === "initialization" &&
        phase === "initializing" &&
        message.requestId === initializationRequestId
      ) {
        initializationRequestId = undefined;
        phase = "awaiting-initialize";
        continue;
      }
      if (
        (message.error.stage === "import" ||
          message.error.stage === "analysis") &&
        active &&
        (phase === "executing" ||
          (phase === "cancelling" && !active.cancellationAcknowledged)) &&
        message.error.stage === active.execute.operation &&
        message.requestId === active.execute.requestId
      ) {
        if (phase === "cancelling" && active.cancellationRequestId) {
          completedCancellation = {
            requestId: active.cancellationRequestId,
            targetRequestId: active.execute.requestId,
          };
        } else {
          phase = "idle";
        }
        active = undefined;
        continue;
      }
      if (
        message.error.stage === "cancellation" &&
        active &&
        phase === "cancelling" &&
        !active.cancellationAcknowledged &&
        message.requestId === active.cancellationRequestId
      ) {
        active.cancellationRequestId = undefined;
        phase = "executing";
        continue;
      }
      if (
        message.error.stage === "disposal" &&
        phase === "disposing" &&
        message.requestId === disposeRequestId
      ) {
        disposeRequestId = undefined;
        phase = disposeReturnPhase;
        continue;
      }
      return fail(
        index,
        "correlation-failed",
        "Structured error is uncorrelated",
      );
    }
  }

  return { valid: true, phase, seenRequestIds: orderedIds };
}
