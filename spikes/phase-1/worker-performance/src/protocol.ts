/** Experimental evidence protocol. This is deliberately not an accepted public API. */
export const SPIKE_PROTOCOL_VERSION = 1 as const;

export interface InitializationRequest {
  type: "initialize";
  requestId: string;
  protocolVersion: typeof SPIKE_PROTOCOL_VERSION;
  geometry: { scratchBytes: number };
  cad?: { wasmUrl: string; required: boolean };
}

export interface RunRequest {
  type: "run";
  requestId: string;
  values: Float64Array;
  chunkSize: number;
  multiplier: number;
}

export interface CancelRequest {
  type: "cancel";
  targetRequestId: string;
}

export interface DisposeRequest {
  type: "dispose";
}

export type WorkerRequest =
  InitializationRequest | RunRequest | CancelRequest | DisposeRequest;

export interface ReadyMessage {
  type: "ready";
  protocolVersion: typeof SPIKE_PROTOCOL_VERSION;
}

export interface InitializedMessage {
  type: "initialized";
  requestId: string;
  geometryProvider: string;
  cadProvider?: string;
  warnings: string[];
}

export interface ProgressMessage {
  type: "progress";
  requestId: string;
  completed: number;
  total: number;
}

export interface ResultMessage {
  type: "result";
  requestId: string;
  values: Float64Array;
  checksum: number;
}

export interface CancelledMessage {
  type: "cancelled";
  requestId: string;
}

export interface ErrorMessage {
  type: "error";
  requestId?: string;
  code:
    | "INVALID_REQUEST"
    | "NOT_INITIALIZED"
    | "INITIALIZATION_FAILED"
    | "RUN_FAILED";
  message: string;
}

export type WorkerResponse =
  | ReadyMessage
  | InitializedMessage
  | ProgressMessage
  | ResultMessage
  | CancelledMessage
  | ErrorMessage;

export function isWorkerRequest(value: unknown): value is WorkerRequest {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  switch (candidate.type) {
    case "initialize":
      return (
        typeof candidate.requestId === "string" &&
        candidate.protocolVersion === SPIKE_PROTOCOL_VERSION &&
        isInitializationGeometry(candidate.geometry) &&
        (candidate.cad === undefined || isCadConfiguration(candidate.cad))
      );
    case "run":
      return (
        typeof candidate.requestId === "string" &&
        candidate.values instanceof Float64Array &&
        isPositiveInteger(candidate.chunkSize) &&
        typeof candidate.multiplier === "number" &&
        Number.isFinite(candidate.multiplier)
      );
    case "cancel":
      return typeof candidate.targetRequestId === "string";
    case "dispose":
      return true;
    default:
      return false;
  }
}

function isInitializationGeometry(
  value: unknown,
): value is InitializationRequest["geometry"] {
  return (
    !!value &&
    typeof value === "object" &&
    isNonNegativeInteger((value as Record<string, unknown>).scratchBytes)
  );
}

function isCadConfiguration(
  value: unknown,
): value is NonNullable<InitializationRequest["cad"]> {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.wasmUrl === "string" &&
    typeof candidate.required === "boolean"
  );
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}
