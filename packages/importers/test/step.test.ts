import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { importModel } from "../src/index.js";
import { detectStepSourceUnit, type StepRuntime } from "../src/step.js";
import { createNodeStepRuntime } from "../src/step-runtime-node.js";
import { cuboidStep } from "./fixtures/step.fixture.js";

const encoder = new TextEncoder();
const req = (source = cuboidStep(), options: Record<string, unknown> = {}) => ({
  contractVersion: 1,
  targetModelId: "model.step-test",
  format: "step",
  sourceName: "original-cuboid.step",
  bytes: encoder.encode(source),
  options: {
    declaredAxis: "right-handed-z-up",
    limits: { inputBytes: 32 * 1024 * 1024, triangleCount: 500_000 },
    ...options,
  },
});
const require = createRequire(import.meta.url);
let native: Promise<StepRuntime> | undefined;
function runtime(): Promise<StepRuntime> {
  return (native ??= createNodeStepRuntime({
    wasmBinary: new Uint8Array(
      readFileSync(require.resolve("occt-import-js/dist/occt-import-js.wasm")),
    ),
  }));
}

describe("STEP native-WASM import", () => {
  it("detects original context units and imports an original offset cuboid with independent dimensions", async () => {
    const source = cuboidStep();
    expect(detectStepSourceUnit(encoder.encode(source))).toBe("millimetre");
    const result = await importModel(req(source), {
      stepRuntime: await runtime(),
    });
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error(result.message);
    const mesh = result.model.meshes[0]!.geometry;
    expect(mesh.positions).toBeInstanceOf(Float64Array);
    expect(mesh.indices.length / 3).toBe(12);
    for (let axis = 0; axis < 3; axis++) {
      const values = [...mesh.positions].filter(
        (_, index) => index % 3 === axis,
      );
      expect(Math.min(...values)).toBe([5, 7, 11][axis]);
      expect(Math.max(...values)).toBe([15, 27, 41][axis]);
    }
    expect(result.model.provenance).toMatchObject({
      detectedSourceUnit: "millimetre",
      detectedSourceAxis: "unknown",
      sourceResolution: { unit: "embedded", axis: "declared" },
      tessellation: {
        adapterId: "occt-import-js",
        adapterVersion: "0.0.23",
        parameters: { occtVersion: "7.6.1", linearDeflectionMillimetres: 0.1 },
      },
    });
  }, 30_000);
  it.each(["metre", "inch"] as const)(
    "keeps %s source units explicit while recording native output settings",
    async (unit) => {
      const source = cuboidStep({ unit });
      expect(detectStepSourceUnit(encoder.encode(source))).toBe(unit);
      const result = await importModel(req(source), {
        stepRuntime: await runtime(),
      });
      expect(result).toMatchObject({ ok: true });
      if (!result.ok) throw new Error(result.message);
      expect(result.model.provenance.detectedSourceUnit).toBe(unit);
      expect(result.model.provenance.sourceUnit).toBe(unit);
      const positions = result.model.meshes[0]!.geometry.positions;
      expect(
        Math.min(...[...positions].filter((_, i) => i % 3 === 0)),
      ).toBeCloseTo(5, 10);
      expect(
        Math.max(...[...positions].filter((_, i) => i % 3 === 0)),
      ).toBeCloseTo(15, 10);
      expect(result.model.provenance.appliedSourceToModel[0]).toBe(
        unit === "metre" ? 1000 : 25.4,
      );
    },
    30_000,
  );
  it("rejects missing runtime, unknown axis, malformed native geometry and excessive returned triangles", async () => {
    expect(await importModel(req())).toMatchObject({
      ok: false,
      code: "unsupported-input",
    });
    const unresolved = req();
    delete (unresolved.options as Record<string, unknown>).declaredAxis;
    expect(
      await importModel(unresolved, { stepRuntime: await runtime() }),
    ).toMatchObject({ ok: false, code: "needs-input" });
    expect(
      await importModel(
        req(cuboidStep(), {
          limits: { inputBytes: 32 * 1024 * 1024, triangleCount: 1 },
        }),
        { stepRuntime: await runtime() },
      ),
    ).toMatchObject({ ok: false, code: "resource-limit" });
    expect(
      await importModel(
        req(cuboidStep().replace(/FACETED_BREP\(/u, "MALFORMED_BREP(")),
        { stepRuntime: await runtime() },
      ),
    ).toMatchObject({ ok: false });
  }, 30_000);
});

describe("STEP preflight and trusted runtime boundary", () => {
  const geometry = () => ({
    success: true,
    root: { name: "root", meshes: [0], children: [] },
    meshes: [
      {
        name: "triangle",
        attributes: { position: { array: [5, 7, 11, 15, 7, 11, 5, 27, 11] } },
        index: { array: [0, 1, 2] },
      },
    ],
  });
  const injected = (read: StepRuntime["readStepFile"]): StepRuntime => ({
    version: "0.0.23",
    occtVersion: "7.6.1",
    readStepFile: read,
  });
  it("refuses external references before calling native code and ignores quoted fake-unit text", async () => {
    let calls = 0;
    const stepRuntime = injected(() => {
      calls++;
      return geometry();
    });
    for (const entity of [
      "EXTERNAL_SOURCE('private.step')",
      "external_source('private.step')",
      "DOCUMENT_FILE('','','',#1)",
      "PRODUCT_DEFINITION_REFERENCE('','','',#1)",
    ]) {
      const source = cuboidStep().replace(
        "ENDSEC;\nEND-ISO-10303-21;",
        `#9000=${entity};\nENDSEC;\nEND-ISO-10303-21;`,
      );
      expect(await importModel(req(source), { stepRuntime })).toMatchObject({
        ok: false,
        code: "unsupported-input",
      });
    }
    expect(calls).toBe(0);
    const fake = cuboidStep().replace(
      "Original procedural cuboid",
      "EXTERNAL_SOURCE GLOBAL_UNIT_ASSIGNED_CONTEXT((#9000))",
    );
    expect(detectStepSourceUnit(encoder.encode(fake))).toBe("millimetre");
    const comment = cuboidStep().replace(
      "DATA;",
      "DATA;/* EXTERNAL_SOURCE('file.step'); #9000=GLOBAL_UNIT_ASSIGNED_CONTEXT((#1)); */",
    );
    expect(detectStepSourceUnit(encoder.encode(comment))).toBe("millimetre");
  });
  it("detects supported SI prefix/foot units exactly and refuses unknown, missing, mixed or cyclic units", () => {
    const source = cuboidStep();
    for (const [prefix, unit] of [
      [".CENTI.", "centimetre"],
      [".MICRO.", "micrometre"],
    ])
      expect(
        detectStepSourceUnit(
          encoder.encode(source.replace(".MILLI.", prefix!)),
        ),
      ).toBe(unit);
    expect(
      detectStepSourceUnit(
        encoder.encode(
          cuboidStep({ unit: "inch" })
            .replace("'INCH'", "'FOOT'")
            .replace("LENGTH_MEASURE(25.4)", "LENGTH_MEASURE(304.8)"),
        ),
      ),
    ).toBe("foot");
    expect(() =>
      detectStepSourceUnit(encoder.encode(source.replace(".MILLI.", ".KILO."))),
    ).toThrow();
    expect(() =>
      detectStepSourceUnit(
        encoder.encode(
          source.replace(
            "GLOBAL_UNIT_ASSIGNED_CONTEXT",
            "UNSUPPORTED_UNIT_CONTEXT",
          ),
        ),
      ),
    ).toThrow();
    const mixed = source.replace(
      "ENDSEC;\nEND-ISO-10303-21;",
      "#9000=(LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT($,.METRE.));\n#9001=GLOBAL_UNIT_ASSIGNED_CONTEXT((#9000));\nENDSEC;\nEND-ISO-10303-21;",
    );
    expect(() => detectStepSourceUnit(encoder.encode(mixed))).toThrow(/mixed/u);
    const cyclic = cuboidStep({ unit: "inch" }).replace(
      /LENGTH_MEASURE_WITH_UNIT\(LENGTH_MEASURE\(25\.4\),#[0-9]+\)/u,
      "LENGTH_MEASURE_WITH_UNIT(LENGTH_MEASURE(25.4),#11)",
    );
    expect(() => detectStepSourceUnit(encoder.encode(cyclic))).toThrow();
  });
  it("applies user reinterpretation after native-unit recovery and requires no kernel guess", async () => {
    let passed: unknown;
    const stepRuntime = injected((_, parameters) => {
      passed = parameters;
      return geometry();
    });
    const result = await importModel(
      req(cuboidStep({ unit: "inch" }), {
        userUnit: "millimetre",
        userAxis: "right-handed-y-up",
        declaredAxis: undefined,
      }),
      { stepRuntime },
    );
    expect(result).toMatchObject({
      ok: true,
      model: {
        provenance: {
          detectedSourceUnit: "inch",
          sourceUnit: "millimetre",
          sourceAxis: "right-handed-y-up",
          sourceResolution: { unit: "user", axis: "user" },
        },
      },
    });
    expect(passed).toMatchObject({
      linearUnit: "inch",
      linearDeflectionType: "absolute_value",
      linearDeflection: 0.1 / 25.4,
    });
  });
  it("rejects excessive input before runtime invocation, malformed returned geometry and missing hierarchy coverage", async () => {
    let calls = 0;
    const stepRuntime = injected(() => {
      calls++;
      return geometry();
    });
    const oversized = req();
    oversized.bytes = new Uint8Array(32 * 1024 * 1024 + 1);
    oversized.options.limits.inputBytes = oversized.bytes.byteLength;
    expect(await importModel(oversized, { stepRuntime })).toMatchObject({
      ok: false,
      code: "resource-limit",
    });
    expect(calls).toBe(0);
    const bad = geometry();
    bad.meshes[0]!.index.array = [0, 1, 3];
    expect(
      await importModel(req(), { stepRuntime: injected(() => bad) }),
    ).toMatchObject({ ok: false, code: "invalid-input" });
    const sparse = geometry();
    sparse.meshes[0]!.index.array = Array(3);
    expect(
      await importModel(req(), { stepRuntime: injected(() => sparse) }),
    ).toMatchObject({ ok: false, code: "invalid-input" });
    const missing = geometry();
    missing.root.meshes = [];
    expect(
      await importModel(req(), { stepRuntime: injected(() => missing) }),
    ).toMatchObject({ ok: false, code: "invalid-input" });
    const enormous = geometry();
    enormous.meshes[0]!.attributes.position.array.length = 4_500_003;
    expect(
      await importModel(req(), { stepRuntime: injected(() => enormous) }),
    ).toMatchObject({ ok: false, code: "resource-limit" });
  });
  it("refuses wrong runtime/WASM versions and maps worker timeouts to resource-limit", async () => {
    const { StepRuntimeResourceLimitError } = await import("../src/step.js");
    expect(
      await importModel(req(), {
        stepRuntime: injected(() => {
          throw new StepRuntimeResourceLimitError(
            "STEP worker exceeded its time limit.",
          );
        }),
      }),
    ).toMatchObject({ ok: false, code: "resource-limit" });
    await expect(
      createNodeStepRuntime({ wasmBinary: Uint8Array.of(0, 1, 2) }),
    ).rejects.toThrow(/WASM/u);
    const wrong = {
      ...injected(() => geometry()),
      version: "0.0.24",
    } as unknown as StepRuntime;
    expect(await importModel(req(), { stepRuntime: wrong })).toMatchObject({
      ok: false,
      code: "unsupported-input",
    });
  });
  it("preserves valid deterministic hierarchy paths and arbitrary target identifiers", async () => {
    const output = geometry();
    output.root = {
      name: "assembly",
      meshes: [],
      children: [{ name: "part", meshes: [0], children: [] }],
    } as unknown as typeof output.root;
    const input = req();
    input.targetModelId = "node.step.0";
    const first = await importModel(input, {
      stepRuntime: injected(() => output),
    });
    expect(first).toMatchObject({ ok: true });
    expect(
      await importModel(input, { stepRuntime: injected(() => output) }),
    ).toEqual(first);
    expect([...input.bytes]).toEqual([...encoder.encode(cuboidStep())]);
  });
});
