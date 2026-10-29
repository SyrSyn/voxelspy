import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { cuboidStep } from "../../../packages/importers/test/fixtures/step.fixture";

test("STEP imports an original offset solid through the isolated kernel with explicit provenance", async ({
  page,
  request,
  baseURL,
}) => {
  const offOrigin: string[] = [];
  page.on("request", (r) => {
    if (new URL(r.url()).origin !== new URL(baseURL!).origin)
      offOrigin.push(r.url());
  });
  const pageResponse = await page.goto("/tools/inspect/");
  expect(pageResponse?.headers()["content-security-policy"]).not.toContain(
    "'unsafe-eval'",
  );
  const workerResponse = await request.get("/step/occt.worker.js");
  expect(workerResponse.headers()["content-security-policy"]).toContain(
    "'unsafe-eval'",
  );
  expect(workerResponse.headers()["content-security-policy"]).not.toContain(
    "sha256-",
  );
  const manifest = JSON.parse(
    await readFile(
      new URL("../../../third-party/step/manifest.json", import.meta.url),
      "utf8",
    ),
  ) as { runtime: Record<string, string> };
  const workerSource = await workerResponse.text();
  expect(workerSource).toContain(manifest.runtime["occt-import-js.wasm"]);
  expect(workerSource).not.toContain("__VOXELSPY_STEP_WASM_SHA256__");
  const source = cuboidStep({ unit: "inch" });
  await page.locator("#model-file").setInputFiles({
    name: "offset.stp",
    mimeType: "model/step",
    buffer: Buffer.from(source),
  });
  await page.getByRole("button", { name: "Validate and inspect" }).click();
  const button = page.getByRole("button", { name: "Download evidence JSON" });
  await expect(button).toBeEnabled({ timeout: 60_000 });
  const pending = page.waitForEvent("download");
  await button.click();
  const file = await pending;
  const report = JSON.parse(await readFile((await file.path())!, "utf8"));
  expect(report.provenance.formatId).toBe("step");
  expect(report.provenance.detectedSourceUnit).toBe("inch");
  expect(report.provenance.detectedSourceAxis).toBe("unknown");
  expect(report.provenance.sourceResolution).toEqual({
    unit: "embedded",
    axis: "declared",
  });
  expect(report.provenance.sourceDigest.value).toBe(
    createHash("sha256").update(source).digest("hex"),
  );
  expect(report.provenance.tessellation.adapterVersion).toBe("0.0.23");
  expect(report.provenance.tessellation.parameters.occtVersion).toBe("7.6.1");
  expect(report.evidence.inspection.summary.triangleCount).toBe(12);
  const dimensions =
    report.evidence.inspection.summary.bounds.dimensionsMillimetres;
  dimensions.forEach((value: number, index: number) =>
    expect(value).toBeCloseTo([254, 508, 762][index]!, 5),
  );
  expect(offOrigin).toEqual([]);
});

test("STEP runtime failure leaves the importer usable for another local model", async ({
  page,
  baseURL,
}) => {
  // A real local proxy refuses the nested worker asset. Browser routing APIs
  // do not consistently intercept nested worker requests across engines.
  const proxy = createServer(async (incoming, outgoing) => {
    if (incoming.url === "/step/occt.worker.js") {
      outgoing.writeHead(503).end("Kernel unavailable for recovery fixture");
      return;
    }
    try {
      const upstream = await fetch(new URL(incoming.url ?? "/", baseURL!));
      const headers = Object.fromEntries(
        [...upstream.headers].filter(
          ([key]) =>
            ![
              "content-length",
              "content-encoding",
              "transfer-encoding",
              "connection",
            ].includes(key),
        ),
      );
      outgoing.writeHead(upstream.status, headers);
      outgoing.end(Buffer.from(await upstream.arrayBuffer()));
    } catch {
      outgoing.writeHead(502).end();
    }
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  try {
    await page.goto(
      `http://127.0.0.1:${(proxy.address() as AddressInfo).port}/tools/inspect/`,
    );
    await page.locator("#model-file").setInputFiles({
      name: "blocked.step",
      mimeType: "model/step",
      buffer: Buffer.from(cuboidStep()),
    });
    await page.getByRole("button", { name: "Validate and inspect" }).click();
    await expect(page.getByRole("alert")).toContainText(
      /could not|refused|runtime/i,
      {
        timeout: 30_000,
      },
    );
    await page.locator("#model-file").setInputFiles({
      name: "recovered.obj",
      mimeType: "text/plain",
      buffer: Buffer.from("v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n"),
    });
    await page.getByRole("button", { name: "Validate and inspect" }).click();
    await expect(
      page.getByRole("button", { name: "Download evidence JSON" }),
    ).toBeEnabled({ timeout: 20_000 });
  } finally {
    proxy.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      proxy.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

/** Real HTTP mutation reaches nested kernel workers on every browser engine. */
async function stepSecurityRefusalAndRecovery(
  page: Page,
  baseURL: string,
  mode: "wasm-mismatch" | "missing-crypto",
) {
  let sabotage = true;
  let mutatedAssets = 0;
  let guardedFactories = 0;
  const proxy = createServer(async (incoming, outgoing) => {
    try {
      const url = new URL(incoming.url ?? "/", baseURL);
      const upstream = await fetch(url);
      const headers = Object.fromEntries(
        [...upstream.headers].filter(
          ([key]) =>
            ![
              "content-length",
              "content-encoding",
              "transfer-encoding",
              "connection",
            ].includes(key),
        ),
      );
      headers["cache-control"] = "no-store";
      let bytes = Buffer.from(await upstream.arrayBuffer());
      if (sabotage && url.pathname === "/step/occt-import-js.js") {
        // Any factory call before the refusal must fail this test, rather
        // than quietly exercising an unverified native module first.
        bytes = Buffer.concat([
          bytes,
          Buffer.from(
            '\nocctimportjs = () => { throw new Error("Unexpected native factory invocation in refusal fixture."); };\n',
          ),
        ]);
        guardedFactories++;
      }
      if (
        sabotage &&
        mode === "wasm-mismatch" &&
        url.pathname === "/step/occt-import-js.wasm"
      ) {
        bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
        mutatedAssets++;
      }
      if (
        sabotage &&
        mode === "missing-crypto" &&
        url.pathname === "/step/occt.worker.js"
      ) {
        // Remove crypto only in the isolated STEP host, leaving ordinary
        // import/source hashing in the outer worker unchanged.
        bytes = Buffer.concat([
          Buffer.from(
            'Object.defineProperty(self, "crypto", { value: undefined });\n',
          ),
          bytes,
        ]);
        mutatedAssets++;
      }
      outgoing.writeHead(upstream.status, headers);
      outgoing.end(bytes);
    } catch {
      outgoing.writeHead(502).end();
    }
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  try {
    await page.goto(
      `http://127.0.0.1:${(proxy.address() as AddressInfo).port}/tools/inspect/`,
    );
    await page.locator("#model-file").setInputFiles({
      name: "refused.step",
      mimeType: "model/step",
      buffer: Buffer.from(cuboidStep()),
    });
    await page.getByRole("button", { name: "Validate and inspect" }).click();
    await expect(page.getByRole("alert")).toContainText(
      mode === "wasm-mismatch"
        ? "STEP runtime integrity check failed."
        : "STEP requires a secure context (HTTPS or localhost) with Web Crypto SHA-256 support.",
      { timeout: 30000 },
    );
    expect(mutatedAssets).toBeGreaterThan(0);
    expect(guardedFactories).toBeGreaterThan(0);
    if (mode === "missing-crypto") {
      await page.locator("#model-file").setInputFiles({
        name: "unaffected.obj",
        mimeType: "text/plain",
        buffer: Buffer.from("v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n"),
      });
      await page.getByRole("button", { name: "Validate and inspect" }).click();
      await expect(
        page.getByRole("button", { name: "Download evidence JSON" }),
      ).toBeEnabled({ timeout: 20000 });
      await page.getByRole("button", { name: "Inspect another model" }).click();
    }
    sabotage = false;
    await page.locator("#model-file").setInputFiles({
      name: "recovered.step",
      mimeType: "model/step",
      buffer: Buffer.from(cuboidStep()),
    });
    await page.getByRole("button", { name: "Validate and inspect" }).click();
    const evidence = page.getByRole("button", {
      name: "Download evidence JSON",
    });
    await expect(evidence).toBeEnabled({ timeout: 60000 });
    const download = page.waitForEvent("download");
    await evidence.click();
    const report = JSON.parse(
      await readFile((await (await download).path())!, "utf8"),
    );
    expect(report.provenance.formatId).toBe("step");
    expect(report.evidence.inspection.summary.triangleCount).toBe(12);
  } finally {
    proxy.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      proxy.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

test("STEP refuses received WASM with a mismatched SHA-256 before factory initialization and recovers", async ({
  page,
  baseURL,
}) => {
  await stepSecurityRefusalAndRecovery(page, baseURL!, "wasm-mismatch");
});

test("STEP requires Web Crypto in its isolated worker while other imports remain usable, then recovers", async ({
  page,
  baseURL,
}) => {
  await stepSecurityRefusalAndRecovery(page, baseURL!, "missing-crypto");
});
