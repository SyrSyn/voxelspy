export interface ParsedMesh {
  readonly positions: number[] | Float64Array;
  readonly indices: Uint32Array;
  readonly notes: string[];
  readonly polygonCount?: number;
  readonly ignoredDirectives?: readonly string[];
}

const DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u;

export function parseFiniteDecimal(value: string, context: string): number {
  if (!DECIMAL.test(value)) throw new TypeError(`${context} is not a decimal`);
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new TypeError(`${context} is not finite`);
  return parsed;
}

export function decodeUtf8(bytes: Uint8Array, format: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new TypeError(`${format} input is not valid UTF-8`);
  }
}

export function* linesOf(text: string): Generator<string> {
  let start = 0;
  while (start <= text.length) {
    const newline = text.indexOf("\n", start);
    const end = newline === -1 ? text.length : newline;
    const contentEnd =
      end > start && text.charCodeAt(end - 1) === 13 ? end - 1 : end;
    yield text.slice(start, contentEnd);
    if (newline === -1) break;
    start = newline + 1;
  }
}

export function checkedTriangleCount(
  count: number,
  callerLimit: number,
  safetyLimit: number,
): void {
  if (!Number.isSafeInteger(count) || count <= 0) {
    throw new TypeError("Geometry must contain at least one complete triangle");
  }
  if (count > callerLimit) {
    throw new RangeError("Geometry exceeds the caller-provided triangle limit");
  }
  if (count > safetyLimit) {
    throw new RangeError("Geometry exceeds the importer safety limit");
  }
}
