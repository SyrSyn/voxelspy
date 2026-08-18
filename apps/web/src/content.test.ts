import { describe, expect, it } from "vitest";
import { docs, routes, searchDocs, tools } from "./content";

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

describe("tools catalog", () => {
  it("keeps every tool on a unique id and a trailing-slash path", () => {
    expect(new Set(tools.map((tool) => tool.id)).size).toBe(tools.length);
    expect(new Set(tools.map((tool) => tool.path)).size).toBe(tools.length);
    expect(tools.every((tool) => tool.path.endsWith("/"))).toBe(true);
    for (const tool of tools) {
      if (tool.id === "compare") expect(tool.path).toBe("/compare/");
      else expect(tool.path.startsWith("/tools/")).toBe(true);
    }
  });

  it("only ever routes to an available tool's own declared path", () => {
    // A tool that isn't built yet must not claim a route the build never
    // emits: this is what keeps the catalog from rendering a link to a page
    // that 404s. `compare` is the one seeded exception, at its established
    // `/compare/` path rather than under `/tools/`.
    for (const tool of tools) {
      if (tool.status === "available") expect(routes).toContain(tool.path);
    }
  });

  it("lists at least one available tool and at least one honestly planned tool", () => {
    expect(tools.some((tool) => tool.status === "available")).toBe(true);
    expect(tools.some((tool) => tool.status === "planned")).toBe(true);
  });

  it("states plainly, in a planned tool's own copy, that it is not built yet", () => {
    for (const tool of tools.filter((item) => item.status === "planned")) {
      expect(
        tool.summary.toLocaleLowerCase("en-US"),
        `${tool.id} must say plainly it is not built yet`,
      ).toContain("not built yet");
    }
  });

  it("does not claim the concurrently-built Inspect route as available", () => {
    const inspect = tools.find((tool) => tool.id === "inspect");
    expect(inspect?.path).toBe("/tools/inspect/");
    expect(inspect?.status).toBe("planned");
    expect(routes).not.toContain("/tools/inspect/");
  });
});
