import { importRequestSchema, portableJsonSchema } from "@voxelspy/contracts";

export function validateNodeInput(value: unknown): boolean {
  return (
    importRequestSchema.safeParse(value).success ||
    portableJsonSchema.safeParse(value).success
  );
}
