import { describe, expect, it } from "vitest";
import { buildSarifLog, SARIF_VERSION, type SarifFinding } from "../src/sarif.js";

function baseInput(findings: readonly SarifFinding[]) {
  return {
    command: "compare",
    artifacts: [{ uri: "baseline.stl" }, { uri: "candidate.stl" }],
    findings,
    runProperties: { method: { id: "surface-distance", version: "1.0.0" } },
  };
}

describe("buildSarifLog", () => {
  it("carries the required top-level SARIF 2.1.0 shape", () => {
    const log = buildSarifLog(baseInput([]));

    expect(log["version"]).toBe(SARIF_VERSION);
    expect(typeof log["$schema"]).toBe("string");
    expect(Array.isArray(log["runs"])).toBe(true);
    const runs = log["runs"] as unknown[];
    expect(runs).toHaveLength(1);
    const run = runs[0] as Record<string, unknown>;
    const tool = run["tool"] as Record<string, unknown>;
    const driver = tool["driver"] as Record<string, unknown>;
    expect(typeof driver["name"]).toBe("string");
    expect(typeof driver["version"]).toBe("string");
    expect(Array.isArray(driver["rules"])).toBe(true);
    expect(Array.isArray(run["artifacts"])).toBe(true);
    expect(Array.isArray(run["results"])).toBe(true);
  });

  it("emits exactly one result per finding, with the finding's ruleId and message", () => {
    const findings: SarifFinding[] = [
      {
        ruleId: "deviation-exceeds-threshold",
        message: "maximum deviation <= 1 mm -- observed maximum distance 2 mm",
        artifactUris: ["baseline.stl", "candidate.stl"],
      },
      {
        ruleId: "not-watertight",
        message: "candidate is not closed",
        artifactUris: ["candidate.stl"],
      },
    ];
    const log = buildSarifLog(baseInput(findings));
    const run = (log["runs"] as Record<string, unknown>[])[0] as Record<string, unknown>;
    const results = run["results"] as Record<string, unknown>[];

    expect(results).toHaveLength(2);
    expect(results[0]?.["ruleId"]).toBe("deviation-exceeds-threshold");
    expect((results[0]?.["message"] as { text: string }).text).toBe(findings[0]?.message);
    expect(results[1]?.["ruleId"]).toBe("not-watertight");
  });

  it("maps a policy-failure rule to level error", () => {
    const log = buildSarifLog(
      baseInput([
        { ruleId: "deviation-exceeds-threshold", message: "x", artifactUris: ["a.stl"] },
        { ruleId: "region-count-exceeds-threshold", message: "x", artifactUris: ["a.stl"] },
        { ruleId: "not-watertight", message: "x", artifactUris: ["a.stl"] },
        { ruleId: "non-manifold-edges", message: "x", artifactUris: ["a.stl"] },
        { ruleId: "degenerate-triangles", message: "x", artifactUris: ["a.stl"] },
        { ruleId: "clearance-violation", message: "x", artifactUris: ["a.stl"] },
      ]),
    );
    const run = (log["runs"] as Record<string, unknown>[])[0] as Record<string, unknown>;
    const results = run["results"] as Record<string, unknown>[];
    for (const result of results) {
      expect(result["level"]).toBe("error");
    }
  });

  it("maps indeterminate-analysis to level error -- never a silent pass", () => {
    const log = buildSarifLog(
      baseInput([
        {
          ruleId: "indeterminate-analysis",
          message: "the engine could not produce a decidable result",
          artifactUris: ["a.stl"],
        },
      ]),
    );
    const run = (log["runs"] as Record<string, unknown>[])[0] as Record<string, unknown>;
    const results = run["results"] as Record<string, unknown>[];
    expect(results[0]?.["level"]).toBe("error");
  });

  it("maps approximate-result to note and undersampled-region to warning -- an approximate pass is never recorded as bare 'clean'", () => {
    const log = buildSarifLog(
      baseInput([
        { ruleId: "approximate-result", message: "sampled, not exact", artifactUris: ["a.stl"] },
        { ruleId: "undersampled-region", message: "spacing exceeds tolerance", artifactUris: ["a.stl"] },
      ]),
    );
    const run = (log["runs"] as Record<string, unknown>[])[0] as Record<string, unknown>;
    const results = run["results"] as Record<string, unknown>[];
    expect(results[0]?.["level"]).toBe("note");
    expect(results[1]?.["level"]).toBe("warning");
  });

  it("never invents a source region -- every location is an artifact URI only", () => {
    const log = buildSarifLog(
      baseInput([
        {
          ruleId: "deviation-exceeds-threshold",
          message: "x",
          artifactUris: ["baseline.stl", "candidate.stl"],
        },
      ]),
    );
    const run = (log["runs"] as Record<string, unknown>[])[0] as Record<string, unknown>;
    const results = run["results"] as Record<string, unknown>[];
    const locations = results[0]?.["locations"] as Record<string, unknown>[];
    expect(locations).toHaveLength(2);
    for (const location of locations) {
      const physicalLocation = location["physicalLocation"] as Record<string, unknown>;
      expect(physicalLocation["region"]).toBeUndefined();
      expect((physicalLocation["artifactLocation"] as Record<string, unknown>)["uri"]).toBeTruthy();
    }
  });

  it("carries method/tolerance/sampling-bound/uncertainty provenance in run properties", () => {
    const log = buildSarifLog({
      command: "compare",
      artifacts: [{ uri: "a.stl" }],
      findings: [],
      runProperties: {
        method: { id: "surface-distance", version: "1.0.0" },
        tolerance: { distanceMillimetres: 0.05 },
        uncertainty: {
          description: "sampled at vertices and centroids",
          parameters: { maxSampleSpacingMillimetres: 0.12, undersampled: true },
        },
      },
    });
    const run = (log["runs"] as Record<string, unknown>[])[0] as Record<string, unknown>;
    const properties = run["properties"] as Record<string, unknown>;
    expect(properties["method"]).toEqual({ id: "surface-distance", version: "1.0.0" });
    expect(properties["tolerance"]).toEqual({ distanceMillimetres: 0.05 });
    expect(properties["uncertainty"]).toBeDefined();
  });

  it("omits invocations (and any timestamp) by default -- deterministic output", () => {
    const log = buildSarifLog(baseInput([]));
    const run = (log["runs"] as Record<string, unknown>[])[0] as Record<string, unknown>;
    expect(run["invocations"]).toBeUndefined();
    expect(JSON.stringify(log)).not.toMatch(/\d{4}-\d{2}-\d{2}T/u);
  });

  it("only records an explicit invocation timestamp when the caller passes one", () => {
    const log = buildSarifLog({ ...baseInput([]), timestampUtc: "2024-01-01T00:00:00Z" });
    const run = (log["runs"] as Record<string, unknown>[])[0] as Record<string, unknown>;
    const invocations = run["invocations"] as Record<string, unknown>[];
    expect(invocations[0]?.["startTimeUtc"]).toBe("2024-01-01T00:00:00Z");
  });

  it("is deterministic: identical input produces byte-identical serialized output", () => {
    const input = baseInput([
      { ruleId: "deviation-exceeds-threshold", message: "x", artifactUris: ["a.stl"] },
      { ruleId: "approximate-result", message: "y", artifactUris: ["a.stl"] },
    ]);
    const first = JSON.stringify(buildSarifLog(input));
    const second = JSON.stringify(buildSarifLog(input));
    expect(first).toBe(second);
  });

  it("only lists rules that were actually used, in catalogue-declared order", () => {
    const log = buildSarifLog(
      baseInput([
        { ruleId: "undersampled-region", message: "x", artifactUris: ["a.stl"] },
        { ruleId: "deviation-exceeds-threshold", message: "y", artifactUris: ["a.stl"] },
      ]),
    );
    const run = (log["runs"] as Record<string, unknown>[])[0] as Record<string, unknown>;
    const tool = run["tool"] as Record<string, unknown>;
    const driver = tool["driver"] as Record<string, unknown>;
    const rules = driver["rules"] as Record<string, unknown>[];
    expect(rules.map((rule) => rule["id"])).toEqual([
      "deviation-exceeds-threshold",
      "undersampled-region",
    ]);
  });
});
