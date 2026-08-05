import { SURFACE_DISTANCE_METHOD } from "@voxelspy/analysis";
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
  type NormalizedModel,
  type SourceAxis,
  type SourceUnit,
  type WorkerOutboundMessage,
} from "@voxelspy/contracts";
import { inferFormat } from "@voxelspy/importers";

export interface ComparisonSource {
  file: File;
  unit: Exclude<SourceUnit, "unknown">;
  axis: Exclude<SourceAxis, "unknown">;
  frameSource?: "default" | "expert";
}

export interface CompletedComparison {
  baseline: NormalizedModel;
  candidate: NormalizedModel;
  analysis: AnalysisResult;
}

export type ComparisonProgress = {
  stage: "starting" | "baseline" | "candidate" | "analysis";
  message: string;
};

export async function runComparison(
  baselineSource: ComparisonSource,
  candidateSource: ComparisonSource,
  progress: (value: ComparisonProgress) => void,
): Promise<CompletedComparison> {
  const worker = new Worker(
    new URL("./comparison.worker.ts", import.meta.url),
    { type: "module", name: "voxelspy-comparison" },
  );
  const queue: WorkerOutboundMessage[] = [];
  let wake: (() => void) | undefined;
  let failure: Error | undefined;
  worker.addEventListener("message", (event: MessageEvent<unknown>) => {
    const parsed = workerOutboundMessageSchema.safeParse(event.data);
    if (!parsed.success)
      failure = new Error("Comparison worker returned an invalid message.");
    else queue.push(parsed.data);
    wake?.();
    wake = undefined;
  });
  worker.addEventListener("error", () => {
    failure = new Error("Comparison worker stopped unexpectedly.");
    wake?.();
    wake = undefined;
  });

  const next = async (
    predicate: (message: WorkerOutboundMessage) => boolean,
  ) => {
    while (true) {
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
  try {
    await next((message) => message.type === "ready");
    progress({
      stage: "starting",
      message: "Preparing the local comparison worker",
    });
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

    const importOne = async (
      role: "baseline" | "candidate",
      source: ComparisonSource,
    ): Promise<NormalizedModel> => {
      progress({ stage: role, message: `Importing ${role} geometry` });
      const format = inferFormat(source.file.name);
      if (!format)
        throw new Error(
          `${source.file.name} is not a supported STL or OBJ file.`,
        );
      const requestId = requestIdSchema.parse(`import.${role}.1`);
      const bytes = new Uint8Array(await source.file.arrayBuffer());
      const request = importRequestSchema.parse({
        contractVersion: 1,
        targetModelId: modelIdSchema.parse(`model.${role}`),
        format,
        sourceName: source.file.name,
        bytes,
        options: {
          ...(source.frameSource === "expert"
            ? { userUnit: source.unit, userAxis: source.axis }
            : { declaredUnit: source.unit, declaredAxis: source.axis }),
          limits: {
            inputBytes: Math.min(
              32 * 1024 * 1024,
              Math.max(bytes.byteLength, 1),
            ),
            triangleCount: 500_000,
          },
        },
      });
      const validationRequest = structuredClone(request);
      post({
        protocolVersion: 1,
        type: "execute",
        operation: "import",
        requestId,
        request,
      });
      const response = await next(
        (message) =>
          (message.type === "result" || message.type === "error") &&
          message.requestId === requestId,
      );
      if (response.type === "error") throw new Error(response.error.message);
      if (response.type !== "result" || response.operation !== "import")
        throw new Error(
          "Comparison worker returned the wrong import result type.",
        );
      const result: ImportResult = response.result;
      if (!result.ok) throw new Error(result.message);
      importExchangeSchema.parse({ request: validationRequest, result });
      return result.model;
    };

    const baseline = await importOne("baseline", baselineSource);
    const candidate = await importOne("candidate", candidateSource);
    progress({
      stage: "analysis",
      message: "Analyzing tessellated surface distance",
    });
    const analysisId = requestIdSchema.parse("analysis.1");
    const request = analysisRequestSchema.parse({
      contractVersion: 1,
      requestId: analysisId,
      baseline: { modelId: baseline.id, modelToComparison: IDENTITY_MAT4 },
      candidate: { modelId: candidate.id, modelToComparison: IDENTITY_MAT4 },
      method: SURFACE_DISTANCE_METHOD,
      tolerance: { distanceMillimetres: 0.1 },
      executionBudget: {
        maxWorkUnits: 2_000_000,
        maxMemoryBytes: 256 * 1024 * 1024,
      },
    });
    post({
      protocolVersion: 1,
      type: "execute",
      operation: "analysis",
      requestId: analysisId,
      request,
    });
    const response = await next(
      (message) =>
        (message.type === "result" || message.type === "error") &&
        message.requestId === analysisId,
    );
    if (response.type === "error") throw new Error(response.error.message);
    if (response.type !== "result" || response.operation !== "analysis")
      throw new Error("Comparison worker returned the wrong result type.");
    const analysis = analysisExchangeSchema.parse({
      request,
      result: response.result,
    }).result;
    return { baseline, candidate, analysis };
  } finally {
    worker.terminate();
  }
}
