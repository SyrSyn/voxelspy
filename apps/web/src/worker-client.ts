import { ANALYSIS_LIMITS, SURFACE_DISTANCE_METHOD } from "@voxelspy/analysis";
import {
  IDENTITY_MAT4,
  WORKER_PROTOCOL_VERSION,
  analysisExchangeSchema,
  analysisRequestSchema,
  getWorkerMessageTransferList,
  importExchangeSchema,
  importRequestSchema,
  modelIdSchema,
  requestIdSchema,
  workerOutboundMessageSchema,
  type AnalysisResult,
  type ImportResult,
  type ModelId,
  type NormalizedModel,
  type RequestId,
  type SourceAxis,
  type SourceUnit,
  type WorkerOutboundMessage,
} from "@voxelspy/contracts";
import { inferFormat } from "@voxelspy/importers";

type ResolvedUnit = Exclude<SourceUnit, "unknown">;
type ResolvedAxis = Exclude<SourceAxis, "unknown">;

export interface ComparisonSource {
  file: File;
  unit: ResolvedUnit;
  axis: ResolvedAxis;
  frameSource?: "default" | "expert";
}

export interface CompletedComparison {
  baseline: NormalizedModel;
  candidate: NormalizedModel;
  analysis: AnalysisResult;
}

/**
 * Everything the worker's import protocol needs for one model, already
 * resolved to raw bytes. `runComparison` builds this from a `File` the user
 * chose; reopening a saved session builds the same shape from the bytes
 * stored in the session archive so both paths share one import path through
 * the worker.
 */
export interface SessionImportSpec {
  targetModelId: ModelId;
  format: string;
  sourceName: string;
  bytes: Uint8Array;
  options: {
    declaredUnit?: ResolvedUnit;
    declaredAxis?: ResolvedAxis;
    userUnit?: ResolvedUnit;
    userAxis?: ResolvedAxis;
  };
}

export type ComparisonProgress = {
  stage: "starting" | "baseline" | "candidate" | "analysis";
  message: string;
};

export const ANALYSIS_MEMORY_MIN_MIB = 128;
export const ANALYSIS_MEMORY_MAX_MIB = 768;
export const ANALYSIS_MEMORY_STEP_MIB = 128;
export const DEFAULT_ANALYSIS_MEMORY_MIB = 256;
export const MAX_CHANGED_REGIONS = 24;
const WORK_UNITS_PER_MIB = 100_000;

/** Grace period given to the worker to acknowledge cancellation before it is terminated. */
export const CANCEL_GRACE_PERIOD_MS = 500;
/** No message of any kind (including progress) for this long is treated as a stalled worker. */
export const INACTIVITY_TIMEOUT_MS = 120_000;

/**
 * Raised when a comparison run is stopped because its AbortSignal fired.
 * Distinct from `Error` subclasses used for genuine failures so callers can
 * tell "the user cancelled" apart from "the comparison failed".
 */
export class ComparisonCancelledError extends Error {
  constructor(message = "Comparison cancelled.") {
    super(message);
    this.name = "ComparisonCancelledError";
  }
}

/**
 * A structured failure surfaced by the worker protocol itself rather than by
 * geometry import or analysis: an invalid/unversioned message, a duplicate
 * request ID, or a worker that stopped responding entirely.
 */
export class ComparisonProtocolError extends Error {
  readonly code: string | undefined;
  constructor(message: string, code?: string) {
    super(message);
    this.name = "ComparisonProtocolError";
    this.code = code;
  }
}

export function analysisExecutionBudget(memoryMiB: number) {
  if (
    !Number.isInteger(memoryMiB) ||
    memoryMiB < ANALYSIS_MEMORY_MIN_MIB ||
    memoryMiB > ANALYSIS_MEMORY_MAX_MIB ||
    memoryMiB % ANALYSIS_MEMORY_STEP_MIB !== 0
  ) {
    throw new RangeError(
      `Analysis memory must be a ${ANALYSIS_MEMORY_STEP_MIB} MiB increment between ${ANALYSIS_MEMORY_MIN_MIB} and ${ANALYSIS_MEMORY_MAX_MIB} MiB.`,
    );
  }
  return {
    maxMemoryBytes: Math.min(
      memoryMiB * 1024 * 1024,
      ANALYSIS_LIMITS.maxMemoryBytes,
    ),
    maxWorkUnits: Math.min(
      memoryMiB * WORK_UNITS_PER_MIB,
      ANALYSIS_LIMITS.maxWorkUnits,
    ),
  };
}

/**
 * Bridges one live comparison worker's message stream into request/response
 * calls: `post` sends a wire message, `next` waits for the first queued
 * message matching a predicate (throwing if the run failed or was
 * cancelled first), and `setActiveRequestId` records which request ID a
 * cancellation should target.
 */
interface WorkerSession {
  post: (message: Parameters<typeof getWorkerMessageTransferList>[0]) => void;
  next: (
    predicate: (message: WorkerOutboundMessage) => boolean,
  ) => Promise<WorkerOutboundMessage>;
  setActiveRequestId: (id: RequestId | undefined) => void;
}

/**
 * Owns one comparison worker's full lifecycle: creation, the ready/initialize
 * handshake, cancellation wiring, the inactivity watchdog, and guaranteed
 * termination. `onReady` fires once the worker has announced itself and
 * before `initialize` is sent, so callers can surface a "preparing the
 * worker" progress message at the same point the previous single-purpose
 * implementation did. `run` receives a `WorkerSession` for the protocol
 * exchange it actually cares about (importing models, running analysis, or
 * both).
 */
async function withComparisonWorker<T>(
  signal: AbortSignal | undefined,
  onReady: () => void,
  run: (session: WorkerSession) => Promise<T>,
): Promise<T> {
  const worker = new Worker(
    new URL("./comparison.worker.ts", import.meta.url),
    { type: "module", name: "voxelspy-comparison" },
  );
  const queue: WorkerOutboundMessage[] = [];
  let wake: (() => void) | undefined;
  let failure: Error | undefined;
  let cancelledError: ComparisonCancelledError | undefined;
  let currentRequestId: RequestId | undefined;
  let cancelRequested = false;
  let inactivityTimer: ReturnType<typeof setTimeout> | undefined;

  const wakeWaiters = () => {
    wake?.();
    wake = undefined;
  };

  const resetInactivityTimer = () => {
    if (inactivityTimer !== undefined) clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(() => {
      failure = new ComparisonProtocolError(
        "Comparison worker was inactive for too long and was terminated.",
        "inactivity-timeout",
      );
      worker.terminate();
      wakeWaiters();
    }, INACTIVITY_TIMEOUT_MS);
  };

  worker.addEventListener("message", (event: MessageEvent<unknown>) => {
    resetInactivityTimer();
    const parsed = workerOutboundMessageSchema.safeParse(event.data);
    if (!parsed.success) {
      failure = new ComparisonProtocolError(
        "Comparison worker returned an invalid message.",
      );
    } else if (parsed.data.type === "progress") {
      // Progress updates are informational only; consume them immediately so
      // they never pile up in the queue waiting for a predicate that will
      // never match them.
    } else if (
      parsed.data.type === "error" &&
      parsed.data.requestId === undefined
    ) {
      // Protocol-level errors (invalid message, duplicate request ID, ...)
      // carry no request ID, so no `next()` predicate below would ever match
      // them. Fail the in-flight wait immediately instead of queuing forever.
      failure = new ComparisonProtocolError(
        parsed.data.error.message,
        parsed.data.error.code,
      );
    } else {
      queue.push(parsed.data);
    }
    wakeWaiters();
  });
  worker.addEventListener("error", () => {
    failure = new ComparisonProtocolError(
      "Comparison worker stopped unexpectedly.",
    );
    wakeWaiters();
  });

  const next = async (
    predicate: (message: WorkerOutboundMessage) => boolean,
  ) => {
    while (true) {
      if (cancelledError) throw cancelledError;
      if (failure) throw failure;
      const index = queue.findIndex(predicate);
      if (index >= 0) return queue.splice(index, 1)[0]!;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  };
  const post = (message: Parameters<typeof getWorkerMessageTransferList>[0]) =>
    worker.postMessage(message, getWorkerMessageTransferList(message));

  const triggerCancel = () => {
    if (cancelRequested) return;
    cancelRequested = true;
    void (async () => {
      const targetRequestId = currentRequestId;
      if (targetRequestId) {
        try {
          const cancelId = requestIdSchema.parse(`cancel.${targetRequestId}`);
          post({
            protocolVersion: 1,
            type: "cancel",
            requestId: cancelId,
            targetRequestId,
          });
        } catch {
          // Fall through to termination even if the cancel message itself
          // could not be constructed or sent.
        }
        await new Promise<void>((resolve) =>
          setTimeout(resolve, CANCEL_GRACE_PERIOD_MS),
        );
      }
      cancelledError = new ComparisonCancelledError();
      worker.terminate();
      wakeWaiters();
    })();
  };
  signal?.addEventListener("abort", triggerCancel);
  if (signal?.aborted) triggerCancel();
  resetInactivityTimer();
  try {
    await next((message) => message.type === "ready");
    onReady();
    const initializeId = requestIdSchema.parse("initialize.1");
    post({
      protocolVersion: WORKER_PROTOCOL_VERSION,
      type: "initialize",
      requestId: initializeId,
    });
    await next(
      (message) =>
        message.type === "initialized" && message.requestId === initializeId,
    );
    return await run({
      post,
      next,
      setActiveRequestId: (id) => {
        currentRequestId = id;
      },
    });
  } finally {
    if (inactivityTimer !== undefined) clearTimeout(inactivityTimer);
    signal?.removeEventListener("abort", triggerCancel);
    worker.terminate();
  }
}

/**
 * Runs one "import" round trip for a single model. `buildSpec` is called
 * only after the `role` progress message is published so progress ordering
 * matches what a caller would see reading a File from disk: "Importing
 * baseline geometry" appears before any of that model's bytes are touched.
 */
async function importOne(
  session: WorkerSession,
  progress: (value: ComparisonProgress) => void,
  role: "baseline" | "candidate",
  buildSpec: () => Promise<SessionImportSpec>,
): Promise<NormalizedModel> {
  progress({ stage: role, message: `Importing ${role} geometry` });
  const spec = await buildSpec();
  const requestId = requestIdSchema.parse(`import.${role}.1`);
  const request = importRequestSchema.parse({
    contractVersion: 1,
    targetModelId: spec.targetModelId,
    format: spec.format,
    sourceName: spec.sourceName,
    bytes: spec.bytes,
    options: {
      ...spec.options,
      limits: {
        inputBytes: Math.min(
          32 * 1024 * 1024,
          Math.max(spec.bytes.byteLength, 1),
        ),
        triangleCount: 500_000,
      },
    },
  });
  const validationRequest = structuredClone(request);
  session.setActiveRequestId(requestId);
  session.post({
    protocolVersion: 1,
    type: "execute",
    operation: "import",
    requestId,
    request,
  });
  const response = await session.next(
    (message) =>
      (message.type === "result" || message.type === "error") &&
      message.requestId === requestId,
  );
  session.setActiveRequestId(undefined);
  if (response.type === "error") throw new Error(response.error.message);
  if (response.type !== "result" || response.operation !== "import")
    throw new Error("Comparison worker returned the wrong import result type.");
  const result: ImportResult = response.result;
  if (!result.ok) throw new Error(result.message);
  importExchangeSchema.parse({ request: validationRequest, result });
  return result.model;
}

async function specFromSource(
  role: "baseline" | "candidate",
  source: ComparisonSource,
): Promise<SessionImportSpec> {
  const format = inferFormat(source.file.name);
  if (!format)
    throw new Error(`${source.file.name} is not a supported STL or OBJ file.`);
  const bytes = new Uint8Array(await source.file.arrayBuffer());
  return {
    targetModelId: modelIdSchema.parse(`model.${role}`),
    format,
    sourceName: source.file.name,
    bytes,
    options:
      source.frameSource === "expert"
        ? { userUnit: source.unit, userAxis: source.axis }
        : { declaredUnit: source.unit, declaredAxis: source.axis },
  };
}

export async function runComparison(
  baselineSource: ComparisonSource,
  candidateSource: ComparisonSource,
  progress: (value: ComparisonProgress) => void,
  analysisMemoryMiB = DEFAULT_ANALYSIS_MEMORY_MIB,
  signal?: AbortSignal,
): Promise<CompletedComparison> {
  return withComparisonWorker(
    signal,
    () =>
      progress({
        stage: "starting",
        message: "Preparing the local comparison worker",
      }),
    async (session) => {
      const baseline = await importOne(session, progress, "baseline", () =>
        specFromSource("baseline", baselineSource),
      );
      const candidate = await importOne(session, progress, "candidate", () =>
        specFromSource("candidate", candidateSource),
      );
      progress({
        stage: "analysis",
        message: "Analyzing tessellated surface distance",
      });
      const analysisId = requestIdSchema.parse("analysis.1");
      const request = analysisRequestSchema.parse({
        contractVersion: 1,
        requestId: analysisId,
        baseline: { modelId: baseline.id, modelToComparison: IDENTITY_MAT4 },
        candidate: {
          modelId: candidate.id,
          modelToComparison: IDENTITY_MAT4,
        },
        method: {
          ...SURFACE_DISTANCE_METHOD,
          parameters: { maxRegions: MAX_CHANGED_REGIONS },
        },
        tolerance: { distanceMillimetres: 0.1 },
        executionBudget: analysisExecutionBudget(analysisMemoryMiB),
      });
      session.setActiveRequestId(analysisId);
      session.post({
        protocolVersion: 1,
        type: "execute",
        operation: "analysis",
        requestId: analysisId,
        request,
      });
      const response = await session.next(
        (message) =>
          (message.type === "result" || message.type === "error") &&
          message.requestId === analysisId,
      );
      session.setActiveRequestId(undefined);
      if (response.type === "error") throw new Error(response.error.message);
      if (response.type !== "result" || response.operation !== "analysis")
        throw new Error("Comparison worker returned the wrong result type.");
      const analysis = analysisExchangeSchema.parse({
        request,
        result: response.result,
      }).result;
      return { baseline, candidate, analysis };
    },
  );
}

/**
 * Reconstructs the two normalized models a saved session references, by
 * re-running the same deterministic import the session's report already
 * describes (same source bytes, same declared/user unit and axis
 * resolution) rather than storing typed-array geometry in the archive
 * itself. Analysis is not re-run: the caller already has a validated
 * `AnalysisResult` from the session's report.
 */
export async function reimportSessionModels(
  baselineSpec: SessionImportSpec,
  candidateSpec: SessionImportSpec,
  progress: (value: ComparisonProgress) => void,
  signal?: AbortSignal,
): Promise<{ baseline: NormalizedModel; candidate: NormalizedModel }> {
  return withComparisonWorker(
    signal,
    () =>
      progress({
        stage: "starting",
        message: "Preparing the local session worker",
      }),
    async (session) => {
      const baseline = await importOne(session, progress, "baseline", () =>
        Promise.resolve(baselineSpec),
      );
      const candidate = await importOne(session, progress, "candidate", () =>
        Promise.resolve(candidateSpec),
      );
      return { baseline, candidate };
    },
  );
}
