import { entityIdSchema } from "@voxelspy/contracts";
import { adapterReferenceSchema } from "@voxelspy/contracts/adapter-evidence";
import { toleranceSchema } from "@voxelspy/contracts/analysis";
import { warningSchema } from "@voxelspy/contracts/geometry";
import { importLimitsSchema } from "@voxelspy/contracts/import";
import { vec3Schema } from "@voxelspy/contracts/primitives";
import { canonicalInstantSchema } from "@voxelspy/contracts/report";
import { sessionResourceVerificationSchema } from "@voxelspy/contracts/session";
import { workerReadyMessageSchema } from "@voxelspy/contracts/worker";

const digest = { algorithm: "sha256", value: "b".repeat(64) };
export const browserContractCheck = [
  entityIdSchema.safeParse("consumer.browser"),
  vec3Schema.safeParse([1, 2, 3]),
  warningSchema.safeParse({
    code: "consumer.browser-warning",
    severity: "warning",
    message: "Browser consumer warning",
  }),
  importLimitsSchema.safeParse({ inputBytes: 1, triangleCount: 1 }),
  toleranceSchema.safeParse({ angularRadians: 0.01 }),
  adapterReferenceSchema.safeParse({ id: "consumer.browser", version: "1" }),
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
].every((result) => result.success);

if (!browserContractCheck)
  throw new Error("Browser bundle could not exercise every contract family");
