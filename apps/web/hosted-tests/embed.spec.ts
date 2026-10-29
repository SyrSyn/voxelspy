import { expect, test, type Page } from "@playwright/test";
import { importModel } from "@voxelspy/importers";
import type { HostedLoad, HostedTool } from "@voxelspy/contracts/hosted";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { createNodeStepRuntime } from "@voxelspy/importers/step-runtime-node";
import { cuboidStep } from "../../../packages/importers/test/fixtures/step.fixture";
const browserAudits = new WeakMap<
  Page,
  { errors: string[]; offOrigin: string[] }
>();
test.beforeEach(async ({ page, baseURL }) => {
  const audit = { errors: [] as string[], offOrigin: [] as string[] };
  browserAudits.set(page, audit);
  page.on("pageerror", (error) => audit.errors.push(error.message));
  page.on("request", (request) => {
    if (new URL(request.url()).origin !== new URL(baseURL!).origin)
      audit.offOrigin.push(request.url());
  });
});
test.afterEach(async ({ page }) => {
  expect(browserAudits.get(page)).toEqual({ errors: [], offOrigin: [] });
});
const obj = (offset = 0) =>
  `v ${offset} 0 0\nv ${offset + 10} 0 0\nv ${offset} 10 0\nf 1 2 3\n`;
async function source(index = 0) {
  const bytes = new TextEncoder().encode(obj(index));
  const result = await importModel({
    contractVersion: 1,
    targetModelId: `model.${index}`,
    format: "obj",
    sourceName: `part-${index}.obj`,
    bytes,
    options: {
      userUnit: "inch",
      declaredAxis: "right-handed-y-up",
      limits: { inputBytes: 10000, triangleCount: 100 },
    },
  });
  if (!result.ok) throw Error(result.message);
  return {
    revisionId: `revision.${index}`,
    name: `part-${index}.obj`,
    digest: result.model.provenance.sourceDigest!.value,
    bytes: bytes.buffer,
    provenance: result.model.provenance,
  };
}
async function host(
  page: Page,
  tool: HostedTool,
  sources: HostedLoad["sources"],
) {
  await page.route("**/host-harness", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><html><body><h1>Host fixture</h1></body></html>",
    }),
  );
  await page.goto("/host-harness");
  await page.evaluate(
    ({ tool }) => {
      const w = window as any;
      w.artifacts = [];
      w.ready = false;
      window.addEventListener("message", (event) => {
        if (
          event.source !== w.frame.contentWindow ||
          event.origin !== location.origin
        )
          return;
        if (event.data.type === "voxelspy:ready") w.ready = true;
        if (event.data.type === "voxelspy:artifact")
          w.artifacts.push(event.data);
      });
      const frame = document.createElement("iframe");
      w.frame = frame;
      frame.title = "Revision workbench";
      frame.style.width = "100%";
      frame.height = "1800";
      frame.src = "/workbench/embed.html?tool=" + tool;
      document.body.append(frame);
    },
    { tool },
  );
  await expect
    .poll(() => page.evaluate(() => (window as any).ready))
    .toBe(true);
  const serialized = sources.map((s) => ({
    ...s,
    bytes: Array.from(new Uint8Array(s.bytes)),
  }));
  await page.evaluate(
    ({ sources }) => {
      const w = window as any;
      w.load = {
        type: "voxelspy:load",
        version: 1,
        requestId: "request.1",
        sources: sources.map((s) => ({
          ...s,
          bytes: new Uint8Array(s.bytes).buffer,
        })),
      };
      w.frame.contentWindow.postMessage(w.load, location.origin);
    },
    { sources: serialized },
  );
  const frame = page.frameLocator("iframe");
  await expect(frame.getByText(/Loaded exact revision/)).toBeVisible();
  return frame;
}
for (const tool of [
  "inspect",
  "mesh-health",
  "measure-section",
  "clearance-fit",
  "printability",
  "file-forensics",
  "convert",
] as HostedTool[]) {
  test(`${tool} preloads exact revision frame and stages real output`, async ({
    page,
  }) => {
    test.setTimeout(90000);
    const sources =
      tool === "clearance-fit"
        ? [await source(), await source(1)]
        : [await source()];
    const frame = await host(page, tool, sources);
    const button =
      tool === "inspect" || tool === "mesh-health"
        ? "Validate and inspect"
        : tool === "file-forensics"
          ? "Validate and analyze"
          : tool === "measure-section" || tool === "convert"
            ? "Load model"
            : tool === "clearance-fit"
              ? "Check clearance"
              : "Assess printability";
    await expect(
      frame.getByRole("button", { name: button, exact: true }),
    ).toBeEnabled();
    await frame.getByRole("button", { name: button, exact: true }).click();
    if (tool === "mesh-health") {
      await frame
        .getByRole("button", { name: "Check self-intersections", exact: true })
        .click();
      await expect(
        frame.getByRole("button", {
          name: "Download mesh health evidence",
          exact: true,
        }),
      ).toBeVisible();
    }
    if (tool === "convert") {
      await frame
        .getByRole("combobox", { name: "Format", exact: true })
        .selectOption("obj");
      await frame
        .getByRole("combobox", { name: "Output unit", exact: true })
        .selectOption("millimetre");
      await frame
        .getByRole("combobox", { name: "Output up-axis", exact: true })
        .selectOption("right-handed-z-up");
      await expect(
        frame.getByRole("button", { name: "Export and download", exact: true }),
      ).toBeEnabled();
    }
    const pending = page.waitForEvent("download");
    await frame
      .getByRole("button", {
        name:
          tool === "convert"
            ? "Export and download"
            : tool === "mesh-health"
              ? "Download mesh health evidence"
              : "Download evidence JSON",
        exact: true,
      })
      .click();
    const downloaded = await pending;
    const local = await readFile((await downloaded.path())!);
    await expect
      .poll(() => page.evaluate(() => (window as any).artifacts.length))
      .toBe(1);
    const artifact = await page.evaluate(() => {
      const a = (window as any).artifacts[0];
      return { ...a, bytes: Array.from(new Uint8Array(a.bytes)) };
    });
    expect(artifact.requestId).toBe("request.1");
    expect(artifact.revisionIds).toEqual(sources.map((s) => s.revisionId));
    expect(artifact.tool).toBe(tool);
    if (tool === "convert") {
      expect(Buffer.from(artifact.bytes).equals(local)).toBe(true);
      expect(artifact.metadata.export.targetUnit).toBe("millimetre");
    } else {
      const evidence = JSON.parse(Buffer.from(artifact.bytes).toString());
      expect(evidence.kind).toBe("tool-evidence");
      expect(evidence.sources.map((s: any) => s.digest)).toEqual(
        sources.map((s) => s.digest),
      );
      expect(evidence.sources[0].provenance.sourceResolution).toEqual({
        unit: "user",
        axis: "declared",
      });
      expect(evidence.evidence).toEqual(JSON.parse(local.toString()));
      if (tool === "inspect")
        expect(
          evidence.evidence.evidence.inspection.summary.bounds
            .dimensionsMillimetres,
        ).toEqual([254, 0, 254]);
    }
  });
}
test("comparison preserves review/session artifacts and reopens the exact revision set", async ({
  page,
}) => {
  test.setTimeout(90000);
  const sources = [await source(), await source(1)],
    frame = await host(page, "compare", sources);
  await frame
    .getByRole("button", { name: "Validate and compare", exact: true })
    .click();
  await expect(
    frame.getByRole("heading", { name: "Comparison workbench", exact: true }),
  ).toBeVisible();
  await frame.locator(".review-panel > summary").click();
  await frame
    .getByLabel("Annotation label", { exact: true })
    .fill("Hosted note");
  await frame
    .getByLabel("Callout text", { exact: true })
    .fill("Keep this source revision");
  await frame.getByLabel("Start / anchor (mm)", { exact: true }).fill("0,0,0");
  await frame
    .getByRole("button", { name: "Add annotation", exact: true })
    .click();
  await frame
    .getByLabel("Saved view name", { exact: true })
    .fill("Hosted camera");
  await frame
    .getByRole("button", { name: "Save named view", exact: true })
    .click();
  const download = page.waitForEvent("download");
  await frame
    .getByRole("button", { name: "Save session", exact: true })
    .click();
  const bytes = await readFile((await (await download).path())!);
  await expect
    .poll(() => page.evaluate(() => (window as any).artifacts.length))
    .toBe(1);
  await page.evaluate(
    ({ bytes }) => {
      const w = window as any;
      w.frame.contentWindow.postMessage(
        {
          ...w.load,
          requestId: "request.2",
          session: new Uint8Array(bytes).buffer,
        },
        location.origin,
      );
    },
    { bytes: Array.from(bytes) },
  );
  await expect(frame.locator(".review-panel > summary")).toContainText(
    "1 annotations",
    { timeout: 20000 },
  );
  await frame.locator(".review-panel > summary").click();
  await expect(
    frame.getByRole("button", {
      name: "Restore view Hosted camera",
      exact: true,
    }),
  ).toBeVisible({ timeout: 20000 });
  await expect(
    frame.getByRole("list", { name: "Review annotations" }),
  ).toContainText("Keep this source revision");
  const again = page.waitForEvent("download");
  await frame
    .getByRole("button", { name: "Save session", exact: true })
    .click();
  expect((await readFile((await (await again).path())!)).equals(bytes)).toBe(
    true,
  );
  const pending = page.waitForEvent("download");
  await frame
    .getByRole("button", { name: "Export report", exact: true })
    .click();
  expect(await readFile((await (await pending).path())!, "utf8")).toContain(
    "Hosted note",
  );
});
test("refuses invalid bridge input without accepting forged source windows or digest bytes", async ({
  page,
}) => {
  const frame = await host(page, "inspect", [await source()]);
  await frame.locator("body").evaluate(() => {
    window.dispatchEvent(
      new MessageEvent("message", {
        source: window,
        origin: location.origin,
        data: { type: "voxelspy:load", version: 2 },
      }),
    );
    window.dispatchEvent(
      new MessageEvent("message", {
        source: window.parent,
        origin: "https://other.invalid",
        data: { type: "voxelspy:load", version: 2 },
      }),
    );
  });
  await expect(frame.getByText(/Loaded exact revision/)).toBeVisible();
  await expect(frame.getByRole("alert")).toHaveCount(0);
  await page.evaluate(() => {
    const w = window as any;
    w.frame.contentWindow.postMessage(
      {
        ...w.load,
        requestId: "request.bad",
        sources: [{ ...w.load.sources[0], bytes: new Uint8Array([1]).buffer }],
      },
      location.origin,
    );
  });
  await expect(frame.getByRole("alert")).toContainText(
    "could not be accepted safely",
  );
  expect(await page.evaluate(() => (window as any).artifacts.length)).toBe(0);
  await page.goto("/tools/inspect/");
  await expect(
    page.getByRole("button", { name: "Validate and inspect", exact: true }),
  ).toBeDisabled();
});

test("STEP runtime resolves beneath the embedded prefix and preserves kernel provenance", async ({
  page,
}) => {
  test.setTimeout(90000);
  const require = createRequire(
    new URL("../../../packages/importers/package.json", import.meta.url),
  );
  const wasmBinary = await readFile(
    path.join(
      path.dirname(require.resolve("occt-import-js")),
      "occt-import-js.wasm",
    ),
  );
  const runtime = await createNodeStepRuntime({ wasmBinary });
  const bytes = new TextEncoder().encode(cuboidStep());
  const imported = await importModel(
    {
      contractVersion: 1,
      targetModelId: "model.step",
      format: "step",
      sourceName: "offset.step",
      bytes,
      options: {
        declaredAxis: "right-handed-z-up",
        limits: { inputBytes: 100000, triangleCount: 1000 },
      },
    },
    { stepRuntime: runtime },
  );
  if (!imported.ok) throw Error(imported.message);
  const sources = [
    {
      revisionId: "revision.step",
      name: "offset.step",
      digest: imported.model.provenance.sourceDigest!.value,
      provenance: imported.model.provenance,
      bytes: bytes.buffer,
    },
  ];
  const requests: string[] = [];
  page.on("request", (request) =>
    requests.push(new URL(request.url()).pathname),
  );
  const frame = await host(page, "inspect", sources);
  await frame
    .getByRole("button", { name: "Validate and inspect", exact: true })
    .click();
  await expect(
    frame.getByRole("button", { name: "Download evidence JSON", exact: true }),
  ).toBeEnabled({ timeout: 60000 });
  const pending = page.waitForEvent("download");
  await frame
    .getByRole("button", { name: "Download evidence JSON", exact: true })
    .click();
  const evidence = JSON.parse(
    await readFile((await (await pending).path())!, "utf8"),
  );
  expect(
    evidence.evidence.inspection.summary.bounds.dimensionsMillimetres,
  ).toEqual([10, 20, 30]);
  expect(evidence.provenance.tessellation.parameters.occtVersion).toBe("7.6.1");
  await expect
    .poll(() => page.evaluate(() => (window as any).artifacts.length))
    .toBe(1);
  expect((await page.request.get("/step/occt.worker.js")).status()).toBe(404);
  expect(
    (await page.request.get("/workbench/step/occt.worker.js")).status(),
  ).toBe(200);
});
