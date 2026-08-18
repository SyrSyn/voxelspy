/// <reference lib="webworker" />

import {
  assessPrintability,
  diagnoseMeshHealth,
  inspectModel,
} from "@voxelspy/analysis";
import {
  importRequestSchema,
  modelIdSchema,
  type NormalizedModel,
} from "@voxelspy/contracts";
import { importModel } from "@voxelspy/importers";

import type {
  ForensicsInstanceSummary,
  ForensicsMeshSummary,
  ForensicsOutcome,
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
    } else if (kind === "diagnose") {
      const diagnosis = diagnoseMeshHealth(imported.model);
      response = {
        requestId,
        kind,
        ok: true,
        outcome: { model: imported.model, diagnosis },
      };
    } else if (kind === "forensics") {
      response = {
        requestId,
        kind,
        ok: true,
        outcome: buildForensicsOutcome(imported.model),
      };
    } else {
      // `AssessPrintabilityOptions`'s leaves are all optional-but-not-
      // `| undefined` (`exactOptionalPropertyTypes` forbids assigning an
      // explicit `undefined` to those), so each maybe-present field below is
      // spread in only when actually supplied, rather than set to
      // `undefined` -- omitting a field here is exactly "use
      // `assessPrintability`'s own documented default", never a duplicated
      // client-side default.
      const options = data.assessmentOptions ?? {};
      const assessment = assessPrintability(imported.model, {
        ...(options.thinThresholdMillimetres === undefined
          ? {}
          : {
              wallThickness: {
                thinThresholdMillimetres: options.thinThresholdMillimetres,
              },
            }),
        overhang: {
          ...(options.buildDirection === undefined
            ? {}
            : { buildDirection: options.buildDirection }),
          ...(options.overhangThresholdDegreesFromVertical === undefined
            ? {}
            : {
                thresholdDegreesFromVertical:
                  options.overhangThresholdDegreesFromVertical,
              }),
        },
        ...(options.buildVolumeDimensionsMillimetres === undefined
          ? {}
          : {
              buildVolume: {
                dimensionsMillimetres: options.buildVolumeDimensionsMillimetres,
              },
            }),
      });
      response = {
        requestId,
        kind,
        ok: true,
        outcome: { model: imported.model, assessment },
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

/**
 * Builds the file Forensics report from an imported model, entirely from
 * data the importer already produced: `provenance` and `warnings` are passed
 * through verbatim, and the per-mesh/per-instance summary is derived from
 * the model's own typed-array buffers -- never from a second pass or a
 * separate validator. The buffers themselves (`positions`/`indices`) are
 * read only for their `.length` here and never included in the outcome, so
 * no geometry travels back to the main thread for this report kind.
 */
function buildForensicsOutcome(model: NormalizedModel): ForensicsOutcome {
  const meshes: ForensicsMeshSummary[] = model.meshes.map((mesh) => ({
    meshId: mesh.id,
    vertexCount: mesh.geometry.positions.length / 3,
    triangleCount: mesh.geometry.indices.length / 3,
  }));
  const instances: ForensicsInstanceSummary[] =
    model.placement.kind === "flat"
      ? model.placement.instances.map((instance) => ({
          instanceId: instance.id,
          meshId: instance.meshId,
          transformKind: "meshToModel" as const,
          transform: [...instance.meshToModel],
        }))
      : model.placement.instances.map((instance) => ({
          instanceId: instance.id,
          meshId: instance.meshId,
          transformKind: "meshToNode" as const,
          transform: [...instance.meshToNode],
        }));
  return {
    provenance: model.provenance,
    warnings: model.warnings,
    placementKind: model.placement.kind,
    meshes,
    instances,
  };
}
