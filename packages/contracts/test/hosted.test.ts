import { describe, expect, it } from "vitest";
import { hostedArtifactSchema, hostedLoadSchema } from "../src/hosted.js";
const artifact = {
  type: "voxelspy:artifact",
  version: 1,
  requestId: "request.1",
  artifactId: "artifact.1",
  tool: "convert",
  kind: "converted-model",
  name: "part.obj",
  mime: "model/obj",
  bytes: new ArrayBuffer(1),
  revisionIds: ["revision.1"],
  metadata: {
    export: {
      format: "obj",
      targetUnit: "inch",
      targetAxis: "right-handed-y-up",
    },
  },
};
describe("hosted bridge version 1", () => {
  it("requires explicit conversion frame and rejects metadata on other kinds", () => {
    expect(hostedArtifactSchema.safeParse(artifact).success).toBe(true);
    expect(
      hostedArtifactSchema.safeParse({ ...artifact, metadata: undefined })
        .success,
    ).toBe(false);
    expect(
      hostedArtifactSchema.safeParse({
        ...artifact,
        kind: "evidence-json",
        mime: "application/json",
      }).success,
    ).toBe(false);
  });
  it("refuses incompatible kinds, traversal names, duplicate revisions and versions", () => {
    for (const change of [
      { tool: "inspect" },
      { name: "../part.obj" },
      { revisionIds: ["revision.1", "revision.1"] },
      { version: 2 },
    ])
      expect(
        hostedArtifactSchema.safeParse({ ...artifact, ...change }).success,
      ).toBe(false);
  });
  it("refuses empty or unversioned loads before reading content", () => {
    expect(
      hostedLoadSchema.safeParse({
        type: "voxelspy:load",
        version: 1,
        requestId: "request.1",
        sources: [],
      }).success,
    ).toBe(false);
    expect(hostedLoadSchema.safeParse({}).success).toBe(false);
  });
});
