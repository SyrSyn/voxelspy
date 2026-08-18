/// <reference lib="webworker" />

import { diagnoseMeshHealth, inspectModel } from "@voxelspy/analysis";
import { importRequestSchema, modelIdSchema } from "@voxelspy/contracts";
import { importModel } from "@voxelspy/importers";

import type {
  InspectWorkerRequest,
  InspectWorkerResponse,
} from "./inspect-worker-client";

const scope = self as DedicatedWorkerGlobalScope;

scope.addEventListener(
  "message",
  (event: MessageEvent<InspectWorkerRequest>) => {
    void handle(event.data);
  },
);

async function handle(data: InspectWorkerRequest) {
  const { requestId, kind } = data;
  let response: InspectWorkerResponse;
  try {
    const request = importRequestSchema.parse({
      contractVersion: 1,
      targetModelId: modelIdSchema.parse("model.inspect"),
      format: data.format,
      sourceName: data.sourceName,
      bytes: data.bytes,
      options: {
        ...data.options,
        limits: {
          inputBytes: Math.min(
            32 * 1024 * 1024,
            Math.max(data.bytes.byteLength, 1),
          ),
          triangleCount: 500_000,
        },
      },
    });
    const imported = await importModel(request);
    if (!imported.ok) {
      response = { requestId, kind, ok: false, message: imported.message };
    } else if (kind === "inspect") {
      const inspection = inspectModel(imported.model);
      response = {
        requestId,
        kind,
        ok: true,
        outcome: { inspection, warnings: imported.model.warnings },
      };
    } else {
      const diagnosis = diagnoseMeshHealth(imported.model);
      response = {
        requestId,
        kind,
        ok: true,
        outcome: { model: imported.model, diagnosis },
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
          : "Model inspection failed safely.",
    };
  }
  scope.postMessage(response);
}
