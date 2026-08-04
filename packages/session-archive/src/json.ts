const decoder = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();

export function encodeCanonicalJson(value: unknown): Uint8Array {
  return encoder.encode(`${canonicalize(value)}\n`);
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("JSON numbers must be finite");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort(compareOrdinal)
      .map((key) => `${JSON.stringify(key)}:${canonicalize(object[key])}`)
      .join(",")}}`;
  }
  throw new Error("Value is not portable JSON");
}

export function decodeStrictJson(bytes: Uint8Array): unknown {
  let source: string;
  try {
    source = decoder.decode(bytes);
  } catch {
    throw new Error("JSON is not valid UTF-8");
  }
  return new StrictJsonParser(source).parse();
}

class StrictJsonParser {
  private offset = 0;

  public constructor(private readonly source: string) {}

  public parse(): unknown {
    const value = this.readValue();
    this.skipWhitespace();
    if (this.offset !== this.source.length) this.fail("trailing content");
    return value;
  }

  private readValue(): unknown {
    this.skipWhitespace();
    const character = this.source[this.offset];
    if (character === "{") return this.readObject();
    if (character === "[") return this.readArray();
    if (character === '"') return this.readString();
    if (character === "t") return this.readKeyword("true", true);
    if (character === "f") return this.readKeyword("false", false);
    if (character === "n") return this.readKeyword("null", null);
    return this.readNumber();
  }

  private readObject(): Record<string, unknown> {
    this.offset += 1;
    const result = Object.create(null) as Record<string, unknown>;
    const keys = new Set<string>();
    this.skipWhitespace();
    if (this.consume("}")) return result;
    while (true) {
      this.skipWhitespace();
      if (this.source[this.offset] !== '"') this.fail("expected object key");
      const key = this.readString();
      if (keys.has(key))
        this.fail(`duplicate object key ${JSON.stringify(key)}`);
      keys.add(key);
      this.skipWhitespace();
      if (!this.consume(":")) this.fail("expected colon");
      result[key] = this.readValue();
      this.skipWhitespace();
      if (this.consume("}")) return result;
      if (!this.consume(",")) this.fail("expected comma");
    }
  }

  private readArray(): unknown[] {
    this.offset += 1;
    const result: unknown[] = [];
    this.skipWhitespace();
    if (this.consume("]")) return result;
    while (true) {
      result.push(this.readValue());
      this.skipWhitespace();
      if (this.consume("]")) return result;
      if (!this.consume(",")) this.fail("expected comma");
    }
  }

  private readString(): string {
    const start = this.offset;
    this.offset += 1;
    while (this.offset < this.source.length) {
      const character = this.source[this.offset];
      if (character === '"') {
        this.offset += 1;
        try {
          return JSON.parse(this.source.slice(start, this.offset)) as string;
        } catch {
          this.fail("invalid string");
        }
      }
      if (character === "\\") {
        this.offset += 1;
        if (this.source[this.offset] === "u") this.offset += 4;
      } else if (character !== undefined && character.charCodeAt(0) < 0x20) {
        this.fail("control character in string");
      }
      this.offset += 1;
    }
    this.fail("unterminated string");
  }

  private readNumber(): number {
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u.exec(
      this.source.slice(this.offset),
    );
    if (match === null) this.fail("expected value");
    this.offset += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) this.fail("non-finite number");
    return value;
  }

  private readKeyword<T>(keyword: string, value: T): T {
    if (!this.source.startsWith(keyword, this.offset))
      this.fail("expected value");
    this.offset += keyword.length;
    return value;
  }

  private skipWhitespace(): void {
    while (
      this.source[this.offset] === " " ||
      this.source[this.offset] === "\t" ||
      this.source[this.offset] === "\n" ||
      this.source[this.offset] === "\r"
    )
      this.offset += 1;
  }

  private consume(character: string): boolean {
    if (this.source[this.offset] !== character) return false;
    this.offset += 1;
    return true;
  }

  private fail(message: string): never {
    throw new Error(`Invalid JSON at byte ${this.offset}: ${message}`);
  }
}

function compareOrdinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
