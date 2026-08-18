import { describe, expect, it } from "vitest";

import { decodeStrictJson, encodeCanonicalJson } from "../src/json.js";

const encoder = new TextEncoder();
function text(value: string): Uint8Array {
  return encoder.encode(value);
}

describe("strict JSON parser: numeric edge cases", () => {
  it("rejects the NaN literal", () => {
    expect(() => decodeStrictJson(text('{"x":NaN}'))).toThrow(/Invalid JSON/u);
  });

  it("rejects the Infinity literal", () => {
    expect(() => decodeStrictJson(text('{"x":Infinity}'))).toThrow(
      /Invalid JSON/u,
    );
  });

  it("rejects the -Infinity literal", () => {
    expect(() => decodeStrictJson(text('{"x":-Infinity}'))).toThrow(
      /Invalid JSON/u,
    );
  });

  it(
    "accepts an integer literal past Number.MAX_SAFE_INTEGER but silently " +
      "rounds it, same as JSON.parse (pinned current behavior)",
    () => {
      // 9007199254740993 = 2**53 + 1, which IEEE-754 doubles cannot represent
      // exactly; it rounds to the nearest representable double, 2**53 itself
      // (9007199254740992) -- which is still one past Number.MAX_SAFE_INTEGER
      // (2**53 - 1), so the rounded value remains unsafe too. The strict
      // parser only rejects non-finite numbers (readNumber), not unsafe
      // integers, so this is accepted-but-rounded rather than rejected. That
      // is an asymmetry with the rest of this package: most numeric contract
      // fields require z.number().int().safe(), so a byte stream carrying an
      // out-of-range literal for one of those fields passes decodeStrictJson
      // and only fails later at schema validation against the *rounded*
      // value, not the original one -- there is no parse-time signal that
      // truncation occurred. This test pins today's behavior; it is not a
      // correctness requirement, since the JSON grammar itself has no
      // concept of "unsafe integer".
      const parsed = decodeStrictJson(text('{"x":9007199254740993}')) as Record<
        string,
        unknown
      >;
      expect(parsed.x).toBe(9007199254740992);
      expect(Number.isSafeInteger(parsed.x as number)).toBe(false);
    },
  );
});

describe("strict JSON parser: duplicate keys", () => {
  it("rejects duplicate keys at the top level", () => {
    expect(() => decodeStrictJson(text('{"a":1,"a":2}'))).toThrow(
      /duplicate object key/u,
    );
  });

  it("rejects duplicate keys nested inside an object value", () => {
    expect(() => decodeStrictJson(text('{"a":{"b":1,"c":2,"b":3}}'))).toThrow(
      /duplicate object key/u,
    );
  });

  it("rejects duplicate keys nested inside an array of objects", () => {
    expect(() =>
      decodeStrictJson(text('{"a":[{"b":1},{"b":2,"b":3}]}')),
    ).toThrow(/duplicate object key/u);
  });

  it("does not confuse same-named keys in sibling objects for duplicates", () => {
    const parsed = decodeStrictJson(
      text('{"a":{"b":1},"c":{"b":2}}'),
    ) as Record<string, Record<string, unknown>>;
    expect(parsed.a?.b).toBe(1);
    expect(parsed.c?.b).toBe(2);
  });
});

describe("strict JSON parser: lone surrogates", () => {
  it("accepts a lone (unpaired) surrogate escape inside a string", () => {
    // JSON's grammar permits any \\uXXXX escape, including unpaired
    // surrogates -- the same behavior as the platform JSON.parse, which this
    // parser's string reader delegates to. The result is a JS string
    // containing an unpaired UTF-16 code unit.
    const parsed = decodeStrictJson(text('{"x":"\\ud800"}')) as Record<
      string,
      unknown
    >;
    expect(parsed.x).toBe("\ud800");
    expect((parsed.x as string).length).toBe(1);
  });

  it(
    "round-trips a lone surrogate losslessly through encodeCanonicalJson " +
      "(pinned: escaping, not TextEncoder's U+FFFD fallback, is why)",
    () => {
      // encodeCanonicalJson ends with TextEncoder#encode, and the WHATWG
      // encoding spec requires TextEncoder to replace any *literal* unpaired
      // surrogate character with U+FFFD rather than throw. That hazard does
      // not actually bite here: canonicalize() calls JSON.stringify() on
      // each string first, and since ES2019, JSON.stringify itself escapes
      // unpaired surrogates to an ASCII-safe "\\uXXXX" sequence rather than
      // emitting the raw code unit -- so by the time TextEncoder runs, the
      // text is plain ASCII and nothing gets replaced. This test pins that
      // the two-stage pipeline (JSON.stringify, then TextEncoder) is safe
      // here specifically *because* of that ES2019 stringify behavior, not
      // because TextEncoder was given the lone surrogate directly.
      const reencoded = encodeCanonicalJson({ x: "\ud800" });
      const decoded = new TextDecoder().decode(reencoded);
      expect(decoded).toBe('{"x":"\\ud800"}\n');
      const parsedBack = decodeStrictJson(reencoded) as Record<string, unknown>;
      expect(parsedBack.x).toBe("\ud800");
    },
  );
});

describe("strict JSON parser: __proto__ handling", () => {
  it("preserves a nested __proto__ key as an inert own property", () => {
    const parsed = decodeStrictJson(
      text('{"a":{"__proto__":{"polluted":true},"x":1}}'),
    ) as { a: Record<string, unknown> };
    const nested = parsed.a;
    expect(Object.getPrototypeOf(nested)).toBeNull();
    expect(Object.hasOwn(nested, "__proto__")).toBe(true);
    expect(Object.keys(nested)).toEqual(["__proto__", "x"]);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it("treats __proto__ as an ordinary key for duplicate detection", () => {
    expect(() =>
      decodeStrictJson(text('{"__proto__":1,"__proto__":2}')),
    ).toThrow(/duplicate object key/u);
  });
});
