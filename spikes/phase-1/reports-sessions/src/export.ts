import { strToU8, unzipSync, zipSync } from "fflate";

import { parseReport, type FigureInput, type Report } from "./schema.js";

const encoder = new TextEncoder();
const fixedZipDate = new Date("1980-01-01T00:00:00.000Z");

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function pdfText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[^\x20-\x7e]/g, "?")
    .replaceAll("\\", "\\\\")
    .replaceAll("(", "\\(")
    .replaceAll(")", "\\)");
}

function colorParts(hex: string): readonly [number, number, number] {
  return [
    Number.parseInt(hex.slice(1, 3), 16) / 255,
    Number.parseInt(hex.slice(3, 5), 16) / 255,
    Number.parseInt(hex.slice(5, 7), 16) / 255,
  ];
}

export function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function renderFigureSvg(figure: FigureInput): string {
  const body = figure.primitives
    .map((primitive) => {
      if (primitive.kind === "line") {
        return `<line x1="${primitive.from[0]}" y1="${primitive.from[1]}" x2="${primitive.to[0]}" y2="${primitive.to[1]}" stroke="${primitive.color}" stroke-width="${primitive.width}" />`;
      }
      return `<text x="${primitive.at[0]}" y="${primitive.at[1]}" fill="${primitive.color}" font-family="sans-serif" font-size="16">${xmlEscape(primitive.text)}</text>`;
    })
    .join("\n  ");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${figure.width}" height="${figure.height}" viewBox="0 0 ${figure.width} ${figure.height}">
  <rect width="100%" height="100%" fill="#ffffff" />
  ${body}
</svg>\n`;
}

function buildPdfObjects(report: Report): string[] {
  const figure = report.figures[0];
  if (figure === undefined) throw new Error("At least one figure is required");
  const lines: string[] = [
    "BT /F1 18 Tf 54 738 Td",
    `(${pdfText(report.title)}) Tj`,
    "0 -28 Td /F1 10 Tf",
    `(Report schema v${report.schemaVersion}; generated ${pdfText(report.generatedAt)}) Tj`,
    "0 -28 Td /F1 13 Tf (Findings) Tj",
  ];
  for (const finding of report.findings) {
    lines.push(
      `0 -18 Td /F1 10 Tf (${pdfText(`[${finding.severity}] ${finding.title}: ${finding.summary}`)}) Tj`,
    );
  }
  lines.push("0 -28 Td /F1 13 Tf (Markups) Tj");
  for (const markup of report.markups) {
    const description =
      markup.type === "callout"
        ? markup.text
        : `${markup.label}: ${markup.value} ${markup.unit}`;
    lines.push(`0 -18 Td /F1 10 Tf (${pdfText(description)}) Tj`);
  }
  lines.push("ET");

  const scale = Math.min(500 / figure.width, 250 / figure.height);
  const originX = 54;
  const originY = 80;
  for (const primitive of figure.primitives) {
    const [red, green, blue] = colorParts(primitive.color);
    if (primitive.kind === "line") {
      const x1 = originX + primitive.from[0] * scale;
      const y1 = originY + (figure.height - primitive.from[1]) * scale;
      const x2 = originX + primitive.to[0] * scale;
      const y2 = originY + (figure.height - primitive.to[1]) * scale;
      lines.push(
        `${red.toFixed(4)} ${green.toFixed(4)} ${blue.toFixed(4)} RG ${primitive.width.toFixed(2)} w ${x1.toFixed(2)} ${y1.toFixed(2)} m ${x2.toFixed(2)} ${y2.toFixed(2)} l S`,
      );
    } else {
      const x = originX + primitive.at[0] * scale;
      const y = originY + (figure.height - primitive.at[1]) * scale;
      lines.push(
        `BT ${red.toFixed(4)} ${green.toFixed(4)} ${blue.toFixed(4)} rg /F1 8 Tf ${x.toFixed(2)} ${y.toFixed(2)} Td (${pdfText(primitive.text)}) Tj ET`,
      );
    }
  }
  const stream = `${lines.join("\n")}\n`;
  return [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    `<< /Length ${encoder.encode(stream).byteLength} >>\nstream\n${stream}endstream`,
    `<< /Title (${pdfText(report.title)}) /Producer (VoxelSpy reports spike) /CreationDate (D:20250101000000Z) /ModDate (D:20250101000000Z) >>`,
  ];
}

export function generatePdf(input: Report): Uint8Array {
  const report = parseReport(input);
  const objects = buildPdfObjects(report);
  let output = "%PDF-1.7\n%????\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(encoder.encode(output).byteLength);
    output += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xrefOffset = encoder.encode(output).byteLength;
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  output += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return encoder.encode(output);
}

function paragraph(text: string, style?: string): string {
  const paragraphStyle =
    style === undefined ? "" : `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>`;
  return `<w:p>${paragraphStyle}<w:r><w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r></w:p>`;
}

function documentXml(report: Report): string {
  const paragraphs = [
    paragraph(report.title, "Title"),
    paragraph(
      `Report schema v${report.schemaVersion}; generated ${report.generatedAt}`,
    ),
    paragraph("Findings", "Heading1"),
    ...report.findings.map((finding) =>
      paragraph(`[${finding.severity}] ${finding.title}: ${finding.summary}`),
    ),
    paragraph("Markups", "Heading1"),
    ...report.markups.map((markup) =>
      paragraph(
        markup.type === "callout"
          ? markup.text
          : `${markup.label}: ${markup.value} ${markup.unit}`,
      ),
    ),
    paragraph("Saved review state", "Heading1"),
    paragraph(
      `Active view: ${report.review.activeViewId}; status: ${report.review.status}`,
    ),
    paragraph(report.review.notes),
    paragraph("Figure", "Heading1"),
    `<w:p><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="5486400" cy="3086100"/><wp:docPr id="1" name="Comparison figure"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="1" name="figure.svg"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rIdFigure"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="5486400" cy="3086100"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`,
  ];
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>${paragraphs.join("")}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`;
}

function zipEntry(value: string): [Uint8Array, { mtime: Date }] {
  return [strToU8(value), { mtime: fixedZipDate }];
}

export function generateDocx(input: Report): Uint8Array {
  const report = parseReport(input);
  const figure = report.figures[0];
  if (figure === undefined) throw new Error("At least one figure is required");
  return zipSync(
    {
      "[Content_Types].xml": zipEntry(
        `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="svg" ContentType="image/svg+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`,
      ),
      _rels: {
        ".rels": zipEntry(
          `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`,
        ),
      },
      docProps: {
        "core.xml": zipEntry(
          `<?xml version="1.0" encoding="UTF-8"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xmlEscape(report.title)}</dc:title><dc:creator>VoxelSpy</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${report.generatedAt}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${report.generatedAt}</dcterms:modified></cp:coreProperties>`,
        ),
        "app.xml": zipEntry(
          `<?xml version="1.0" encoding="UTF-8"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>VoxelSpy</Application></Properties>`,
        ),
      },
      word: {
        "document.xml": zipEntry(documentXml(report)),
        "styles.xml": zipEntry(
          `<?xml version="1.0" encoding="UTF-8"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:sz w:val="36"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:sz w:val="28"/></w:rPr></w:style></w:styles>`,
        ),
        _rels: {
          "document.xml.rels": zipEntry(
            `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rIdFigure" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/figure.svg"/></Relationships>`,
          ),
        },
        media: { "figure.svg": zipEntry(renderFigureSvg(figure)) },
      },
    },
    { level: 6 },
  );
}

export function validatePdf(bytes: Uint8Array): void {
  const value = new TextDecoder().decode(bytes);
  if (
    !value.startsWith("%PDF-1.7") ||
    !value.endsWith("%%EOF\n") ||
    !/xref\n0 7\n/.test(value) ||
    !/trailer\n<< \/Size 7 \/Root 1 0 R/.test(value)
  ) {
    throw new Error(
      "Generated PDF does not contain the expected PDF structure",
    );
  }
}

export function validateDocx(bytes: Uint8Array): void {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch (error) {
    throw new Error("Generated DOCX is not a readable OOXML package", {
      cause: error,
    });
  }
  const required = [
    "[Content_Types].xml",
    "_rels/.rels",
    "word/document.xml",
    "word/styles.xml",
    "word/_rels/document.xml.rels",
    "word/media/figure.svg",
  ];
  for (const path of required) {
    if (files[path] === undefined)
      throw new Error(`Generated DOCX is missing ${path}`);
  }
  const document = new TextDecoder().decode(files["word/document.xml"]);
  if (
    !document.includes("<w:document") ||
    !document.includes("<w:t") ||
    !document.includes('r:embed="rIdFigure"')
  ) {
    throw new Error(
      "Generated DOCX lacks editable text or its figure relationship",
    );
  }
}
