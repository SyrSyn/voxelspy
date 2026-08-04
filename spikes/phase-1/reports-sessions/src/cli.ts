import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { createCanonicalEvidence, sha256 } from "./canonical.js";
import {
  generateDocx,
  generatePdf,
  renderFigureSvg,
  stableJson,
  validateDocx,
  validatePdf,
} from "./export.js";
import { createSession, importSession } from "./session.js";

async function main(): Promise<void> {
  const outputDirectory = resolve(process.argv[2] ?? "artifacts");
  const evidence = createCanonicalEvidence();
  const pdf = generatePdf(evidence.report);
  const docx = generateDocx(evidence.report);
  const session = createSession(evidence);
  validatePdf(pdf);
  validateDocx(docx);
  const imported = importSession(session);
  if (stableJson(imported.report) !== stableJson(evidence.report))
    throw new Error("Generated session did not round-trip");

  const files = new Map<string, Uint8Array | string>([
    ["report.json", stableJson(evidence.report)],
    ["figure.svg", renderFigureSvg(evidence.report.figures[0]!)],
    ["report.pdf", pdf],
    ["report.docx", docx],
    ["review.voxelspy", session],
  ]);
  const checksums = [...files.entries()]
    .map(
      ([name, value]) =>
        `${sha256(typeof value === "string" ? new TextEncoder().encode(value) : value)}  ${name}`,
    )
    .join("\n");
  files.set("SHA256SUMS", `${checksums}\n`);
  await mkdir(outputDirectory, { recursive: true });
  await Promise.all(
    [...files.entries()].map(([name, value]) =>
      writeFile(resolve(outputDirectory, name), value),
    ),
  );
  process.stdout.write(
    `Generated and validated ${files.size} files in ${outputDirectory}\n`,
  );
}

await main();
