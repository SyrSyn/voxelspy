import { describe, expect, it } from "vitest";
import {
  IDENTITY_MAT4,
  PORTABLE_JSON_LIMITS,
  affineTransformSchema,
  assertPortableJson,
  entityIdSchema,
  planeSchema,
  portableJsonSchema,
  requestIdSchema,
  rigidTransformSchema,
  sha256DigestSchema,
  sourceNormalizationTransformSchema,
  vec3Schema,
} from "../src/primitives.js";

describe("contract primitives", () => {
  it("accepts bounded opaque IDs and separates persisted and request brands", () => {
    expect(entityIdSchema.parse("model.baseline-1")).toBe("model.baseline-1");
    expect(requestIdSchema.parse("job_1")).toBe("job_1");
    expect(() => entityIdSchema.parse("Upper Case")).toThrow();
    expect(() => entityIdSchema.parse(`a${"b".repeat(96)}`)).toThrow();
  });

  it("executes the documented column-major transform conventions", () => {
    const sourceToModel = [
      25.4, 0, 0, 0, 0, 0, 25.4, 0, 0, -25.4, 0, 0, 0, 0, 0, 1,
    ];
    expect(sourceNormalizationTransformSchema.parse(sourceToModel)).toEqual(
      sourceToModel,
    );
    expect(() =>
      sourceNormalizationTransformSchema.parse([
        1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 1,
      ]),
    ).toThrow();
    const point = [1, 2, 3];
    const transformed = [
      sourceToModel[0]! * point[0]! +
        sourceToModel[4]! * point[1]! +
        sourceToModel[8]! * point[2]! +
        sourceToModel[12]!,
      sourceToModel[1]! * point[0]! +
        sourceToModel[5]! * point[1]! +
        sourceToModel[9]! * point[2]! +
        sourceToModel[13]!,
      sourceToModel[2]! * point[0]! +
        sourceToModel[6]! * point[1]! +
        sourceToModel[10]! * point[2]! +
        sourceToModel[14]!,
    ];
    expect(transformed[0]).toBeCloseTo(25.4);
    expect(transformed[1]).toBeCloseTo(-76.2);
    expect(transformed[2]).toBeCloseTo(50.8);

    expect(
      affineTransformSchema.parse([
        1e9, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
      ]),
    ).toBeTruthy();

    expect(rigidTransformSchema.parse(IDENTITY_MAT4)).toEqual(IDENTITY_MAT4);
    expect(() =>
      rigidTransformSchema.parse([
        2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1,
      ]),
    ).toThrow();
    expect(() =>
      affineTransformSchema.parse([
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1,
      ]),
    ).toThrow();
    expect(() =>
      affineTransformSchema.parse([
        ...IDENTITY_MAT4.slice(0, 3),
        1,
        ...IDENTITY_MAT4.slice(4),
      ]),
    ).toThrow();
  });

  it("enforces n dot p + c = 0 planes and a typed digest", () => {
    const plane = planeSchema.parse({
      frame: { kind: "comparison" },
      normal: [0, 0, 1],
      constantMillimetres: -4,
    });
    expect(plane.normal[2] * 4 + plane.constantMillimetres).toBe(0);
    expect(plane.normal[2] * 5 + plane.constantMillimetres).toBe(1);
    expect(() =>
      planeSchema.parse({
        frame: { kind: "comparison" },
        normal: [0, 0, 2],
        constantMillimetres: 0,
      }),
    ).toThrow();
    expect(
      sha256DigestSchema.parse({ algorithm: "sha256", value: "a".repeat(64) }),
    ).toBeTruthy();
    expect(() =>
      sha256DigestSchema.parse({ algorithm: "sha256", value: "A".repeat(64) }),
    ).toThrow();
    expect(() => vec3Schema.parse([1, Number.NaN, 3])).toThrow();
  });

  it("accepts only bounded strict portable JSON values", () => {
    const repeated = { value: 1 };
    expect(
      portableJsonSchema.parse({ b: [true, null], a: repeated, c: repeated }),
    ).toBeTruthy();
    for (const value of [
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
      -0,
      new Float64Array([1]),
      new Date(),
      "\ud800",
    ]) {
      expect(() => portableJsonSchema.parse(value)).toThrow();
    }
    expect(() => portableJsonSchema.parse([, 1])).toThrow();
    const exoticArray = [1];
    Object.defineProperty(exoticArray, "4294967295", {
      enumerable: true,
      value: { hidden: Number.NaN },
    });
    expect(() => portableJsonSchema.parse(exoticArray)).toThrow();
    expect(() =>
      portableJsonSchema.parse(
        Object.defineProperty({}, "value", { get: () => 1 }),
      ),
    ).toThrow();
    expect(() =>
      portableJsonSchema.parse(
        Object.assign(Object.create(null), { constructor: 1 }),
      ),
    ).toThrow();

    const tooDeep: Record<string, unknown> = {};
    let cursor = tooDeep;
    for (let depth = 0; depth <= PORTABLE_JSON_LIMITS.maxDepth; depth += 1) {
      const next: Record<string, unknown> = {};
      cursor.next = next;
      cursor = next;
    }
    expect(portableJsonSchema.safeParse(tooDeep).success).toBe(false);
    expect(
      portableJsonSchema.safeParse(
        "a".repeat(PORTABLE_JSON_LIMITS.maxStringLength),
      ).success,
    ).toBe(true);
    expect(
      portableJsonSchema.safeParse(
        "a".repeat(PORTABLE_JSON_LIMITS.maxStringLength + 1),
      ).success,
    ).toBe(false);

    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() => assertPortableJson(cyclic)).toThrow(TypeError);
  });
});
