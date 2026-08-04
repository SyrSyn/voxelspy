import { entityIdSchema } from "@voxelspy/contracts";
import { adapterReferenceSchema } from "@voxelspy/contracts/adapter-evidence";
import { toleranceSchema } from "@voxelspy/contracts/analysis";
import { warningSchema } from "@voxelspy/contracts/geometry";
import { importLimitsSchema } from "@voxelspy/contracts/import";
import { vec3Schema } from "@voxelspy/contracts/primitives";
import { canonicalInstantSchema } from "@voxelspy/contracts/report";
import { sessionResourceVerificationSchema } from "@voxelspy/contracts/session";
import { workerReadyMessageSchema } from "@voxelspy/contracts/worker";

const digest = { algorithm: "sha256", value: "a".repeat(64) };
const checks = [
  entityIdSchema.safeParse("consumer.root"),
  vec3Schema.safeParse([0, 0, 0]),
  warningSchema.safeParse({
    code: "consumer.warning",
    severity: "info",
    message: "Consumer warning",
  }),
  importLimitsSchema.safeParse({ inputBytes: 1, triangleCount: 1 }),
  toleranceSchema.safeParse({ distanceMillimetres: 0.01 }),
  adapterReferenceSchema.safeParse({ id: "consumer.adapter", version: "1" }),
  canonicalInstantSchema.safeParse("2026-01-02T03:04:05.000Z"),
  sessionResourceVerificationSchema.safeParse({
    path: "report.json",
    bytes: 1,
    digest,
  }),
  workerReadyMessageSchema.safeParse({
    protocolVersion: 1,
    type: "ready",
    transport: "array-buffer-transfer",
    operations: ["import", "analysis"],
    maxActiveOperations: 1,
  }),
];

if (checks.some((result) => !result.success))
  throw new Error(
    "Installed Node consumer could not exercise every contract family",
  );

for (const privatePath of [
  "@voxelspy/contracts/src/primitives.js",
  "@voxelspy/contracts/dist/primitives.js",
]) {
  try {
    await import(privatePath);
    throw new Error(
      `Private package path unexpectedly resolved: ${privatePath}`,
    );
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith("Private package path")
    )
      throw error;
    if (
      !(error instanceof Error) ||
      !["ERR_PACKAGE_PATH_NOT_EXPORTED", "ERR_MODULE_NOT_FOUND"].includes(
        error.code,
      )
    )
      throw error;
  }
}

console.log("installed-node-consumer:ok");
