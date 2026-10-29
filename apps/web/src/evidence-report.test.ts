import {
  assessPrintability,
  diagnoseMeshHealth,
  inspectModel,
} from "@voxelspy/analysis";
import { importRequestSchema } from "@voxelspy/contracts";
import { importModel } from "@voxelspy/importers";
import { expect, it } from "vitest";
import {
  evidenceReportFileName,
  serializeEvidenceReport,
  type EvidenceReportInput,
} from "./evidence-report";

const source = `solid open
facet normal 0 0 1
outer loop
vertex 0 0 0
vertex 10 0 0
vertex 0 10 0
endloop
endfacet
endsolid open
`;
async function input(contents = source): Promise<EvidenceReportInput> {
  const bytes = new TextEncoder().encode(contents);
  const imported = await importModel(
    importRequestSchema.parse({
      contractVersion: 1,
      targetModelId: "model.report",
      sourceName: "open.stl",
      format: "stl",
      bytes,
      options: {
        userUnit: "inch",
        userAxis: "right-handed-y-up",
        limits: { inputBytes: bytes.length, triangleCount: 100 },
      },
    }),
  );
  if (!imported.ok) throw new Error(imported.message);
  return {
    kind: "inspection",
    source: { name: "open.stl", sizeBytes: bytes.length },
    provenance: imported.model.provenance,
    evidence: {
      inspection: inspectModel(imported.model),
      warnings: imported.model.warnings,
      diagnosis: {
        status: "ready",
        diagnosis: diagnoseMeshHealth(imported.model),
      },
    },
  };
}
it("retains exact engine evidence, source interpretation, withheld values and truncation without original geometry", async () => {
  const value = await input();
  const first = serializeEvidenceReport(value);
  expect(serializeEvidenceReport(value)).toEqual(first);
  const report = JSON.parse(new TextDecoder().decode(first));
  expect(report.schemaVersion).toBe(1);
  expect(report.provenance).toEqual(value.provenance);
  expect(report.provenance.sourceResolution).toEqual({
    unit: "user",
    axis: "user",
  });
  expect(report.evidence).toEqual(value.evidence);
  expect(report.evidence.inspection.watertightness.state).toBe("not-closed");
  expect(report.evidence.inspection.meshBreakdown.truncated).toBe(false);
  expect(report.limits.evidence.maxTopologyExamples).toBe(5);
  expect(report.limitations.join(" ")).toContain("self-intersection");
});
it("rejects invalid provenance, missing evidence, unfinished results, buffers and nonfinite numbers", async () => {
  const value = await input();
  expect(() =>
    serializeEvidenceReport({
      ...value,
      source: { name: "different.stl", sizeBytes: 1 },
    }),
  ).toThrow(/provenance/u);
  expect(() => serializeEvidenceReport({ ...value, evidence: {} })).toThrow(
    /missing/u,
  );
  expect(() =>
    serializeEvidenceReport({
      ...value,
      evidence: { ...value.evidence, diagnosis: { status: "loading" } },
    }),
  ).toThrow(/unfinished/u);
  for (const payload of [
    { positions: [1, 2, 3] },
    { coordinate: NaN },
    { coordinate: Infinity },
    { raw: new Float64Array([1]) },
  ]) {
    const inspection = {
      ...(value.evidence.inspection as object),
      extra: payload,
    };
    expect(() =>
      serializeEvidenceReport({
        ...value,
        evidence: { ...value.evidence, inspection },
      }),
    ).toThrow();
  }
});
it("refuses oversized reports and sanitizes download filenames", async () => {
  const value = await input();
  const inspection = {
    ...(value.evidence.inspection as object),
    extra: "x".repeat(8 * 1024 * 1024),
  };
  expect(() =>
    serializeEvidenceReport({
      ...value,
      evidence: { ...value.evidence, inspection },
    }),
  ).toThrow(/8 MiB/u);
  expect(evidenceReportFileName("../../odd name.stl", "inspection")).toBe(
    ".._.._odd_name.inspection.voxelspy-report.json",
  );
});

it("retains true topology-example and diagnostic truncation flags with withheld geometry", async () => {
  const facets = Array.from(
    { length: 21 },
    (_, i) =>
      `facet normal 0 0 1\nouter loop\nvertex ${i * 30} 0 0\nvertex ${i * 30 + 10} 0 0\nvertex ${i * 30} 10 0\nendloop\nendfacet\n`,
  ).join("");
  const value = await input(`solid islands\n${facets}endsolid islands\n`);
  const report = JSON.parse(
    new TextDecoder().decode(serializeEvidenceReport(value)),
  );
  expect(
    report.evidence.inspection.topologyFindings.some(
      (finding: { examplesTruncated: boolean }) => finding.examplesTruncated,
    ),
  ).toBe(true);
  expect(report.evidence.diagnosis.diagnosis.boundaryLoops.loopsTruncated).toBe(
    true,
  );
  expect(report.evidence.diagnosis.diagnosis.boundaryLoops.loopCount).toBe(21);
  expect(report.evidence).toEqual(value.evidence);
});

it("preserves an unbounded printability spacing as an explicit tagged number", async () => {
  const base = await input();
  const imported = await importModel(
    importRequestSchema.parse({
      contractVersion: 1,
      targetModelId: "model.report",
      sourceName: "open.stl",
      format: "stl",
      bytes: new TextEncoder().encode(source),
      options: {
        userUnit: "millimetre",
        userAxis: "right-handed-z-up",
        limits: { inputBytes: 10000, triangleCount: 100 },
      },
    }),
  );
  if (!imported.ok) throw new Error(imported.message);
  const assessment = assessPrintability(imported.model);
  const unbounded = {
    ...assessment,
    wallThickness: {
      ...assessment.wallThickness,
      sampleSpacingUpperBoundMillimetres: Infinity,
    },
  };
  const report = JSON.parse(
    new TextDecoder().decode(
      serializeEvidenceReport({
        ...base,
        kind: "printability",
        evidence: { assessment: unbounded, warnings: [] },
      }),
    ),
  );
  expect(
    report.evidence.assessment.wallThickness.sampleSpacingUpperBoundMillimetres,
  ).toEqual({ nonFiniteNumber: "positive-infinity" });
  expect(report.limitations.join(" ")).toContain("positive-infinity");
});
