import { describe, expect, it } from "vitest";
import {
  fixtureManifestSchema,
  importerRegistrySchema,
  releasePolicySchema,
} from "../src/adapter-evidence.js";
import { analysisExchangeSchema } from "../src/analysis.js";
import { normalizedModelSchema } from "../src/geometry.js";
import { importExchangeSchema } from "../src/import.js";
import { reportSchema } from "../src/report.js";
import { sessionBundleSchema } from "../src/session.js";
import {
  getWorkerMessageTransferList,
  validateWorkerProtocolTrace,
  workerWireMessageSchema,
} from "../src/worker.js";
import { createCoreContractFixture } from "./fixtures/core-contract.fixture.js";

describe("core contract integration fixture", () => {
  it("correlates shared identities across every public contract family", () => {
    const fixture = createCoreContractFixture();
    expect(normalizedModelSchema.parse(fixture.baselineModel)).toBeTruthy();
    expect(normalizedModelSchema.parse(fixture.candidateModel)).toBeTruthy();
    expect(importExchangeSchema.parse(fixture.importExchange)).toBeTruthy();
    expect(analysisExchangeSchema.parse(fixture.analysisExchange)).toBeTruthy();
    expect(importerRegistrySchema.parse(fixture.registry)).toBeTruthy();
    expect(fixtureManifestSchema.parse(fixture.fixtures)).toBeTruthy();
    expect(releasePolicySchema.parse(fixture.releasePolicy)).toBeTruthy();
    expect(reportSchema.parse(fixture.report)).toBeTruthy();
    expect(sessionBundleSchema.parse(fixture.sessionBundle)).toBeTruthy();

    const trace = validateWorkerProtocolTrace(fixture.workerTrace);
    expect(trace).toMatchObject({ valid: true, phase: "idle" });
    const importExecution = workerWireMessageSchema.parse(
      fixture.workerTrace[3],
    );
    expect(getWorkerMessageTransferList(importExecution)).toEqual([
      fixture.importExchange.request.bytes.buffer,
    ]);

    expect(fixture.registry.adapters[0]?.id).toBe(
      fixture.baselineModel.provenance.importerId,
    );
    expect(fixture.fixtures.cases[0]?.targetModelId).toBe(
      fixture.importExchange.request.targetModelId,
    );
    expect(fixture.report.analysis.request.requestId).toBe(
      fixture.workerTrace[5]?.requestId,
    );
    expect(fixture.sessionBundle.manifest.reportId).toBe(fixture.report.id);
  });
});
