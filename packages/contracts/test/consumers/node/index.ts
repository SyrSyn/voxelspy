import {
  evaluateRelease,
  importRequestSchema,
  portableJsonSchema,
  sessionManifestSchema,
  validateWorkerProtocolTrace,
} from "@voxelspy/contracts";

export function validateNodeInput(value: unknown): boolean {
  const releaseEvaluation = evaluateRelease(value);
  return (
    importRequestSchema.safeParse(value).success ||
    portableJsonSchema.safeParse(value).success ||
    sessionManifestSchema.safeParse(value).success ||
    releaseEvaluation.status === "pass"
  );
}

export function validateNodeWorkerTrace(values: readonly unknown[]): boolean {
  return validateWorkerProtocolTrace(values).valid;
}
