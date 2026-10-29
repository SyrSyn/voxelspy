import {
  assessPrintability,
  checkClearance,
  estimateAlignment,
  measureOnModel,
  sectionModel,
  simplifyModel,
} from "@voxelspy/analysis";
import type { EngineWorkerScope } from "./protocol.js";
import { collectModelBuffers } from "./protocol.js";
import type {
  OperationWorkerRequest,
  OperationWorkerResponse,
  EngineOperationResults,
} from "./operations.js";

/** Engine failures carry stable names, never raw arbitrary exceptions/stacks. */
function failureName(error: unknown): string {
  const name = error instanceof Error ? error.name : "Error";
  return /^(?:Measurement|Section|Printability|Simplify|Alignment)(?:Input|ResourceLimit|Geometry)Error$|^(?:WorkBudgetExceeded|NumericRangeExceededError|RangeError|ZodError)$/u.test(
    name,
  )
    ? name
    : "EngineError";
}
export function handleOperation(
  scope: EngineWorkerScope,
  request: OperationWorkerRequest,
): void {
  let response: OperationWorkerResponse;
  let transfer: ArrayBuffer[] = [];
  try {
    if (request.version !== 1) throw new Error("Unsupported protocol version.");
    let result: EngineOperationResults[keyof EngineOperationResults];
    switch (request.kind) {
      case "clearance":
        result = checkClearance(request.input.input, request.input.options);
        break;
      case "measure":
        result = measureOnModel(
          request.input.model,
          request.input.query,
          request.input.options,
        );
        break;
      case "section":
        result = sectionModel(
          request.input.model,
          request.input.plane,
          request.input.options,
        );
        break;
      case "printability":
        result = assessPrintability(request.input.model, request.input.options);
        break;
      case "simplify":
        result = simplifyModel(request.input.model, request.input.options);
        transfer = [...collectModelBuffers(result.model)];
        break;
      case "alignment":
        result = estimateAlignment(request.input.input, request.input.options);
        break;
      default:
        throw new Error("Unsupported operation.");
    }
    response = {
      version: 1,
      kind: request.kind,
      requestId: request.requestId,
      ok: true,
      result,
    } as OperationWorkerResponse;
  } catch (error) {
    const errorName = failureName(error);
    response = {
      version: 1,
      kind: request.kind,
      requestId: request.requestId,
      ok: false,
      errorName,
      message: `The engine operation failed safely (${errorName}).`,
    };
    transfer = [];
  }
  scope.postMessage(response, transfer);
}
