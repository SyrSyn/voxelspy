import type {
  AnalysisRequest,
  AnalysisResult,
  NormalizedModel,
} from "@voxelspy/contracts";
import type { InspectOptions, InspectionResult } from "@voxelspy/analysis";

/**
 * Wire protocol between this package's main-thread worker client
 * (`worker-client.ts`, used internally by the hooks) and the worker-side
 * handler a consumer's own worker entry file calls (`createEngineWorkerHandler`,
 * exported from `@voxelspy/react/worker`). See the package README's "Worker
 * supply contract" section for why construction and protocol are split this
 * way: a library cannot itself write `new Worker(new URL(...), { type:
 * "module" })` in a form the consumer's bundler will resolve, so the
 * consumer owns the worker file and this module owns the messages that
 * cross it.
 *
 * Every request/response here carries a plain, non-negative integer
 * `requestId`: each hook call spins up one fresh, single-purpose worker for
 * one request (see `worker-client.ts`), so a request ID only ever has to be
 * unique against a single in-flight call on that worker, not across a whole
 * session -- unlike `@voxelspy/contracts`'s branded, session-scoped
 * `RequestId`.
 */

export interface InspectWorkerRequest {
  readonly kind: "inspect";
  readonly requestId: number;
  readonly model: NormalizedModel;
  readonly options?: InspectOptions;
}

export interface CompareWorkerRequest {
  readonly kind: "compare";
  readonly requestId: number;
  readonly request: AnalysisRequest;
  readonly baseline: NormalizedModel;
  readonly candidate: NormalizedModel;
}

export type EngineWorkerRequest = InspectWorkerRequest | CompareWorkerRequest;

/**
 * `errorName` carries the thrown error's `.name` (e.g.
 * `"InspectionResourceLimitError"`, `"ZodError"`, `"RangeError"`) so a
 * caller can distinguish failure kinds without the worker boundary erasing
 * that information down to a bare string -- see `describeEngineFailure` in
 * `errors.ts`.
 */
export interface InspectWorkerFailure {
  readonly kind: "inspect";
  readonly requestId: number;
  readonly ok: false;
  readonly message: string;
  readonly errorName: string | undefined;
}

export interface InspectWorkerSuccess {
  readonly kind: "inspect";
  readonly requestId: number;
  readonly ok: true;
  readonly result: InspectionResult;
}

export interface CompareWorkerFailure {
  readonly kind: "compare";
  readonly requestId: number;
  readonly ok: false;
  readonly message: string;
  readonly errorName: string | undefined;
}

export interface CompareWorkerSuccess {
  readonly kind: "compare";
  readonly requestId: number;
  readonly ok: true;
  readonly result: AnalysisResult;
}

export type EngineWorkerResponse =
  | InspectWorkerSuccess
  | InspectWorkerFailure
  | CompareWorkerSuccess
  | CompareWorkerFailure;

/** Narrow, structural type for what the worker-side handler needs to send a
 *  response: satisfied by a `DedicatedWorkerGlobalScope` (i.e. `self` inside
 *  a module worker) without requiring this file to pull in the `webworker`
 *  lib, which would conflict with the `DOM` lib the rest of this package's
 *  main-thread code needs. */
export interface EngineWorkerScope {
  postMessage(message: EngineWorkerResponse): void;
}

/**
 * Every typed-array buffer backing a `NormalizedModel`'s mesh geometry, in
 * `meshes` order, each buffer listed once. Used by `worker-client.ts` to
 * build an explicit transfer list when a caller opts into zero-copy
 * transfer (see `useModelInspection`/`useModelComparison`'s `transferModel`
 * call option) -- never used implicitly, since transferring detaches the
 * buffers from the caller's own model.
 */
export function collectModelBuffers(
  model: NormalizedModel,
): readonly ArrayBuffer[] {
  const buffers = new Set<ArrayBuffer>();
  for (const mesh of model.meshes) {
    buffers.add(mesh.geometry.positions.buffer);
    buffers.add(mesh.geometry.indices.buffer);
  }
  return [...buffers];
}
