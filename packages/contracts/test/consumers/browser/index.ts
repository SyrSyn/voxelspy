import {
  analysisRequestSchema,
  normalizedModelSchema,
} from "@voxelspy/contracts";

export function validateBrowserInput(value: unknown): boolean {
  return (
    analysisRequestSchema.safeParse(value).success ||
    normalizedModelSchema.safeParse(value).success
  );
}
