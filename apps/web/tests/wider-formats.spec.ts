import { expect, test, type Page } from "@playwright/test";

/**
 * Browser coverage for voxelspy-ft9.6.13: `@voxelspy/importers` reads STL,
 * OBJ, glTF, GLB, and 3MF, but every tool's file input, capability
 * preflight, and copy used to hard-code "STL and OBJ" only, making the wider
 * capability unreachable from the UI. This file exercises the two newly
 * reachable formats end to end through real tools -- Inspect for GLB,
 * File Forensics for 3MF -- and asserts an unsupported extension is refused
 * with an honest message naming what is actually supported, complementing
 * the unit coverage in `src/formats.test.ts` (the shared accepted-format
 * helper itself) and the existing STL/OBJ coverage in `tests/inspect.spec.ts`
 * / `tests/forensics.spec.ts`.
 *
 * Both fixtures are generated in code, mirroring how
 * `packages/importers/test/gltf.test.ts` and `.../test/threemf.test.ts`
 * build their own minimal fixtures -- nothing here is a committed binary
 * file.
 */

// ---------------------------------------------------------------------------
// Minimal GLB fixture: one triangle, embedded binary buffer, no extensions.
// Trimmed from packages/importers/test/gltf.test.ts's own fixture builders.
// ---------------------------------------------------------------------------

function packFloat32(values: readonly number[]): Uint8Array {
  const bytes = new Uint8Array(values.length * 4);
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) => view.setFloat32(index * 4, value, true));
  return bytes;
}

function packUint16(values: readonly number[]): Uint8Array {
  const bytes = new Uint8Array(values.length * 2);
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) => view.setUint16(index * 2, value, true));
  return bytes;
}

function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

function pad4(bytes: Uint8Array, fill: number): Uint8Array {
  const remainder = bytes.byteLength % 4;
  if (remainder === 0) return bytes;
  return concatBytes(bytes, new Uint8Array(4 - remainder).fill(fill));
}

const GLB_MAGIC = 0x46_54_6c_67;
const GLB_JSON_CHUNK_TYPE = 0x4e_4f_53_4a;
const GLB_BIN_CHUNK_TYPE = 0x00_4e_49_42;

/**
 * One triangle at (0,0,0), (2,0,0), (0,3,0) in the file's own metres,
 * right-handed Y-up frame -- a flat (z=0) shape chosen so the resulting
 * canonical-frame bounding box is easy to predict by hand:
 * `normalizePositions`'s Y-up conversion sends (x, y, 0) to
 * (x, 0, y) millimetres after the metre->millimetre scale, so this becomes a
 * 2000 x 0 x 3000 mm bounding box once imported.
 */
function buildMinimalGlb(): Buffer {
  const positions = [0, 0, 0, 2, 0, 0, 0, 3, 0];
  const indices = [0, 1, 2];
  const positionBytes = packFloat32(positions);
  const indexBytes = packUint16(indices);
  const bufferBytes = concatBytes(positionBytes, indexBytes);
  const doc = {
    asset: { version: "2.0" },
    buffers: [{ byteLength: bufferBytes.byteLength }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: positionBytes.byteLength },
      {
        buffer: 0,
        byteOffset: positionBytes.byteLength,
        byteLength: indexBytes.byteLength,
      },
    ],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: positions.length / 3,
        type: "VEC3",
      },
      {
        bufferView: 1,
        componentType: 5123,
        count: indices.length,
        type: "SCALAR",
      },
    ],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    nodes: [{ mesh: 0 }],
    scenes: [{ nodes: [0] }],
    scene: 0,
  };
  const json = pad4(new TextEncoder().encode(JSON.stringify(doc)), 0x20);
  const bin = pad4(bufferBytes, 0x00);
  const totalLength = 12 + 8 + json.byteLength + 8 + bin.byteLength;
  const out = new Uint8Array(totalLength);
  const view = new DataView(out.buffer);
  view.setUint32(0, GLB_MAGIC, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, totalLength, true);
  view.setUint32(12, json.byteLength, true);
  view.setUint32(16, GLB_JSON_CHUNK_TYPE, true);
  out.set(json, 20);
  let offset = 20 + json.byteLength;
  view.setUint32(offset, bin.byteLength, true);
  view.setUint32(offset + 4, GLB_BIN_CHUNK_TYPE, true);
  out.set(bin, offset + 8);
  return Buffer.from(out);
}

// ---------------------------------------------------------------------------
// Minimal 3MF fixture: a genuine ZIP (OPC) container, stored (uncompressed)
// entries only -- 3MF's decompression path is already covered by
// packages/importers/test/threemf.test.ts, so this fixture only needs to be
// a valid archive, not exercise deflate. Trimmed from that file's own ZIP
// builder.
// ---------------------------------------------------------------------------

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) !== 0 ? 0xed_b8_83_20 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xff_ff_ff_ff;
  for (let index = 0; index < bytes.byteLength; index += 1) {
    crc = CRC32_TABLE[(crc ^ bytes[index]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xff_ff_ff_ff) >>> 0;
}

function buildStoredZip(
  entries: readonly { name: string; data: Uint8Array }[],
): Buffer {
  const encoder = new TextEncoder();
  const localChunks: Uint8Array[] = [];
  const localOffsets: number[] = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    const header = new Uint8Array(30);
    const view = new DataView(header.buffer);
    view.setUint32(0, 0x04_03_4b_50, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, 0, true);
    view.setUint16(8, 0, true); // method 0: stored
    view.setUint16(10, 0, true);
    view.setUint16(12, 0, true);
    view.setUint32(14, crc32(entry.data), true);
    view.setUint32(18, entry.data.byteLength, true);
    view.setUint32(22, entry.data.byteLength, true);
    view.setUint16(26, nameBytes.byteLength, true);
    view.setUint16(28, 0, true);
    localOffsets.push(offset);
    localChunks.push(header, nameBytes, entry.data);
    offset += header.byteLength + nameBytes.byteLength + entry.data.byteLength;
  }

  const centralChunks: Uint8Array[] = [];
  const centralOffset = offset;
  entries.forEach((entry, index) => {
    const nameBytes = encoder.encode(entry.name);
    const header = new Uint8Array(46);
    const view = new DataView(header.buffer);
    view.setUint32(0, 0x02_01_4b_50, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, 20, true);
    view.setUint16(8, 0, true);
    view.setUint16(10, 0, true);
    view.setUint16(12, 0, true);
    view.setUint16(14, 0, true);
    view.setUint32(16, crc32(entry.data), true);
    view.setUint32(20, entry.data.byteLength, true);
    view.setUint32(24, entry.data.byteLength, true);
    view.setUint16(28, nameBytes.byteLength, true);
    view.setUint16(30, 0, true);
    view.setUint16(32, 0, true);
    view.setUint16(34, 0, true);
    view.setUint16(36, 0, true);
    view.setUint32(38, 0, true);
    view.setUint32(42, localOffsets[index]!, true);
    centralChunks.push(header, nameBytes);
    offset += header.byteLength + nameBytes.byteLength;
  });

  const centralSize = offset - centralOffset;
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06_05_4b_50, true);
  endView.setUint16(4, 0, true);
  endView.setUint16(6, 0, true);
  endView.setUint16(8, entries.length, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, centralOffset, true);
  endView.setUint16(20, 0, true);

  return Buffer.from(concatBytes(...localChunks, ...centralChunks, end));
}

const CORE_NS = "http://schemas.microsoft.com/3dmanufacturing/core/2015/02";
const MODEL_REL_TYPE =
  "http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel";
const MODEL_CONTENT_TYPE =
  "application/vnd.ms-package.3dmanufacturing-3dmodel+xml";

/** A single-triangle 3MF Core document with no `unit` attribute, so the
 *  format's own spec default ("millimeter") applies -- an "embedded"
 *  resolution exactly like a file that states it explicitly. */
function buildMinimal3mf(): Buffer {
  const encoder = new TextEncoder();
  const relsXml =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rel1" Type="${MODEL_REL_TYPE}" Target="/3D/3dmodel.model"/>` +
    `</Relationships>`;
  const contentTypesXml =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="model" ContentType="${MODEL_CONTENT_TYPE}"/>` +
    `</Types>`;
  const modelXml =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<model xmlns="${CORE_NS}">` +
    `<resources>` +
    `<object id="1" type="model">` +
    `<mesh><vertices>` +
    `<vertex x="0" y="0" z="0"/>` +
    `<vertex x="10" y="0" z="0"/>` +
    `<vertex x="0" y="10" z="0"/>` +
    `</vertices><triangles>` +
    `<triangle v1="0" v2="1" v3="2"/>` +
    `</triangles></mesh>` +
    `</object>` +
    `</resources>` +
    `<build><item objectid="1"/></build>` +
    `</model>`;
  return buildStoredZip([
    { name: "_rels/.rels", data: encoder.encode(relsXml) },
    { name: "[Content_Types].xml", data: encoder.encode(contentTypesXml) },
    { name: "3D/3dmodel.model", data: encoder.encode(modelXml) },
  ]);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function chooseFile(
  page: Page,
  inputSelector: string,
  name: string,
  buffer: Buffer,
) {
  await page.locator(inputSelector).setInputFiles({
    name,
    mimeType: "application/octet-stream",
    buffer,
  });
}

test("Inspect imports a GLB end to end and resolves its declared metre, right-handed Y-up frame from the file, not a default", async ({
  page,
}) => {
  await page.goto("/tools/inspect/");
  await chooseFile(page, "#model-file", "triangle.glb", buildMinimalGlb());

  const inspectButton = page.getByRole("button", {
    name: "Validate and inspect",
  });
  await expect(inspectButton).toBeEnabled();
  // The pre-import capability message must not claim the user chose a value
  // the file itself declares.
  await expect(page.locator(".capability-ready")).toContainText(
    "this file's own declared source frame",
  );
  await inspectButton.click();

  await expect(
    page.getByRole("heading", { level: 2, name: "triangle.glb" }),
  ).toBeVisible({ timeout: 20_000 });

  const measurements = page.locator(
    '[aria-labelledby="inspect-measurements-title"]',
  );
  await expect(
    measurements.locator('[role="row"]', { hasText: "Dimensions (mm)" }),
  ).toContainText("2,000");
  await expect(
    measurements.locator('[role="row"]', { hasText: "Dimensions (mm)" }),
  ).toContainText("3,000");
  await expect(
    measurements.locator('[role="row"]', { hasText: "Triangles (placed)" }),
  ).toContainText("1");

  // Provenance: glTF/GLB's frame is resolved from the format itself
  // ("embedded"), never defaulted the way STL/OBJ start -- both the detected
  // and resolved values must say so.
  await page.getByText("Provenance & interpretation").click();
  const provenance = page.locator(".technical-details");
  await expect(provenance).toContainText("glb");
  await expect(provenance).toContainText("Detected unit");
  await expect(provenance.locator("dd", { hasText: "Metres" })).not.toHaveCount(
    0,
  );
  await expect(provenance).toContainText("Right-handed, Y up");
  await expect(provenance).toContainText("embedded in the file");
  // Never claims this was a user or default choice.
  await expect(provenance).not.toContainText("import default");
  await expect(provenance).not.toContainText("expert override");
});

test("File Forensics imports a 3MF end to end and reports its embedded unit/axis declaration", async ({
  page,
}) => {
  await page.goto("/tools/file-forensics/");
  await chooseFile(
    page,
    "#forensics-model-file",
    "triangle.3mf",
    buildMinimal3mf(),
  );

  const analyzeButton = page.getByRole("button", {
    name: "Validate and analyze",
  });
  await expect(analyzeButton).toBeEnabled();
  await analyzeButton.click();

  await expect(
    page.getByRole("heading", { level: 2, name: "triangle.3mf" }),
  ).toBeVisible({ timeout: 20_000 });

  const identity = page.locator('[aria-labelledby="forensics-identity-title"]');
  await expect(identity).toContainText("3MF");

  const structure = page.locator(
    '[aria-labelledby="forensics-structure-title"]',
  );
  await expect(structure).toContainText(
    "1 triangle placed of the importer’s 500,000-triangle ceiling.",
  );

  // 3MF declares its own unit (millimetre, the spec default here, since the
  // fixture's <model> carries no unit attribute) and right-handed Z-up by
  // specification -- both resolved as "embedded", never a default the app
  // supplied and never something the user chose.
  const frame = page.locator('[aria-labelledby="forensics-frame-title"]');
  await expect(frame).toContainText("Millimetres (embedded in the file)");
  await expect(frame).toContainText(
    "Right-handed, Z up (embedded in the file)",
  );
  await expect(frame).not.toContainText("import default");
  await expect(frame).not.toContainText("expert override");
});

test("an unsupported file extension is refused with an honest message naming what is supported, and the tool stays usable", async ({
  page,
}) => {
  await page.goto("/tools/inspect/");
  await chooseFile(
    page,
    "#model-file",
    "part.step",
    Buffer.from("not a supported format"),
  );

  const inspectButton = page.getByRole("button", {
    name: "Validate and inspect",
  });
  await expect(inspectButton).toBeDisabled();
  await expect(page.locator(".capability")).toContainText(
    "This release supports STL, OBJ, glTF, GLB, or 3MF mesh files",
  );
  await expect(page.locator(".capability")).toContainText(
    "(.stl, .obj, .gltf, .glb, .3mf)",
  );

  // The tool stays usable: a supported file right after still works.
  await chooseFile(page, "#model-file", "triangle.glb", buildMinimalGlb());
  await expect(inspectButton).toBeEnabled();
  await inspectButton.click();
  await expect(
    page.getByRole("heading", { level: 2, name: "triangle.glb" }),
  ).toBeVisible({ timeout: 20_000 });
});
