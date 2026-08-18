/// <reference lib="webworker" />

import {
  AlignmentGeometryError,
  AlignmentInputError,
  AlignmentResourceLimitError,
  estimateAlignment,
} from "@voxelspy/analysis";
import {
  IDENTITY_MAT4,
  importRequestSchema,
  modelIdSchema,
  rigidTransformSchema,
  type NormalizedModel,
} from "@voxelspy/contracts";
import { importModel } from "@voxelspy/importers";

import type {
  AlignmentIcpWorkerRequest,
  AlignmentIcpWorkerResponse,
} from "./alignment-worker-client";

const scope = self as DedicatedWorkerGlobalScope;

scope.addEventListener(
  "message",
  (event: MessageEvent<AlignmentIcpWorkerRequest>) => {
    void handle(event.data);
  },
);

type PartImport =
  | { readonly ok: true; readonly model: NormalizedModel }
  | { readonly ok: false; readonly message: string };

async function importPart(
  part: AlignmentIcpWorkerRequest["moving"],
  targetModelId: string,
): Promise<PartImport> {
  const request = importRequestSchema.parse({
    contractVersion: 1,
    targetModelId: modelIdSchema.parse(targetModelId),
    format: part.format,
    sourceName: part.sourceName,
    bytes: part.bytes,
    options: {
      ...part.options,
      limits: {
        inputBytes: Math.min(
          32 * 1024 * 1024,
          Math.max(part.bytes.byteLength, 1),
        ),
        triangleCount: 500_000,
      },
    },
  });
  const imported = await importModel(request);
  if (!imported.ok) return { ok: false, message: imported.message };
  return { ok: true, model: imported.model };
}

/**
 * Maps this module's known, typed alignment failures (never applied, never
 * silent) to a plain message the worker's response can carry. An unknown
 * failure gets a safe generic message rather than leaking internals -- the
 * same fail-closed discipline `describeSessionError` uses in `session.ts`.
 */
function describeAlignmentFailure(error: unknown): string {
  if (
    error instanceof AlignmentInputError ||
    error instanceof AlignmentGeometryError ||
    error instanceof AlignmentResourceLimitError
  )
    return error.message;
  if (error instanceof Error) return error.message;
  return "Alignment estimate failed safely.";
}

async function handle(data: AlignmentIcpWorkerRequest) {
  const { requestId, kind } = data;
  let response: AlignmentIcpWorkerResponse;
  try {
    const [movingImport, fixedImport] = await Promise.all([
      importPart(data.moving, "model.alignment.moving"),
      importPart(data.fixed, "model.alignment.fixed"),
    ]);
    if (!movingImport.ok) {
      response = { requestId, kind, ok: false, message: movingImport.message };
    } else if (!fixedImport.ok) {
      response = { requestId, kind, ok: false, message: fixedImport.message };
    } else {
      const initialTransform =
        data.initialTransform === undefined
          ? undefined
          : rigidTransformSchema.parse(data.initialTransform);
      const estimate = estimateAlignment(
        {
          method: "iterative-closest-point",
          moving: movingImport.model,
          fixed: {
            model: fixedImport.model,
            modelToComparison: rigidTransformSchema.parse(IDENTITY_MAT4),
          },
          ...(initialTransform === undefined ? {} : { initialTransform }),
        },
        {
          ...(data.maxIterations === undefined
            ? {}
            : { maxIterations: data.maxIterations }),
          ...(data.convergenceToleranceMillimetres === undefined
            ? {}
            : {
                convergenceToleranceMillimetres:
                  data.convergenceToleranceMillimetres,
              }),
        },
      );
      response = { requestId, kind, ok: true, estimate };
    }
  } catch (error) {
    response = {
      requestId,
      kind,
      ok: false,
      message: describeAlignmentFailure(error),
    };
  }
  scope.postMessage(response);
}
