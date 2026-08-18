/**
 * Deterministic identifier helpers for report construction.
 *
 * Report entity IDs (`EntityId` and its brands in
 * `@voxelspy/contracts`) must match `^[a-z0-9][a-z0-9._-]{0,95}$`. The
 * report engine derives its own IDs from already-validated upstream IDs
 * (region IDs, request IDs, ...) and short lowercase literals, so the
 * happy path is a plain "." join. `boundedEntityId` also bounds the
 * result to the 96-character contract ceiling without wall-clock time or
 * randomness, so the same inputs always produce the same ID.
 */

/** FNV-1a, 32-bit. Small, synchronous, dependency-free, and deterministic. */
function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

const MAX_ENTITY_ID_LENGTH = 96;

export function boundedEntityId(...parts: readonly string[]): string {
  const joined = parts.filter((part) => part.length > 0).join(".");
  if (joined.length <= MAX_ENTITY_ID_LENGTH) return joined;
  const suffix = `.${fnv1a32(joined).toString(16).padStart(8, "0")}`;
  return `${joined.slice(0, MAX_ENTITY_ID_LENGTH - suffix.length)}${suffix}`;
}

/**
 * Casts a value already known (by construction, via `boundedEntityId` or a
 * fixed literal) to satisfy an entity-ID pattern into its branded contract
 * type. The final `reportSchema.parse` call in `buildComparisonReport` is
 * the actual authority: if the cast value does not really conform, that
 * parse fails closed with a typed `ReportBuildError` rather than silently
 * accepting a malformed document.
 */
export function brandId<T extends string>(value: string): T {
  return value as T;
}
