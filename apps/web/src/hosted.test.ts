import { describe, expect, it } from "vitest";
import { importModel } from "@voxelspy/importers";
import { validateHostedLoad, isHostedParentMessage } from "./hosted-bridge";
import { createHostedWorkspace } from "./hosted";
import { resolveFrameOptions } from "./formats";
const bytes = new TextEncoder().encode("v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n");
async function load() {
  const imported = await importModel({
    contractVersion: 1,
    targetModelId: "model.original",
    format: "obj",
    sourceName: "part.obj",
    bytes: bytes.slice(),
    options: {
      userUnit: "inch",
      declaredAxis: "right-handed-y-up",
      limits: { inputBytes: 10000, triangleCount: 100 },
    },
  });
  if (!imported.ok) throw new Error(imported.message);
  return {
    type: "voxelspy:load" as const,
    version: 1 as const,
    requestId: "request.1",
    sources: [
      {
        revisionId: "revision.1",
        name: "part.obj",
        digest: imported.model.provenance.sourceDigest!.value,
        bytes: bytes.slice().buffer,
        provenance: imported.model.provenance,
      },
    ],
  };
}
describe("optional hosted source boundary", () => {
  it("validates source bytes and preserves independent recorded frame origins", async () => {
    const request = await validateHostedLoad(await load(), "inspect"),
      workspace = createHostedWorkspace(request, "inspect", () => true);
    expect(
      resolveFrameOptions(
        "obj",
        "recorded",
        "inch",
        "right-handed-y-up",
        workspace.files[0],
      ),
    ).toEqual({ userUnit: "inch", declaredAxis: "right-handed-y-up" });
    expect(new Uint8Array(await workspace.files[0]!.arrayBuffer())).toEqual(
      bytes,
    );
  });
  it("refuses mismatched digest/provenance, extra sources, versions and session tool confusion", async () => {
    const request = await load();
    for (const altered of [
      {
        ...request,
        sources: [{ ...request.sources[0], bytes: new Uint8Array([1]).buffer }],
      },
      { ...request, version: 2 },
      { ...request, sources: [...request.sources, ...request.sources] },
      { ...request, session: new ArrayBuffer(1) },
    ])
      await expect(
        validateHostedLoad(altered, "inspect"),
      ).rejects.toBeDefined();
  });
  it("accepts only the precise same-origin parent window", () => {
    const parent = {} as Window,
      other = {} as Window;
    expect(
      isHostedParentMessage(
        { source: parent, origin: "https://example.test" },
        parent,
        "https://example.test",
      ),
    ).toBe(true);
    expect(
      isHostedParentMessage(
        { source: other, origin: "https://example.test" },
        parent,
        "https://example.test",
      ),
    ).toBe(false);
    expect(
      isHostedParentMessage(
        { source: parent, origin: "https://other.test" },
        parent,
        "https://example.test",
      ),
    ).toBe(false);
  });
});
