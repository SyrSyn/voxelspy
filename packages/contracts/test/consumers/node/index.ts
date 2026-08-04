import {
  importRequestSchema,
  portableJsonSchema,
  sessionManifestSchema,
} from "@voxelspy/contracts";

export function validateNodeInput(value: unknown): boolean {
  return (
    importRequestSchema.safeParse(value).success ||
    portableJsonSchema.safeParse(value).success ||
    sessionManifestSchema.safeParse(value).success
  );
}
