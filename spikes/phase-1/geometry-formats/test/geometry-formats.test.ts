import assert from "node:assert/strict";
import test from "node:test";
import { deflateRawSync } from "node:zlib";

import { readZip } from "../src/archive.ts";
import {
  compareOccupancy,
  compareValidatedAxisAlignedSolids,
  sampledSurfaceDistance,
  validateClosedOrientedSolid,
} from "../src/comparison.ts";
import {
  asciiStlFixture,
  binaryStlFixture,
  boxMesh,
  disconnectedCornerTetrahedra,
  glbFixture,
  gltfFixture,
  objFixture,
  openBoxMesh,
  rawDeflatedZip,
  sphereMesh,
  stepTessellationFixture,
  storedZip,
  threeMfFixture,
  threeMfModelBytes,
} from "../src/fixtures.ts";
import {
  importGltf,
  importObj,
  importStl,
  importThreeMf,
  normalizeStepTessellation,
} from "../src/formats.ts";

test("ASCII and binary STL normalize to the same millimetre geometry", () => {
  const options = {
    sourceName: "generated-tetrahedron.stl",
    declaredUnit: "millimetre" as const,
    declaredAxis: "right-handed-z-up" as const,
  };
  const ascii = importStl(asciiStlFixture(), options);
  const binary = importStl(binaryStlFixture(), options);
  assert.deepEqual(
    [...ascii.meshes[0]!.positions],
    [...binary.meshes[0]!.positions],
  );
  assert.deepEqual(
    [...ascii.meshes[0]!.indices],
    [...binary.meshes[0]!.indices],
  );
  assert.equal(ascii.unit, "millimetre");
  assert.equal(ascii.coordinateSystem, "right-handed-z-up");
});

test("STL and OBJ ambiguity is explicit when metadata is absent", () => {
  const stl = importStl(asciiStlFixture(), { sourceName: "generated.stl" });
  const obj = importObj(objFixture(), { sourceName: "generated.obj" });
  assert.deepEqual(
    stl.warnings.slice(0, 2).map((warning) => warning.code),
    ["ambiguous-unit", "ambiguous-axis"],
  );
  assert.deepEqual(
    obj.warnings.slice(0, 2).map((warning) => warning.code),
    ["ambiguous-unit", "ambiguous-axis"],
  );
});

test("OBJ declared metres and Y-up are scaled and rotated without recentering", () => {
  const model = importObj(objFixture(), {
    sourceName: "generated.obj",
    declaredUnit: "metre",
    declaredAxis: "right-handed-y-up",
  });
  assert.deepEqual([...model.meshes[0]!.positions.slice(9, 12)], [0, -1000, 0]);
  assert.equal(model.provenance.sourceToMillimetres, 1000);
  assert.equal(model.warnings.length, 0);
});

test("OBJ negative indices and polygon fan triangulation are deterministic", () => {
  const model = importObj(
    "v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nf -4 -3 -2 -1\n",
    {
      sourceName: "generated-quad.obj",
      declaredUnit: "millimetre",
      declaredAxis: "right-handed-z-up",
    },
  );
  assert.deepEqual([...model.meshes[0]!.indices], [0, 1, 2, 0, 2, 3]);
});

test("3MF Core mesh, units, build transform, and assembly remain serializable", async () => {
  const model = await importThreeMf(threeMfFixture(), {
    sourceName: "generated.3mf",
  });
  assert.deepEqual([...model.meshes[0]!.positions.slice(3, 6)], [10, 0, 0]);
  assert.equal(model.assembly?.length, 3);
  assert.deepEqual(model.assembly?.[2]?.children, [1]);
  assert.deepEqual(model.assembly?.[2]?.transform.slice(12, 15), [20, 0, 0]);
  assert.doesNotThrow(() => JSON.stringify(model.assembly));
});

test("3MF archive traversal, truncation, and expansion limits fail closed", async () => {
  await assert.rejects(
    importThreeMf(threeMfFixture("../escaped.model"), {
      sourceName: "unsafe.3mf",
    }),
    /escapes its archive root/u,
  );
  await assert.rejects(
    readZip(new Uint8Array([1, 2, 3])),
    /end-of-central-directory/u,
  );
  const archive = storedZip([
    { name: "3D/model.model", bytes: new Uint8Array(128) },
  ]);
  await assert.rejects(
    readZip(archive, { maxExpandedBytes: 64 }),
    /expanded-byte limit/u,
  );
});

test("3MF archive reader expands raw-deflated entries", async () => {
  const expanded = threeMfModelBytes();
  const compressed = Uint8Array.from(deflateRawSync(expanded));
  const archive = rawDeflatedZip("3D/3dmodel.model", expanded, compressed);
  await assert.rejects(
    importThreeMf(archive, { sourceName: "strict-deflated.3mf" }),
    /unbounded-decompression opt-in/u,
  );
  const model = await importThreeMf(archive, {
    sourceName: "opted-in-deflated.3mf",
    allowUnboundedDeflate: true,
  });
  assert.equal(model.meshes[0]?.indices.length, 12);
  const entries = await readZip(archive, {}, true);
  assert.equal(
    new TextDecoder().decode(entries[0]?.bytes),
    new TextDecoder().decode(expanded),
  );
});

test("3MF aggregate triangle budgets and component transforms fail closed", async () => {
  const xml = new TextDecoder().decode(threeMfModelBytes());
  const firstObject = /<object id="1"[\s\S]*?<\/object>/u.exec(xml)?.[0];
  assert.ok(firstObject);
  const duplicated = xml.replace(
    '<object id="2"',
    `${firstObject.replace('id="1"', 'id="3"')}\n  <object id="2"`,
  );
  await assert.rejects(
    importThreeMf(
      storedZip([
        {
          name: "3D/3dmodel.model",
          bytes: new TextEncoder().encode(duplicated),
        },
      ]),
      { sourceName: "aggregate-limit.3mf", limits: { maxTriangles: 6 } },
    ),
    /exceeds limit 6/u,
  );
  await assert.rejects(
    importThreeMf(
      threeMfFixture("3D/3dmodel.model", "1 0 0 0 1 0 0 0 1 1 0 0"),
      { sourceName: "component-transform.3mf" },
    ),
    /component-local transforms are rejected/u,
  );
});

test("static glTF and GLB normalize metres/Y-up and preserve node transforms", () => {
  for (const [name, source] of [
    ["generated.gltf", gltfFixture()],
    ["generated.glb", glbFixture()],
  ] as const) {
    const model = importGltf(source, { sourceName: name });
    const point = [...model.meshes[0]!.positions.slice(6, 9)];
    assert.ok(Math.abs(point[0] ?? 0) < 1e-12);
    assert.ok(Math.abs(point[1] ?? 0) < 1e-12);
    assert.ok(Math.abs((point[2] ?? 0) - 10) < 1e-6);
    assert.deepEqual(model.assembly?.[0]?.transform.slice(12, 15), [0, 0, 2]);
    assert.equal(model.provenance.sourceAxis, "right-handed-y-up");
  }
});

test("glTF external resources and non-triangle modes are rejected", () => {
  const external = JSON.stringify({
    asset: { version: "2.0" },
    buffers: [{ byteLength: 4, uri: "model.bin" }],
    bufferViews: [],
    accessors: [],
    meshes: [],
  });
  assert.throws(
    () => importGltf(external, { sourceName: "external.gltf" }),
    /External glTF resources are rejected/u,
  );
  const nonTriangles = JSON.parse(gltfFixture()) as Record<string, unknown>;
  const mesh = (
    nonTriangles.meshes as Array<{ primitives: Array<{ mode: number }> }>
  )[0]!;
  mesh.primitives[0]!.mode = 5;
  assert.throws(
    () =>
      importGltf(JSON.stringify(nonTriangles), { sourceName: "strip.gltf" }),
    /TRIANGLES/u,
  );
});

test("glTF aggregate budgets, animation, morphs, and invalid index types fail closed", () => {
  const aggregate = JSON.parse(gltfFixture()) as GltfFixture;
  aggregate.meshes.push(structuredClone(aggregate.meshes[0]!));
  assert.throws(
    () =>
      importGltf(JSON.stringify(aggregate), {
        sourceName: "aggregate-limit.gltf",
        limits: { maxTriangles: 1 },
      }),
    /exceeds limit 1/u,
  );

  const animated = JSON.parse(gltfFixture()) as GltfFixture;
  animated.animations = [];
  assert.throws(
    () => importGltf(JSON.stringify(animated), { sourceName: "animated.gltf" }),
    /Animated glTF/u,
  );

  const morphed = JSON.parse(gltfFixture()) as GltfFixture;
  morphed.meshes[0]!.primitives[0]!.targets = [];
  assert.throws(
    () => importGltf(JSON.stringify(morphed), { sourceName: "morphed.gltf" }),
    /morph targets are rejected/u,
  );

  for (const componentType of [5126, 5122]) {
    const invalidIndices = JSON.parse(gltfFixture()) as GltfFixture;
    invalidIndices.accessors[1]!.componentType = componentType;
    assert.throws(
      () =>
        importGltf(JSON.stringify(invalidIndices), {
          sourceName: "invalid-indices.gltf",
        }),
      /Unsupported glTF accessor component type/u,
    );
  }
});

test("STEP tessellator output records tolerances, normalizes units, and retains assembly", () => {
  const model = normalizeStepTessellation({
    ...stepTessellationFixture(0.01),
    warnings: ["Generated tessellator warning"],
  });
  assert.ok(Math.abs((model.meshes[0]!.positions[1] ?? 0) + 25.4) < 1e-12);
  assert.deepEqual(model.assembly?.[1]?.transform.slice(12, 15), [50.8, 0, 0]);
  assert.match(model.provenance.notes.join("\n"), /Linear deflection: 0.01/u);
  assert.deepEqual(model.warnings, [
    { code: "unsupported-feature", message: "Generated tessellator warning" },
  ]);
  assert.throws(
    () => normalizeStepTessellation(stepTessellationFixture(0)),
    /positive and explicit/u,
  );
});

test("closed-solid validation blocks open input from occupancy and exact adapters", () => {
  assert.equal(validateClosedOrientedSolid(boxMesh()).valid, true);
  assert.equal(validateClosedOrientedSolid(openBoxMesh()).valid, false);
  assert.equal(
    compareOccupancy(boxMesh(), openBoxMesh(), 1).semantics,
    "indeterminate",
  );
  assert.equal(
    compareValidatedAxisAlignedSolids(boxMesh(), openBoxMesh()).semantics,
    "indeterminate",
  );
});

test("surface distance is explicitly sampled and changes with tessellation", () => {
  const identical = sampledSurfaceDistance(boxMesh(), boxMesh());
  const sensitivity = sampledSurfaceDistance(
    sphereMesh(10, 8, 4),
    sphereMesh(10, 32, 16),
  );
  assert.ok(identical.distanceMillimetres < 1e-12);
  assert.equal(identical.semantics, "approximate");
  assert.ok(Number.isFinite(sensitivity.distanceMillimetres));
  assert.ok(sensitivity.distanceMillimetres > 0.1);
});

test("surface distance rejects empty, non-finite, and degenerate geometry", () => {
  const empty = { positions: new Float64Array(), indices: new Uint32Array() };
  const nonFinite = {
    positions: Float64Array.from([0, 0, 0, 1, 0, 0, 0, Number.NaN, 0]),
    indices: Uint32Array.from([0, 1, 2]),
  };
  const degenerate = {
    positions: Float64Array.from([0, 0, 0, 1, 0, 0, 2, 0, 0]),
    indices: Uint32Array.from([0, 1, 2]),
  };
  assert.throws(() => sampledSurfaceDistance(empty, boxMesh()), /invalid/u);
  assert.throws(() => sampledSurfaceDistance(nonFinite, boxMesh()), /finite/u);
  assert.throws(
    () => sampledSurfaceDistance(degenerate, boxMesh()),
    /degenerate/u,
  );
});

test("voxel occupancy is resolution-sensitive while the narrow solid kernel is exact", () => {
  const first = boxMesh([0, 0, 0], [10, 10, 10]);
  const second = boxMesh([5.4, 0, 0], [15.4, 10, 10]);
  const coarse = compareOccupancy(first, second, 2);
  const fine = compareOccupancy(first, second, 1);
  assert.equal(coarse.semantics, "approximate");
  assert.equal(fine.semantics, "approximate");
  assert.notEqual(
    coarse.semantics === "approximate"
      ? coarse.estimatedDifferenceVolumeCubicMillimetres
      : 0,
    fine.semantics === "approximate"
      ? fine.estimatedDifferenceVolumeCubicMillimetres
      : 0,
  );

  const exact = compareValidatedAxisAlignedSolids(first, second);
  assert.equal(exact.semantics, "exact-for-validated-axis-aligned-boxes");
  if (exact.semantics === "exact-for-validated-axis-aligned-boxes")
    assert.equal(exact.symmetricDifferenceVolumeCubicMillimetres, 1080);
  assert.equal(
    compareValidatedAxisAlignedSolids(
      sphereMesh(10, 8, 4),
      sphereMesh(10, 16, 8),
    ).semantics,
    "indeterminate",
  );
});

test("occupancy refuses work above its sampled-voxel budget", () => {
  assert.deepEqual(
    compareOccupancy(
      boxMesh([0, 0, 0], [10, 10, 10]),
      boxMesh([5.4, 0, 0], [15.4, 10, 10]),
      1,
      100,
    ),
    {
      semantics: "indeterminate",
      reason: "Occupancy requires 2448 samples; budget is 100",
    },
  );
});

test("axis-aligned solid adapter rejects disconnected AABB-corner topology", () => {
  assert.equal(
    validateClosedOrientedSolid(disconnectedCornerTetrahedra()).valid,
    true,
  );
  assert.equal(
    compareValidatedAxisAlignedSolids(
      disconnectedCornerTetrahedra(),
      boxMesh([0, 0, 0], [1, 1, 1]),
    ).semantics,
    "indeterminate",
  );
});

test("hostile counts and malformed indices are rejected", () => {
  assert.throws(
    () =>
      importObj(objFixture(), {
        sourceName: "limited.obj",
        limits: { maxTriangles: 1 },
      }),
    /exceeds limit/u,
  );
  assert.throws(
    () => importObj("v 0 0 0\nv 1 0 0\nf 1 2 3\n", { sourceName: "bad.obj" }),
    /out of range/u,
  );
});

interface GltfFixture {
  meshes: Array<{
    primitives: Array<{ targets?: unknown[] }>;
  }>;
  accessors: Array<{ componentType: number }>;
  animations?: unknown[];
}
