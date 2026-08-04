import { describe, expect, it } from "vitest";
import { docs, routes, searchDocs } from "./content";

describe("documentation content", () => {
  it("keeps every page on a unique canonical route", () => {
    expect(new Set(routes).size).toBe(routes.length);
    expect(docs.every((doc) => doc.path.endsWith("/"))).toBe(true);
  });

  it("searches all terms locally and deterministically", () => {
    expect(searchDocs("local browser").map((doc) => doc.title)).toEqual([
      "Getting started",
      "Privacy by default",
    ]);
    expect(searchDocs("   ")).toEqual([]);
  });
});
