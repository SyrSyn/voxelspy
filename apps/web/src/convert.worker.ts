/// <reference lib="webworker" />

import { simplifyModel } from "@voxelspy/analysis";
import {
  importRequestSchema,
  modelIdSchema,
  type MeshBuffer,
  type MeshId,
  type NormalizedModel,
} from "@voxelspy/contracts";
import { exportModel, importModel } from "@voxelspy/importers";

import type {
  ConvertWorkerRequest,
  ConvertWorkerResponse,
  PlacedGeometryCounts,
} from "./convert-worker-client";

const scope = self as DedicatedWorkerGlobalScope;

/**
 * This worker session's two models -- see `convert-worker-client.ts`'s
 * module doc comment for why this is a small persistent session rather than
 * `inspect.worker.ts`'s spin-up-per-call shape. `originalModel` is set once
 * by `"load"`; `simplifiedModel` is set (and replaced) by each successful
 * `"simplify"` call. Neither ever leaves this worker -- only the small
 * report objects `convert-worker-client.ts` defines, plus (for `"export"`)
 * the produced file bytes, cross back to the main thread.
 */
let originalModel: NormalizedModel | undefined;
let simplifiedModel: NormalizedModel | undefined;

/** Placed (post-instancing, pre-degenerate-exclusion) triangle/vertex counts,
 *  computed the same way `exportModel`'s own `countFlattenedGeometry`
 *  (`packages/importers/src/export.ts`) does: summed per placement instance,
 *  not per unique mesh. Deliberately duplicated here rather than imported --
 *  it is not part of either package's public surface, and this is a small,
 *  pure, three-line walk. */
function placedGeometryCounts(model: NormalizedModel): PlacedGeometryCounts {
  const meshById = new Map<MeshId, MeshBuffer>(
    model.meshes.map((mesh) => [mesh.id, mesh.geometry] as const),
  );
  let triangleCount = 0;
  let vertexCount = 0;
  for (const instance of model.placement.instances) {
    const geometry = meshById.get(instance.meshId);
    if (!geometry) continue; // unreachable once normalizedModelSchema has validated model
    triangleCount += geometry.indices.length / 3;
    vertexCount += geometry.positions.length / 3;
  }
  return {
    triangleCount,
    vertexCount,
    meshCount: model.meshes.length,
    instanceCount: model.placement.instances.length,
  };
}

scope.addEventListener(
  "message",
  (event: MessageEvent<ConvertWorkerRequest>) => {
    void handle(event.data);
  },
);

async function handle(data: ConvertWorkerRequest) {
  const { requestId, kind } = data;
  let response: ConvertWorkerResponse;
  let transfer: Transferable[] = [];
  try {
    if (kind === "load") {
      const request = importRequestSchema.parse({
        contractVersion: 1,
        targetModelId: modelIdSchema.parse("model.convert"),
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
        originalModel = imported.model;
        simplifiedModel = undefined;
        response = {
          requestId,
          kind,
          ok: true,
          outcome: {
            modelId: imported.model.id,
            sourceName: data.sourceName,
            counts: placedGeometryCounts(imported.model),
            provenance: imported.model.provenance,
            warnings: imported.model.warnings,
          },
        };
      }
    } else if (kind === "simplify") {
      if (!originalModel) {
        response = {
          requestId,
          kind,
          ok: false,
          message: "No model is loaded in this conversion session.",
        };
      } else {
        const result = simplifyModel(originalModel, data.options);
        simplifiedModel = result.model;
        const { model: _simplifiedModel, ...outcome } = result;
        response = { requestId, kind, ok: true, outcome };
      }
    } else {
      if (!originalModel) {
        response = {
          requestId,
          kind,
          ok: false,
          message: "No model is loaded in this conversion session.",
        };
      } else if (data.source === "simplified" && !simplifiedModel) {
        response = {
          requestId,
          kind,
          ok: false,
          message:
            "No simplified model is available yet in this session; run simplification first, or export the original.",
        };
      } else {
        const target =
          data.source === "simplified" ? simplifiedModel! : originalModel;
        const result = await exportModel(target, data.options);
        response = {
          requestId,
          kind,
          ok: true,
          outcome: { ...result, source: data.source },
        };
        // `ExportResult.bytes` is a plain `Uint8Array`, generic over
        // `ArrayBufferLike` in this TypeScript version's lib types; cast to
        // the concrete `ArrayBuffer` `Transferable` expects, matching
        // `session.ts`'s own `asArrayBufferBacked` cast for the same reason.
        transfer = [result.bytes.buffer as ArrayBuffer];
      }
    }
  } catch (error) {
    response = {
      requestId,
      kind,
      ok: false,
      message:
        error instanceof Error ? error.message : "Conversion failed safely.",
    };
  }
  scope.postMessage(response, transfer);
}
