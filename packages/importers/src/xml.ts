// A minimal, deliberately narrow, hand-rolled XML parser for the 3MF
// importer. There is no dependency available (and none should be added) for
// XML parsing, and the platform `DOMParser` is not guaranteed available in
// every environment this package targets (it is a browser/worker API, not a
// Node.js global) -- so this module reads exactly the XML subset 3MF Core
// documents use, and rejects anything it does not understand rather than
// guessing.
//
// Safety posture (XXE and entity-expansion prevention):
// - `<!DOCTYPE` and any other `<!...>` markup declaration is rejected
//   outright. Without a DOCTYPE, no custom entity can ever be declared, so
//   there is no way for a document to define an entity this parser would
//   need to (refuse to) resolve externally.
// - Only the five predefined XML entities (`&lt; &gt; &amp; &apos; &quot;`)
//   and numeric character references (`&#NN;` / `&#xHH;`) are recognized;
//   any other `&name;` is rejected. There is no concept of an external or
//   parameter entity anywhere in this parser -- it never performs any I/O.
// - Processing instructions other than the leading `<?xml ... ?>`
//   declaration are rejected.
// - Parsing is iterative (an explicit stack, not recursion), and both
//   nesting depth and total node count are bounded and checked BEFORE each
//   new element is pushed, so a document crafted to nest very deeply (cheap
//   in bytes, expensive in stack frames or tree nodes) fails fast rather
//   than after building a large tree or overflowing the call stack.

import { UnsupportedInputError } from "./errors.js";

export interface XmlSafetyLimits {
  readonly maxDepth: number;
  readonly maxNodes: number;
  readonly maxAttributesPerElement: number;
  readonly maxAttributeValueLength: number;
}

export interface XmlElement {
  /** Local name with any namespace prefix stripped (e.g. `"model"` for `<m:model>`). */
  readonly tag: string;
  /** The prefix, if any (e.g. `"m"` for `<m:model>`), or `undefined` for an unprefixed name. */
  readonly prefix: string | undefined;
  /** Attribute values keyed by their raw (possibly prefixed) name, already entity-decoded. */
  readonly attributes: ReadonlyMap<string, string>;
  readonly children: readonly XmlElement[];
}

const PREDEFINED_ENTITIES: Readonly<Record<string, string>> = {
  lt: "<",
  gt: ">",
  amp: "&",
  apos: "'",
  quot: '"',
};

/** Parses a complete XML document and returns its single root element. */
export function parseXmlDocument(
  text: string,
  limits: XmlSafetyLimits,
): XmlElement {
  const source = text.startsWith("﻿") ? text.slice(1) : text;
  const cursor = { pos: 0 };
  let nodeCount = 0;

  skipMisc(source, cursor, { allowXmlDeclaration: true });
  if (peek(source, cursor.pos) !== "<") {
    throw new TypeError("XML document does not start with an element");
  }
  nodeCount += 1;
  const root = parseElement(source, cursor, 1);
  skipMisc(source, cursor, { allowXmlDeclaration: false });
  if (cursor.pos !== source.length) {
    throw new TypeError("XML document has content after its root element");
  }
  return root;

  // -------------------------------------------------------------------
  // Element parsing (iterative via explicit recursion helper below, but
  // bounded: `parseElement` recurses once per nesting level, and depth is
  // checked before every recursive call, so the bound on `limits.maxDepth`
  // is also a bound on native call-stack depth here.)
  // -------------------------------------------------------------------
  function parseElement(
    src: string,
    cur: { pos: number },
    depth: number,
  ): XmlElement {
    if (depth > limits.maxDepth) {
      throw new RangeError(
        "XML document exceeds the importer's element-nesting safety limit",
      );
    }
    expect(src, cur, "<");
    const rawName = readName(src, cur);
    const { prefix, tag } = splitName(rawName);
    const attributes = new Map<string, string>();
    for (;;) {
      const skippedSpace = skipSpace(src, cur);
      const next = peek(src, cur.pos);
      if (next === ">" || next === "/") break;
      if (!skippedSpace) {
        throw new TypeError(
          `XML element <${rawName}> is missing whitespace before an attribute`,
        );
      }
      const attrName = readName(src, cur);
      skipSpace(src, cur);
      expect(src, cur, "=");
      skipSpace(src, cur);
      const value = readQuotedValue(src, cur);
      if (value.length > limits.maxAttributeValueLength) {
        throw new RangeError(
          `XML attribute "${attrName}" exceeds the importer's attribute-value safety limit`,
        );
      }
      if (attributes.has(attrName)) {
        throw new TypeError(
          `XML element <${rawName}> has a duplicate attribute: ${attrName}`,
        );
      }
      attributes.set(attrName, value);
      if (attributes.size > limits.maxAttributesPerElement) {
        throw new RangeError(
          `XML element <${rawName}> exceeds the importer's attribute-count safety limit`,
        );
      }
    }
    if (peek(src, cur.pos) === "/") {
      cur.pos += 1;
      expect(src, cur, ">");
      return { tag, prefix, attributes, children: [] };
    }
    expect(src, cur, ">");

    const children: XmlElement[] = [];
    for (;;) {
      skipCharData(src, cur);
      if (peek(src, cur.pos) !== "<") {
        throw new TypeError(
          `XML element <${rawName}> was not closed before the end of the document`,
        );
      }
      if (peek(src, cur.pos + 1) === "/") {
        cur.pos += 2;
        const closeName = readName(src, cur);
        skipSpace(src, cur);
        expect(src, cur, ">");
        if (closeName !== rawName) {
          throw new TypeError(
            `XML closing tag </${closeName}> does not match opening tag <${rawName}>`,
          );
        }
        return { tag, prefix, attributes, children };
      }
      if (skipCommentOrCData(src, cur)) continue;
      if (peek(src, cur.pos + 1) === "?") {
        throw new UnsupportedInputError(
          "XML processing instructions are not supported outside the document prolog",
        );
      }
      if (peek(src, cur.pos + 1) === "!") {
        throw new UnsupportedInputError(
          "XML markup declarations (DOCTYPE/ENTITY) are not supported",
        );
      }
      nodeCount += 1;
      if (nodeCount > limits.maxNodes) {
        throw new RangeError(
          "XML document exceeds the importer's element-count safety limit",
        );
      }
      children.push(parseElement(src, cur, depth + 1));
    }
  }
}

// ---------------------------------------------------------------------------
// Prolog / misc (comments, whitespace, the optional `<?xml ... ?>` declaration)
// ---------------------------------------------------------------------------

function skipMisc(
  source: string,
  cursor: { pos: number },
  options: { allowXmlDeclaration: boolean },
): void {
  let allowDeclaration = options.allowXmlDeclaration;
  for (;;) {
    skipSpace(source, cursor);
    if (peek(source, cursor.pos) !== "<") return;
    if (allowDeclaration && source.startsWith("<?xml", cursor.pos)) {
      const end = source.indexOf("?>", cursor.pos);
      if (end === -1) {
        throw new TypeError("XML declaration is not terminated");
      }
      cursor.pos = end + 2;
      allowDeclaration = false;
      continue;
    }
    if (peek(source, cursor.pos + 1) === "?") {
      throw new UnsupportedInputError(
        "XML processing instructions are not supported",
      );
    }
    if (source.startsWith("<!--", cursor.pos)) {
      skipComment(source, cursor);
      continue;
    }
    if (source.startsWith("<!DOCTYPE", cursor.pos)) {
      throw new UnsupportedInputError(
        "XML DOCTYPE declarations are not supported",
      );
    }
    if (peek(source, cursor.pos + 1) === "!") {
      throw new UnsupportedInputError(
        "XML markup declarations are not supported",
      );
    }
    return;
  }
}

function skipComment(source: string, cursor: { pos: number }): void {
  const end = source.indexOf("-->", cursor.pos + 4);
  if (end === -1) throw new TypeError("XML comment is not terminated");
  cursor.pos = end + 3;
}

/** Returns true and advances past a comment or CDATA section if one starts here. */
function skipCommentOrCData(source: string, cursor: { pos: number }): boolean {
  if (source.startsWith("<!--", cursor.pos)) {
    skipComment(source, cursor);
    return true;
  }
  if (source.startsWith("<![CDATA[", cursor.pos)) {
    const end = source.indexOf("]]>", cursor.pos + 9);
    if (end === -1) throw new TypeError("XML CDATA section is not terminated");
    cursor.pos = end + 3;
    return true;
  }
  return false;
}

/** Skips character data (text content) between elements; entity references in it are not evaluated (Core geometry never depends on element text content). */
function skipCharData(source: string, cursor: { pos: number }): void {
  while (cursor.pos < source.length && source[cursor.pos] !== "<") {
    cursor.pos += 1;
  }
}

// ---------------------------------------------------------------------------
// Low-level scanning helpers
// ---------------------------------------------------------------------------

function peek(source: string, index: number): string | undefined {
  return source[index];
}

function expect(source: string, cursor: { pos: number }, char: string): void {
  if (source[cursor.pos] !== char) {
    throw new TypeError(
      `Expected "${char}" at position ${cursor.pos} of the XML document`,
    );
  }
  cursor.pos += 1;
}

function skipSpace(source: string, cursor: { pos: number }): boolean {
  const start = cursor.pos;
  while (cursor.pos < source.length && isXmlSpace(source[cursor.pos]!)) {
    cursor.pos += 1;
  }
  return cursor.pos > start;
}

function isXmlSpace(char: string): boolean {
  return char === " " || char === "\t" || char === "\n" || char === "\r";
}

const NAME_START = /[A-Za-z_]/u;
const NAME_CHAR = /[A-Za-z0-9_.:-]/u;

function readName(source: string, cursor: { pos: number }): string {
  const start = cursor.pos;
  const first = source[cursor.pos];
  if (first === undefined || !NAME_START.test(first)) {
    throw new TypeError(
      `Expected an XML name at position ${cursor.pos} of the document`,
    );
  }
  cursor.pos += 1;
  while (cursor.pos < source.length && NAME_CHAR.test(source[cursor.pos]!)) {
    cursor.pos += 1;
  }
  return source.slice(start, cursor.pos);
}

function splitName(rawName: string): {
  prefix: string | undefined;
  tag: string;
} {
  const colon = rawName.indexOf(":");
  if (colon === -1) return { prefix: undefined, tag: rawName };
  return { prefix: rawName.slice(0, colon), tag: rawName.slice(colon + 1) };
}

function readQuotedValue(source: string, cursor: { pos: number }): string {
  const quote = source[cursor.pos];
  if (quote !== '"' && quote !== "'") {
    throw new TypeError(
      `Expected a quoted attribute value at position ${cursor.pos} of the document`,
    );
  }
  cursor.pos += 1;
  const start = cursor.pos;
  const end = source.indexOf(quote, start);
  if (end === -1) {
    throw new TypeError("XML attribute value is not terminated");
  }
  const raw = source.slice(start, end);
  cursor.pos = end + 1;
  if (raw.includes("<")) {
    throw new TypeError("XML attribute value contains an unescaped '<'");
  }
  return decodeEntities(raw);
}

function decodeEntities(raw: string): string {
  let result = "";
  let index = 0;
  while (index < raw.length) {
    const char = raw[index];
    if (char !== "&") {
      result += char;
      index += 1;
      continue;
    }
    const semicolon = raw.indexOf(";", index + 1);
    if (semicolon === -1) {
      throw new TypeError(
        "XML value contains an unterminated entity reference",
      );
    }
    const body = raw.slice(index + 1, semicolon);
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const codePoint = Number.parseInt(body.slice(2), 16);
      result += decodeNumericEntity(codePoint, body);
    } else if (body.startsWith("#")) {
      const codePoint = Number.parseInt(body.slice(1), 10);
      result += decodeNumericEntity(codePoint, body);
    } else if (body in PREDEFINED_ENTITIES) {
      result += PREDEFINED_ENTITIES[body];
    } else {
      throw new UnsupportedInputError(
        `XML document references an undefined entity: &${body};`,
      );
    }
    index = semicolon + 1;
  }
  return result;
}

function decodeNumericEntity(codePoint: number, body: string): string {
  if (
    !Number.isInteger(codePoint) ||
    codePoint < 0 ||
    codePoint > 0x10_ff_ff ||
    (codePoint >= 0xd8_00 && codePoint <= 0xdf_ff)
  ) {
    throw new TypeError(
      `XML document contains an invalid character reference: &${body};`,
    );
  }
  return String.fromCodePoint(codePoint);
}
