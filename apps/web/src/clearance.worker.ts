/// <reference lib="webworker" />

import { checkClearance } from "@voxelspy/analysis";
import {
  importRequestSchema,
  modelIdSchema,
  rigidTransformSchema,
  type NormalizedModel,
} from "@voxelspy/contracts";
import { importModel } from "@voxelspy/importers";

import type {
  ClearanceWorkerRequest,
  ClearanceWorkerResponse,
} from "./clearance-worker-client";

const scope = self as DedicatedWorkerGlobalScope;

scope.addEventListener(
  "message",
  (event: MessageEvent<ClearanceWorkerRequest>) => {
    void handle(event.data);
  },
);

type PartImport =
  | { readonly ok: true; readonly model: NormalizedModel }
  | { readonly ok: false; readonly message: string };

async function importPart(
  part: ClearanceWorkerRequest["first"],
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

async function handle(data: ClearanceWorkerRequest) {
  const { requestId, kind } = data;
  let response: ClearanceWorkerResponse;
  try {
    const [firstImport, secondImport] = await Promise.all([
      importPart(data.first, "model.clearance.first"),
      importPart(data.second, "model.clearance.second"),
    ]);
    if (!firstImport.ok) {
      response = { requestId, kind, ok: false, message: firstImport.message };
    } else if (!secondImport.ok) {
      response = {
        requestId,
        kind,
        ok: false,
        message: secondImport.message,
      };
    } else {
      const result = checkClearance({
        first: {
          model: firstImport.model,
          modelToComparison: rigidTransformSchema.parse(
            data.first.modelToComparison,
          ),
        },
        second: {
          model: secondImport.model,
          modelToComparison: rigidTransformSchema.parse(
            data.second.modelToComparison,
          ),
        },
        desiredClearanceMillimetres: data.desiredClearanceMillimetres,
      });
      response = {
        requestId,
        kind,
        ok: true,
        outcome: {
          result,
          first: {
            model: firstImport.model,
            warnings: firstImport.model.warnings,
          },
          second: {
            model: secondImport.model,
            warnings: secondImport.model.warnings,
          },
        },
      };
    }
  } catch (error) {
    response = {
      requestId,
      kind,
      ok: false,
      message:
        error instanceof Error
          ? error.message
          : "Clearance check failed safely.",
    };
  }
  scope.postMessage(response);
}
