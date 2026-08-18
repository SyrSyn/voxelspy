/// <reference lib="webworker" />

import { measureOnModel, sectionModel } from "@voxelspy/analysis";
import {
  importRequestSchema,
  modelIdSchema,
  type NormalizedModel,
} from "@voxelspy/contracts";
import { importModel } from "@voxelspy/importers";

import type {
  MeasureWorkerRequest,
  MeasureWorkerResponse,
} from "./measure-worker-client";

const scope = self as DedicatedWorkerGlobalScope;

/**
 * The one model this worker session was opened for -- see
 * `measure-worker-client.ts`'s module doc comment: a fresh worker is created
 * per `openMeasureSession` call and lives for as long as the session does,
 * so this module-scope variable holds exactly one model at a time, set once
 * by `"load"` and read by every subsequent `"measure"`/`"section"` request
 * against this same worker instance. Never re-imported on a later query --
 * that is the whole point of this being a session rather than
 * `inspect.worker.ts`'s spin-up-per-call shape.
 */
let currentModel: NormalizedModel | undefined;

scope.addEventListener(
  "message",
  (event: MessageEvent<MeasureWorkerRequest>) => {
    void handle(event.data);
  },
);

async function handle(data: MeasureWorkerRequest) {
  const { requestId, kind } = data;
  let response: MeasureWorkerResponse;
  try {
    if (kind === "load") {
      const request = importRequestSchema.parse({
        contractVersion: 1,
        targetModelId: modelIdSchema.parse("model.measure"),
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
      } else {
        currentModel = imported.model;
        response = {
          requestId,
          kind,
          ok: true,
          outcome: { model: imported.model, warnings: imported.model.warnings },
        };
      }
    } else if (kind === "measure") {
      if (!currentModel) {
        response = {
          requestId,
          kind,
          ok: false,
          message: "No model is loaded in this measurement session.",
        };
      } else {
        const result = measureOnModel(currentModel, data.query, data.options);
        response = { requestId, kind, ok: true, result };
      }
    } else {
      if (!currentModel) {
        response = {
          requestId,
          kind,
          ok: false,
          message: "No model is loaded in this measurement session.",
        };
      } else {
        const result = sectionModel(currentModel, data.plane, data.options);
        response = { requestId, kind, ok: true, result };
      }
    }
  } catch (error) {
    response = {
      requestId,
      kind,
      ok: false,
      message:
        error instanceof Error ? error.message : "Measurement failed safely.",
    };
  }
  scope.postMessage(response);
}
