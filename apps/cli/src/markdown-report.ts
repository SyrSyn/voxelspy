import { writeFileSync } from "node:fs";
import type { PolicyCheck } from "./policy.js";

/**
 * A compact Markdown summary for `--markdown`, meant to be posted verbatim
 * as a CI bot's pull-request comment (or attached as a job summary): what
 * was compared, the verdict, the key numbers, and -- always -- the
 * approximate-ness caveats. It states plainly whenever a result is sampled
 * rather than exact, and never lets a policy pass read as unconditional
 * geometric proof: `caveats` is rendered even when every check passed.
 *
 * Deterministic: built entirely from values already computed for the text
 * summary and `--json` output. No timestamps, no random ids.
 */
export interface MarkdownSummaryInput {
  readonly command: "compare" | "inspect" | "clearance";
  /** e.g. "policy passed", "policy failed", "indeterminate". Printed verbatim as the verdict line -- never simplified to a bare emoji or checkmark that could be misread as a geometric guarantee. */
  readonly verdict: string;
  /** One-line description of what was compared/inspected and with which files. */
  readonly headline: string;
  readonly metrics: readonly { readonly label: string; readonly value: string }[];
  /** Present for every specified `--max-*`/`--fail-on-*`/`--require-*` option; empty when the run was informational only. */
  readonly policyChecks: readonly PolicyCheck[];
  /** Always non-empty for an approximate-method run (`compare`/`clearance`); the first entry is always the plain "this is sampled, not exact" statement. */
  readonly caveats: readonly string[];
  readonly warnings: readonly { readonly severity: string; readonly code: string; readonly message: string }[];
}

function escapeCell(value: string): string {
  return value.replace(/\|/gu, "\\|").replace(/\r?\n/gu, " ");
}

export function buildMarkdownSummary(input: MarkdownSummaryInput): string {
  const lines: string[] = [];
  lines.push(`## voxelspy ${input.command}`);
  lines.push("");
  lines.push(input.headline);
  lines.push("");
  lines.push(`**Verdict: ${input.verdict.toUpperCase()}**`);
  lines.push("");

  if (input.metrics.length > 0) {
    lines.push("| Metric | Value |");
    lines.push("| --- | --- |");
    for (const metric of input.metrics) {
      lines.push(`| ${escapeCell(metric.label)} | ${escapeCell(metric.value)} |`);
    }
    lines.push("");
  }

  if (input.policyChecks.length === 0) {
    lines.push(
      "No policy options were specified; this run is informational only and did not gate anything.",
    );
    lines.push("");
  } else {
    lines.push("### Policy checks");
    lines.push("");
    lines.push("| Check | Result | Detail |");
    lines.push("| --- | --- | --- |");
    for (const check of input.policyChecks) {
      lines.push(
        `| ${escapeCell(check.description)} | ${check.passed ? "PASS" : "FAIL"} | ${escapeCell(check.detail)} |`,
      );
    }
    lines.push("");
  }

  lines.push("### Caveats");
  lines.push("");
  if (input.caveats.length === 0) {
    lines.push("- None recorded for this run.");
  } else {
    for (const caveat of input.caveats) {
      lines.push(`- ${caveat}`);
    }
  }
  lines.push("");

  if (input.warnings.length > 0) {
    lines.push("### Warnings");
    lines.push("");
    for (const warning of input.warnings) {
      lines.push(`- [${warning.severity}] \`${warning.code}\`: ${warning.message}`);
    }
    lines.push("");
  }

  return `${lines.join("\n").replace(/\n+$/u, "")}\n`;
}

export function writeMarkdownFile(path: string, markdown: string): void {
  writeFileSync(path, markdown, "utf8");
}
