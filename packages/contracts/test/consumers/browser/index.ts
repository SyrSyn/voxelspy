import {
  analysisRequestSchema,
  normalizedModelSchema,
  reportSchema,
} from "@voxelspy/contracts";

export function validateBrowserInput(value: unknown): boolean {
  return (
    analysisRequestSchema.safeParse(value).success ||
    normalizedModelSchema.safeParse(value).success ||
    reportSchema.safeParse(value).success
  );
}
