/** Text-shaping helpers shared by report construction. Pure, deterministic, no locale dependence. */

/**
 * Truncates to at most `maxLength` UTF-16 code units, appending an ellipsis
 * when truncation actually happens, and never splitting a surrogate pair.
 * Used to keep user-controlled or generated text (model source names,
 * finding summaries, review notes) within the contract's bounded-text
 * limits without throwing away all of it.
 */
export function truncateSafeText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  const ellipsis = "...";
  const budget = Math.max(0, maxLength - ellipsis.length);
  let sliceEnd = budget;
  if (sliceEnd > 0) {
    const code = value.charCodeAt(sliceEnd - 1);
    if (code >= 0xd800 && code <= 0xdbff) sliceEnd -= 1;
  }
  return `${value.slice(0, sliceEnd)}${ellipsis}`;
}

/** Fixed-point, locale-independent number formatting for report text. */
export function formatNumber(value: number, digits = 3): string {
  return Number.isFinite(value) ? value.toFixed(digits) : String(value);
}
