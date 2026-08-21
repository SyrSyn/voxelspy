import { describe, expect, it } from "vitest";
import { buildMarkdownSummary } from "../src/markdown-report.js";

describe("buildMarkdownSummary", () => {
  it("states the verdict, the numbers, and an approximate-ness caveat plainly", () => {
    const markdown = buildMarkdownSummary({
      command: "compare",
      verdict: "policy failed",
      headline:
        "Compared `baseline.stl` (baseline) against `candidate.stl` (candidate).",
      metrics: [
        { label: "Maximum distance", value: "2 mm" },
        { label: "Changed regions", value: "3 detected, 3 reported" },
      ],
      policyChecks: [
        {
          id: "max-deviation",
          description: "maximum deviation <= 1 mm",
          passed: false,
          detail: "observed maximum distance 2 mm across 3 detected region(s)",
        },
      ],
      caveats: [
        "This is an APPROXIMATE result: distances are sampled, not measured continuously across the surface.",
      ],
      warnings: [],
    });

    expect(markdown).toContain("**Verdict: POLICY FAILED**");
    expect(markdown).toContain("2 mm");
    expect(markdown).toContain("3 detected, 3 reported");
    expect(markdown).toContain("maximum deviation <= 1 mm");
    expect(markdown).toContain("FAIL");
    expect(markdown).toMatch(/APPROXIMATE/u);
    expect(markdown).not.toMatch(/proof|guarantee(?!.{0,80}not)/iu);
  });

  it("never omits caveats, even for a clean informational run", () => {
    const markdown = buildMarkdownSummary({
      command: "compare",
      verdict: "informational (no policy configured)",
      headline: "Compared two revisions.",
      metrics: [{ label: "Maximum distance", value: "0 mm" }],
      policyChecks: [],
      caveats: ["This is an APPROXIMATE result: sample spacing bound 0.1 mm."],
      warnings: [],
    });

    expect(markdown).toContain("informational only");
    expect(markdown).toMatch(/APPROXIMATE/u);
  });

  it("renders warnings when present", () => {
    const markdown = buildMarkdownSummary({
      command: "inspect",
      verdict: "policy passed",
      headline: "Inspected `model.stl`.",
      metrics: [],
      policyChecks: [],
      caveats: ["Exact topology findings; not sampled."],
      warnings: [
        {
          severity: "warning",
          code: "example-code",
          message: "example message",
        },
      ],
    });

    expect(markdown).toContain("### Warnings");
    expect(markdown).toContain("example-code");
    expect(markdown).toContain("example message");
  });

  it("escapes table-breaking characters in cell content", () => {
    const markdown = buildMarkdownSummary({
      command: "compare",
      verdict: "policy passed",
      headline: "x",
      metrics: [{ label: "A | B", value: "line1\nline2" }],
      policyChecks: [],
      caveats: ["caveat"],
      warnings: [],
    });
    expect(markdown).toContain("A \\| B");
    expect(markdown).not.toContain("line1\nline2 |");
  });

  it("is deterministic for identical input", () => {
    const input = {
      command: "clearance" as const,
      verdict: "policy passed",
      headline: "Checked clearance.",
      metrics: [{ label: "State", value: "clear" }],
      policyChecks: [],
      caveats: ["approximate"],
      warnings: [],
    };
    expect(buildMarkdownSummary(input)).toBe(buildMarkdownSummary(input));
  });
});
