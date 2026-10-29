import { geometryProvenanceSchema } from "@voxelspy/contracts/geometry";

/** JSON object key order is not part of a recorded source binding.
 * Validate both complete values and retain array order and every scalar. */
export function hostedProvenanceMatches(
  left: unknown,
  right: unknown,
): boolean {
  const a = geometryProvenanceSchema.safeParse(left);
  const b = geometryProvenanceSchema.safeParse(right);
  if (!a.success || !b.success) return false;
  const canonical = (value: unknown) =>
    JSON.stringify(value, (_key, item: unknown) =>
      item !== null && typeof item === "object" && !Array.isArray(item)
        ? Object.fromEntries(
            Object.entries(item).sort(([a], [b]) =>
              a < b ? -1 : a > b ? 1 : 0,
            ),
          )
        : item,
    );
  return canonical(a.data) === canonical(b.data);
}
