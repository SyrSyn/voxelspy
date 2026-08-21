import { describe, expect, it } from "vitest";
import {
  ACCEPTED_FORMATS_LABEL,
  ACCEPTED_UPLOAD_ACCEPT,
  ACCEPTED_UPLOAD_EXTENSIONS,
  defaultFrameForFormat,
  formatDeclaresOwnFrame,
  formatFrameDeclarationSummary,
  hasAcceptedExtension,
  requireSupportedFormat,
  resolveFrameOptions,
  unsupportedFormatMessage,
} from "./formats";

/**
 * Coverage for `formats.ts`, the single source of truth this app's tools
 * read for "which model file formats are accepted" -- see its module doc
 * comment. Every widened-format assertion here is deliberately mirrored by
 * `packages/importers/src/index.ts`'s own `SupportedFormat`/
 * `importerDescriptor.extensions`: if that list ever changes, these
 * assertions (and every tool that reads from this module rather than
 * restating its own extension list) move with it.
 */

describe("ACCEPTED_UPLOAD_EXTENSIONS / ACCEPTED_UPLOAD_ACCEPT", () => {
  it("includes every format the importer supports, and only those", () => {
    expect([...ACCEPTED_UPLOAD_EXTENSIONS].sort()).toEqual(
      ["3mf", "glb", "gltf", "obj", "stl"].sort(),
    );
  });

  it("derives the file input accept attribute from the same list", () => {
    expect(ACCEPTED_UPLOAD_ACCEPT.split(",").sort()).toEqual(
      [".stl", ".obj", ".gltf", ".glb", ".3mf"].sort(),
    );
  });
});

describe("hasAcceptedExtension", () => {
  it("accepts every supported extension, case-insensitively", () => {
    for (const extension of ACCEPTED_UPLOAD_EXTENSIONS) {
      expect(hasAcceptedExtension(`model.${extension}`)).toBe(true);
      expect(hasAcceptedExtension(`model.${extension.toUpperCase()}`)).toBe(
        true,
      );
    }
  });

  it("rejects an unsupported extension", () => {
    expect(hasAcceptedExtension("model.step")).toBe(false);
    expect(hasAcceptedExtension("model.fbx")).toBe(false);
    expect(hasAcceptedExtension("model")).toBe(false);
  });
});

describe("unsupportedFormatMessage", () => {
  it("names the supported subset honestly", () => {
    const message = unsupportedFormatMessage();
    expect(message).toContain(ACCEPTED_FORMATS_LABEL);
    for (const extension of ACCEPTED_UPLOAD_EXTENSIONS) {
      expect(message).toContain(`.${extension}`);
    }
  });
});

describe("requireSupportedFormat", () => {
  it("returns the inferred format for a supported extension", () => {
    expect(requireSupportedFormat("part.stl")).toBe("stl");
    expect(requireSupportedFormat("part.GLB")).toBe("glb");
    expect(requireSupportedFormat("part.3mf")).toBe("3mf");
  });

  it("throws an honest error naming the supported subset for an unsupported extension", () => {
    expect(() => requireSupportedFormat("part.step")).toThrow(
      /not a supported file/u,
    );
    try {
      requireSupportedFormat("part.step");
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toContain("part.step");
      expect((error as Error).message).toContain(ACCEPTED_FORMATS_LABEL);
    }
  });
});

describe("formatDeclaresOwnFrame", () => {
  it("is true only for glTF, GLB, and 3MF", () => {
    expect(formatDeclaresOwnFrame("gltf")).toBe(true);
    expect(formatDeclaresOwnFrame("glb")).toBe(true);
    expect(formatDeclaresOwnFrame("3mf")).toBe(true);
    expect(formatDeclaresOwnFrame("stl")).toBe(false);
    expect(formatDeclaresOwnFrame("obj")).toBe(false);
    expect(formatDeclaresOwnFrame(undefined)).toBe(false);
  });
});

describe("defaultFrameForFormat", () => {
  it("starts STL/OBJ from millimetre, right-handed Z-up", () => {
    expect(defaultFrameForFormat("stl")).toEqual({
      unit: "millimetre",
      axis: "right-handed-z-up",
    });
    expect(defaultFrameForFormat("obj")).toEqual({
      unit: "millimetre",
      axis: "right-handed-z-up",
    });
  });

  it("starts a format-declared frame empty, never implying a value the user did not choose", () => {
    expect(defaultFrameForFormat("gltf")).toEqual({ unit: "", axis: "" });
    expect(defaultFrameForFormat("glb")).toEqual({ unit: "", axis: "" });
    expect(defaultFrameForFormat("3mf")).toEqual({ unit: "", axis: "" });
  });
});

describe("formatFrameDeclarationSummary", () => {
  it("describes glTF/GLB's fixed metre, right-handed Y-up declaration", () => {
    expect(formatFrameDeclarationSummary("gltf")).toMatch(/metres/u);
    expect(formatFrameDeclarationSummary("gltf")).toMatch(/Y-up/u);
    expect(formatFrameDeclarationSummary("glb")).toEqual(
      formatFrameDeclarationSummary("gltf"),
    );
  });

  it("describes 3MF's own declared unit without claiming a specific value", () => {
    const summary = formatFrameDeclarationSummary("3mf");
    expect(summary).toMatch(/its own unit/u);
    expect(summary).toMatch(/Z-up/u);
  });

  it("is undefined for STL/OBJ, which declare no frame", () => {
    expect(formatFrameDeclarationSummary("stl")).toBeUndefined();
    expect(formatFrameDeclarationSummary("obj")).toBeUndefined();
  });
});

describe("resolveFrameOptions", () => {
  it("STL/OBJ default (not yet overridden): sends declaredUnit/declaredAxis", () => {
    expect(
      resolveFrameOptions("stl", "default", "millimetre", "right-handed-z-up"),
    ).toEqual({
      declaredUnit: "millimetre",
      declaredAxis: "right-handed-z-up",
    });
  });

  it("STL/OBJ expert override: sends userUnit/userAxis", () => {
    expect(
      resolveFrameOptions("obj", "expert", "inch", "right-handed-y-up"),
    ).toEqual({ userUnit: "inch", userAxis: "right-handed-y-up" });
  });

  it("a format-declared frame with no override sends neither field, letting the embedded declaration resolve", () => {
    expect(resolveFrameOptions("gltf", "default", "", "")).toEqual({});
    expect(resolveFrameOptions("3mf", "default", "", "")).toEqual({});
  });

  it("a format-declared frame never receives declaredUnit/declaredAxis, even when overridden", () => {
    // Per packages/importers/README.md: any declaredUnit/declaredAxis for a
    // format with an embedded declaration would itself register as an
    // override and raise `user-source-frame`, so only userUnit/userAxis is
    // ever correct here.
    const options = resolveFrameOptions(
      "gltf",
      "expert",
      "millimetre",
      "right-handed-z-up",
    );
    expect(options).toEqual({
      userUnit: "millimetre",
      userAxis: "right-handed-z-up",
    });
    expect(options).not.toHaveProperty("declaredUnit");
    expect(options).not.toHaveProperty("declaredAxis");
  });

  it("a format-declared frame resolves unit and axis independently: overriding one leaves the other on the file's own declaration", () => {
    expect(resolveFrameOptions("3mf", "expert", "inch", "")).toEqual({
      userUnit: "inch",
    });
    expect(
      resolveFrameOptions("gltf", "expert", "", "right-handed-z-up"),
    ).toEqual({ userAxis: "right-handed-z-up" });
  });
});
