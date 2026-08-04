import {
  importRequestSchema,
  portableJsonSchema,
  sessionManifestSchema,
  validateWorkerProtocolTrace,
} from "@voxelspy/contracts";

export function validateNodeInput(value: unknown): boolean {
  return (
    importRequestSchema.safeParse(value).success ||
    portableJsonSchema.safeParse(value).success ||
    sessionManifestSchema.safeParse(value).success
  );
}

export function validateNodeWorkerTrace(values: readonly unknown[]): boolean {
  return validateWorkerProtocolTrace(values).valid;
}
