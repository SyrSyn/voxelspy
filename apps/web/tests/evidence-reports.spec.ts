import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";

const tetrahedronStl = `solid tetra
facet normal 0 0 -1
outer loop
vertex 0 0 0
vertex 0 10 0
vertex 10 0 0
endloop
endfacet
facet normal 0 -1 0
outer loop
vertex 0 0 0
vertex 10 0 0
vertex 0 0 10
endloop
endfacet
facet normal -1 0 0
outer loop
vertex 0 0 0
vertex 0 0 10
vertex 0 10 0
endloop
endfacet
facet normal 1 1 1
outer loop
vertex 10 0 0
vertex 0 10 0
vertex 0 0 10
endloop
endfacet
endsolid tetra
`;

async function download(page: Page) {
  const waiting = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download evidence JSON" }).click();
  const artifact = await waiting;
  expect(artifact.suggestedFilename()).toMatch(/\.voxelspy-report\.json$/u);
  const path = await artifact.path();
  if (!path) throw new Error("Download unavailable");
  const text = await readFile(path, "utf8");
  return { text, json: JSON.parse(text) };
}

for (const tool of [
  {
    route: "inspect",
    kind: "inspection",
    run: "Validate and inspect",
    reset: "Inspect another model",
  },
  {
    route: "printability",
    kind: "printability",
    run: "Assess printability",
    reset: "Assess another model",
  },
  {
    route: "measure-section",
    kind: "measure-section",
    run: "Load model",
    reset: "Load another model",
  },
  {
    route: "file-forensics",
    kind: "file-forensics",
    run: "Validate and analyze",
    reset: "Analyze another file",
  },
]) {
  test(`${tool.kind} downloads deterministic local evidence without model buffers`, async ({
    page,
    baseURL,
  }) => {
    const offOrigin: string[] = [];
    page.on("request", (request) => {
      if (!request.url().startsWith(new URL(baseURL!).origin + "/"))
        offOrigin.push(request.url());
    });
    await page.goto(`/tools/${tool.route}/`);
    await expect(
      page.getByRole("button", { name: "Download evidence JSON" }),
    ).toHaveCount(0);
    await page
      .locator(
        tool.kind === "file-forensics"
          ? "#forensics-model-file"
          : "#model-file",
      )
      .setInputFiles({
        name: "tetra.stl",
        mimeType: "model/stl",
        buffer: Buffer.from(tetrahedronStl),
      });
    await page.getByRole("button", { name: tool.run, exact: true }).click();
    const button = page.getByRole("button", { name: "Download evidence JSON" });
    await expect(button).toBeEnabled({ timeout: 20000 });
    if (tool.kind === "measure-section") {
      for (const point of [
        [0, 0, 0],
        [10, 0, 0],
      ]) {
        for (const [axis, index] of [
          ["x", 0],
          ["y", 1],
          ["z", 2],
        ] as const)
          await page.locator(`#manual-${axis}`).fill(String(point[index]));
        await page
          .getByRole("button", { name: "Snap to nearest surface point" })
          .click();
        await expect(button).toBeEnabled();
      }
      await expect(
        page.getByRole("button", { name: "Keep measurement" }),
      ).toBeEnabled();
      await page.getByRole("button", { name: "Keep measurement" }).click();
      await page.locator("#plane-offset").fill("2");
      await page.getByRole("button", { name: "Run section" }).click();
      await expect(
        page.locator('[aria-labelledby="section-loops-title"]'),
      ).toBeVisible();
      await expect(button).toBeEnabled();
    }
    const first = await download(page);
    const second = await download(page);
    expect(second.text).toBe(first.text);
    expect(first.json).toMatchObject({
      schemaVersion: 1,
      kind: tool.kind,
      source: {
        name: "tetra.stl",
        sizeBytes: Buffer.byteLength(tetrahedronStl),
      },
      provenance: {
        sourceName: "tetra.stl",
        sourceUnit: "millimetre",
        sourceAxis: "right-handed-z-up",
      },
    });
    expect(first.json.provenance.sourceDigest.value).toBe(
      createHash("sha256").update(tetrahedronStl).digest("hex"),
    );
    expect(first.json.limitations.length).toBeGreaterThan(0);
    expect(first.json.limits.importer.triangleCount).toBe(500000);
    expect(first.json.evidence.warnings).toBeInstanceOf(Array);
    expect(first.text).not.toMatch(
      /"(?:model|positions|indices|bytes|buffers)"\s*:/u,
    );
    if (tool.kind === "inspection") {
      expect(first.json.evidence.inspection.watertightness.state).toBe(
        "closed",
      );
      expect(first.json.evidence.inspection.meshBreakdown.truncated).toBe(
        false,
      );
      expect(first.json.evidence.diagnosis.status).toBe("idle");
    } else if (tool.kind === "printability") {
      expect(first.json.evidence.assessment.disclaimer).toContain("not");
      expect(first.json.evidence.assessment.wallThickness).toHaveProperty(
        "sampleSpacingUpperBoundMillimetres",
      );
    } else if (tool.kind === "measure-section") {
      expect(
        first.json.evidence.measurements[0].result.distanceMillimetres,
      ).toBe(10);
      expect(first.json.evidence.section.status).toBe("ready");
      expect(first.json.evidence.section.result.plane.pointMillimetres).toEqual(
        [0, 0, 2],
      );
      expect(first.json.evidence.section.result.loops.loops[0].closed).toBe(
        true,
      );
    } else {
      expect(first.json.evidence.meshes[0].triangleCount).toBe(4);
      expect(first.json.evidence.importLimits.triangleCount).toBe(500000);
    }
    await page.getByRole("button", { name: tool.reset, exact: true }).click();
    await expect(button).toHaveCount(0);
    expect(offOrigin).toEqual([]);
  });
}

test("inspection download includes completed bounded diagnosis and clears it on replacement", async ({
  page,
}) => {
  await page.goto("/tools/inspect/");
  const contents =
    tetrahedronStl.slice(
      0,
      tetrahedronStl.indexOf("endfacet") + "endfacet".length,
    ) + "\nendsolid tetra\n";
  await page.locator("#model-file").setInputFiles({
    name: "open.stl",
    mimeType: "model/stl",
    buffer: Buffer.from(contents),
  });
  await page
    .getByRole("button", { name: "Validate and inspect", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Load full diagnostic evidence" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Boundary loops (1)", exact: true }),
  ).toBeVisible();
  const { json } = await download(page);
  expect(json.evidence.inspection.watertightness.state).toBe("not-closed");
  expect(json.evidence.diagnosis.status).toBe("ready");
  expect(json.evidence.diagnosis.diagnosis.boundaryLoops).toMatchObject({
    loopCount: 1,
    loopsTruncated: false,
  });
  expect(
    json.evidence.diagnosis.diagnosis.boundaryLoops.loops[0].pointsMillimetres
      .length,
  ).toBeGreaterThan(0);
  await page
    .getByRole("button", { name: "Inspect another model", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Download evidence JSON" }),
  ).toHaveCount(0);
  await page.locator("#model-file").setInputFiles({
    name: "new.stl",
    mimeType: "model/stl",
    buffer: Buffer.from(tetrahedronStl),
  });
  await page
    .getByRole("button", { name: "Validate and inspect", exact: true })
    .click();
  const replacement = await download(page);
  expect(replacement.json.source.name).toBe("new.stl");
  expect(replacement.json.evidence.diagnosis.status).toBe("idle");
});
