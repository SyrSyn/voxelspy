import { z } from "zod";

const finiteNumber = z.number().finite();
const safeCount = z.number().int().safe().nonnegative();

export const entityIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]{0,95}$/u)
  .brand<"EntityId">();
export type EntityId = z.infer<typeof entityIdSchema>;

export const requestIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]{0,95}$/u)
  .brand<"RequestId">();
export type RequestId = z.infer<typeof requestIdSchema>;

export const modelIdSchema = entityIdSchema.brand<"ModelId">();
export const meshIdSchema = entityIdSchema.brand<"MeshId">();
export const instanceIdSchema = entityIdSchema.brand<"InstanceId">();
export const nodeIdSchema = entityIdSchema.brand<"NodeId">();
export const methodIdSchema = entityIdSchema.brand<"MethodId">();
export const metricIdSchema = entityIdSchema.brand<"MetricId">();
export const regionIdSchema = entityIdSchema.brand<"RegionId">();
export type ModelId = z.infer<typeof modelIdSchema>;
export type MeshId = z.infer<typeof meshIdSchema>;
export type InstanceId = z.infer<typeof instanceIdSchema>;
export type NodeId = z.infer<typeof nodeIdSchema>;
export type MethodId = z.infer<typeof methodIdSchema>;
export type MetricId = z.infer<typeof metricIdSchema>;
export type RegionId = z.infer<typeof regionIdSchema>;

export const vec2Schema = z.tuple([finiteNumber, finiteNumber]);
export type Vec2 = z.infer<typeof vec2Schema>;

export const vec3Schema = z.tuple([finiteNumber, finiteNumber, finiteNumber]);
export type Vec3 = z.infer<typeof vec3Schema>;

/** Column-major affine matrix applied as p' = M * [x, y, z, 1]. */
export const affineTransformSchema = z
  .tuple([
    finiteNumber,
    finiteNumber,
    finiteNumber,
    finiteNumber,
    finiteNumber,
    finiteNumber,
    finiteNumber,
    finiteNumber,
    finiteNumber,
    finiteNumber,
    finiteNumber,
    finiteNumber,
    finiteNumber,
    finiteNumber,
    finiteNumber,
    finiteNumber,
  ])
  .superRefine((matrix, context) => {
    const affine =
      matrix[3] === 0 &&
      matrix[7] === 0 &&
      matrix[11] === 0 &&
      matrix[15] === 1;
    if (!affine) {
      context.addIssue({ code: "custom", message: "Matrix must be affine" });
    }

    const columns = linearColumns(matrix);
    const lengths = columns.map((column) => Math.hypot(...column));
    const normalized = columns.map((column, index) =>
      column.map((value) => value / lengths[index]!),
    ) as [Vec3, Vec3, Vec3];
    const normalizedDeterminant = lengths.every(
      (length) => Number.isFinite(length) && length > 0,
    )
      ? dot(normalized[0], [
          normalized[1][1] * normalized[2][2] -
            normalized[1][2] * normalized[2][1],
          normalized[1][2] * normalized[2][0] -
            normalized[1][0] * normalized[2][2],
          normalized[1][0] * normalized[2][1] -
            normalized[1][1] * normalized[2][0],
        ])
      : 0;
    if (
      !Number.isFinite(normalizedDeterminant) ||
      Math.abs(normalizedDeterminant) <= Number.EPSILON * 64
    ) {
      context.addIssue({
        code: "custom",
        message: "Matrix must be invertible",
      });
    }
  });
export type Mat4 = z.infer<typeof affineTransformSchema>;

function linearColumns(matrix: readonly number[]): [Vec3, Vec3, Vec3] {
  return [
    [matrix[0] ?? 0, matrix[1] ?? 0, matrix[2] ?? 0],
    [matrix[4] ?? 0, matrix[5] ?? 0, matrix[6] ?? 0],
    [matrix[8] ?? 0, matrix[9] ?? 0, matrix[10] ?? 0],
  ];
}

function dot(left: Vec3, right: Vec3): number {
  return left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
}

export const sourceNormalizationTransformSchema = affineTransformSchema
  .superRefine((matrix, context) => {
    const [x, y, zAxis] = linearColumns(matrix);
    const lengths = [Math.hypot(...x), Math.hypot(...y), Math.hypot(...zAxis)];
    const scale = Math.max(...lengths);
    const tolerance = Math.max(scale * 1e-10, 1e-12);
    if (
      scale <= 0 ||
      lengths.some((length) => Math.abs(length - scale) > tolerance) ||
      Math.abs(dot(x, y)) > tolerance * scale ||
      Math.abs(dot(x, zAxis)) > tolerance * scale ||
      Math.abs(dot(y, zAxis)) > tolerance * scale
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Source normalization must be a proper uniform-scale transform",
      });
    }
    const determinant = dot(x, [
      y[1] * zAxis[2] - y[2] * zAxis[1],
      y[2] * zAxis[0] - y[0] * zAxis[2],
      y[0] * zAxis[1] - y[1] * zAxis[0],
    ]);
    if (determinant <= 0)
      context.addIssue({
        code: "custom",
        message: "Source normalization must preserve handedness",
      });
    if (matrix[12] !== 0 || matrix[13] !== 0 || matrix[14] !== 0) {
      context.addIssue({
        code: "custom",
        message: "Source normalization cannot translate or recenter geometry",
      });
    }
  })
  .brand<"SourceNormalizationTransform">();

export const rigidTransformSchema = affineTransformSchema
  .superRefine((matrix, context) => {
    const [x, y, zAxis] = linearColumns(matrix);
    const tolerance = 1e-10;
    if (
      [x, y, zAxis].some(
        (axis) => Math.abs(Math.hypot(...axis) - 1) > tolerance,
      ) ||
      Math.abs(dot(x, y)) > tolerance ||
      Math.abs(dot(x, zAxis)) > tolerance ||
      Math.abs(dot(y, zAxis)) > tolerance ||
      Math.abs(
        dot(x, [
          y[1] * zAxis[2] - y[2] * zAxis[1],
          y[2] * zAxis[0] - y[0] * zAxis[2],
          y[0] * zAxis[1] - y[1] * zAxis[0],
        ]) - 1,
      ) > tolerance
    ) {
      context.addIssue({
        code: "custom",
        message: "Transform must be a proper rigid transform",
      });
    }
  })
  .brand<"RigidTransform">();

export type AffineTransform = z.infer<typeof affineTransformSchema>;
export type SourceNormalizationTransform = z.infer<
  typeof sourceNormalizationTransformSchema
>;
export type RigidTransform = z.infer<typeof rigidTransformSchema>;

export const IDENTITY_MAT4: Mat4 = [
  1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
];

export const planeSchema = z
  .strictObject({
    frame: z.union([
      z.strictObject({ kind: z.literal("comparison") }),
      z.strictObject({ kind: z.literal("model"), modelId: modelIdSchema }),
    ]),
    normal: vec3Schema,
    constantMillimetres: finiteNumber,
  })
  .superRefine(({ normal }, context) => {
    const length = Math.hypot(...normal);
    if (Math.abs(length - 1) > 1e-9) {
      context.addIssue({
        code: "custom",
        path: ["normal"],
        message: "Plane normal must be unit length",
      });
    }
  });
export type Plane = z.infer<typeof planeSchema>;

export const sourceUnitSchema = z.enum([
  "unknown",
  "micrometre",
  "millimetre",
  "centimetre",
  "metre",
  "inch",
  "foot",
]);
export type SourceUnit = z.infer<typeof sourceUnitSchema>;
export const resolvedSourceUnitSchema = sourceUnitSchema.exclude(["unknown"]);

export const sourceAxisSchema = z.enum([
  "unknown",
  "right-handed-z-up",
  "right-handed-y-up",
]);
export type SourceAxis = z.infer<typeof sourceAxisSchema>;
export const resolvedSourceAxisSchema = sourceAxisSchema.exclude(["unknown"]);

export const canonicalFrameSchema = z.strictObject({
  unit: z.literal("millimetre"),
  coordinateSystem: z.literal("right-handed-z-up"),
});
export type CanonicalFrame = z.infer<typeof canonicalFrameSchema>;

export const CANONICAL_FRAME: CanonicalFrame = {
  unit: "millimetre",
  coordinateSystem: "right-handed-z-up",
};

export const sha256DigestSchema = z.strictObject({
  algorithm: z.literal("sha256"),
  value: z.string().regex(/^[a-f0-9]{64}$/u),
});
export type Sha256Digest = z.infer<typeof sha256DigestSchema>;

export type PortableJsonValue =
  | null
  | boolean
  | number
  | string
  | PortableJsonValue[]
  | { [key: string]: PortableJsonValue };

const forbiddenRecordKeys = new Set(["__proto__", "prototype", "constructor"]);

export const PORTABLE_JSON_LIMITS = {
  maxDepth: 128,
  maxNodes: 100_000,
  maxStringLength: 1_000_000,
  maxObjectKeys: 10_000,
  maxArrayLength: 100_000,
  maxKeyLength: 1_024,
} as const;

function inspectPortableJson(value: unknown): value is PortableJsonValue {
  const active = new WeakSet<object>();
  const stack: Array<
    | { kind: "enter"; value: unknown; depth: number }
    | { kind: "exit"; value: object }
  > = [{ kind: "enter", value, depth: 0 }];
  let nodes = 0;
  try {
    while (stack.length > 0) {
      const item = stack.pop();
      if (!item) return false;
      if (item.kind === "exit") {
        active.delete(item.value);
        continue;
      }
      nodes += 1;
      if (
        nodes > PORTABLE_JSON_LIMITS.maxNodes ||
        item.depth > PORTABLE_JSON_LIMITS.maxDepth
      )
        return false;
      const current = item.value;
      if (current === null || typeof current === "boolean") continue;
      if (typeof current === "number") {
        if (
          !Number.isFinite(current) ||
          Object.is(current, -0) ||
          (Number.isInteger(current) && !Number.isSafeInteger(current))
        )
          return false;
        continue;
      }
      if (typeof current === "string") {
        if (current.length > PORTABLE_JSON_LIMITS.maxStringLength) return false;
        for (let index = 0; index < current.length; index += 1) {
          const unit = current.charCodeAt(index);
          if (unit >= 0xd800 && unit <= 0xdbff) {
            const next = current.charCodeAt(index + 1);
            if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
            index += 1;
          } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
        }
        continue;
      }
      if (typeof current !== "object" || active.has(current)) return false;
      active.add(current);
      stack.push({ kind: "exit", value: current });

      if (Array.isArray(current)) {
        if (
          Object.getPrototypeOf(current) !== Array.prototype ||
          current.length > PORTABLE_JSON_LIMITS.maxArrayLength
        )
          return false;
        for (const key of Reflect.ownKeys(current)) {
          if (key === "length") continue;
          if (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/u.test(key))
            return false;
          const index = Number(key);
          if (
            !Number.isSafeInteger(index) ||
            index < 0 ||
            index >= current.length ||
            String(index) !== key
          )
            return false;
          const descriptor = Object.getOwnPropertyDescriptor(current, key);
          if (!descriptor?.enumerable || !("value" in descriptor)) return false;
        }
        for (let index = current.length - 1; index >= 0; index -= 1) {
          if (!Object.hasOwn(current, index)) return false;
          stack.push({
            kind: "enter",
            value: current[index],
            depth: item.depth + 1,
          });
        }
        continue;
      }

      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) return false;
      if (Object.getOwnPropertySymbols(current).length > 0) return false;
      const descriptors = Object.entries(
        Object.getOwnPropertyDescriptors(current),
      );
      if (descriptors.length > PORTABLE_JSON_LIMITS.maxObjectKeys) return false;
      for (let index = descriptors.length - 1; index >= 0; index -= 1) {
        const entry = descriptors[index];
        if (!entry) return false;
        const [key, descriptor] = entry;
        if (
          key.length > PORTABLE_JSON_LIMITS.maxKeyLength ||
          forbiddenRecordKeys.has(key) ||
          !descriptor.enumerable ||
          !("value" in descriptor)
        )
          return false;
        stack.push({
          kind: "enter",
          value: descriptor.value,
          depth: item.depth + 1,
        });
      }
    }
    return true;
  } catch {
    return false;
  }
}

export function isPortableJson(value: unknown): value is PortableJsonValue {
  return inspectPortableJson(value);
}

export function assertPortableJson(
  value: unknown,
): asserts value is PortableJsonValue {
  if (!isPortableJson(value)) throw new TypeError("Value is not portable JSON");
}

export const portableJsonSchema = z.custom<PortableJsonValue>(isPortableJson, {
  message: "Expected portable JSON",
});

export const portableJsonObjectSchema = z.custom<
  Record<string, PortableJsonValue>
>(
  (value) =>
    isPortableJson(value) &&
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value),
  { message: "Expected a portable JSON object" },
);

export const boundedCountSchema = safeCount;
