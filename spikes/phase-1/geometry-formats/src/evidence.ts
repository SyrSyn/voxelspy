import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { format } from "prettier";

import {
  compareOccupancy,
  compareValidatedAxisAlignedSolids,
  sampledSurfaceDistance,
  validateClosedOrientedSolid,
} from "./comparison.ts";
import {
  asciiStlFixture,
  boxMesh,
  disconnectedCornerTetrahedra,
  glbFixture,
  gltfFixture,
  objFixture,
  openBoxMesh,
  sphereMesh,
  stepTessellationFixture,
  threeMfFixture,
} from "./fixtures.ts";
import {
  importGltf,
  importObj,
  importStl,
  importThreeMf,
  normalizeStepTessellation,
} from "./formats.ts";

export async function collectEvidence(): Promise<Record<string, unknown>> {
  const explicit = {
    declaredUnit: "millimetre" as const,
    declaredAxis: "right-handed-z-up" as const,
  };
  const formatModels = [
    importStl(asciiStlFixture(), {
      sourceName: "generated-ascii.stl",
      ...explicit,
    }),
    importObj(objFixture(), {
      sourceName: "generated.obj",
      declaredUnit: "centimetre",
      declaredAxis: "right-handed-z-up",
    }),
    await importThreeMf(threeMfFixture(), { sourceName: "generated.3mf" }),
    importGltf(gltfFixture(), { sourceName: "generated.gltf" }),
    importGltf(glbFixture(), { sourceName: "generated.glb" }),
    normalizeStepTessellation(stepTessellationFixture(0.01)),
  ];
  const first = boxMesh([0, 0, 0], [10, 10, 10]);
  const second = boxMesh([5.4, 0, 0], [15.4, 10, 10]);
  const coarseSphere = sphereMesh(10, 8, 4);
  const fineSphere = sphereMesh(10, 32, 16);
  return {
    schemaVersion: 1,
    scope: "non-final geometry and format evidence",
    normalizedTarget: {
      unit: "millimetre",
      coordinateSystem: "right-handed-z-up",
    },
    formats: formatModels.map((model) => ({
      source: model.provenance.sourceName,
      format: model.provenance.format,
      meshes: model.meshes.length,
      vertices: model.meshes.reduce(
        (sum, mesh) => sum + mesh.positions.length / 3,
        0,
      ),
      triangles: model.meshes.reduce(
        (sum, mesh) => sum + mesh.indices.length / 3,
        0,
      ),
      assemblyNodes: model.assembly?.length ?? 0,
      sourceUnit: model.provenance.sourceUnit,
      sourceAxis: model.provenance.sourceAxis,
      warnings: model.warnings.map((warning) => warning.code),
    })),
    comparisons: {
      sampledSurfaceDistanceOnRetessellatedSphere: roundedSurface(
        sampledSurfaceDistance(coarseSphere, fineSphere),
      ),
      occupancyAtTwoMillimetres: compareOccupancy(first, second, 2),
      occupancyAtOneMillimetre: compareOccupancy(first, second, 1),
      occupancyBudgetRefusal: compareOccupancy(first, second, 1, 100),
      validatedAxisAlignedSolid: compareValidatedAxisAlignedSolids(
        first,
        second,
      ),
      openMeshValidation: validateClosedOrientedSolid(openBoxMesh()),
      unsupportedSolidCase: compareValidatedAxisAlignedSolids(
        coarseSphere,
        fineSphere,
      ),
      disconnectedCornerFalsePositive: compareValidatedAxisAlignedSolids(
        disconnectedCornerTetrahedra(),
        boxMesh([0, 0, 0], [1, 1, 1]),
      ),
    },
  };
}

function roundedSurface(
  result: ReturnType<typeof sampledSurfaceDistance>,
): ReturnType<typeof sampledSurfaceDistance> {
  return {
    ...result,
    distanceMillimetres: Number(result.distanceMillimetres.toFixed(9)),
  };
}

async function main(): Promise<void> {
  const serialized = await format(JSON.stringify(await collectEvidence()), {
    parser: "json",
  });
  if (process.argv.includes("--check")) {
    const snapshotUrl = new URL("../evidence/results.json", import.meta.url);
    const expected = readFileSync(fileURLToPath(snapshotUrl), "utf8");
    if (serialized !== expected)
      throw new Error(
        "Evidence snapshot is not the byte-canonical runtime result; run pnpm evidence and review it",
      );
    console.log("Evidence snapshot byte-matches the canonical runtime result");
  } else {
    process.stdout.write(serialized);
  }
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href
)
  await main();
