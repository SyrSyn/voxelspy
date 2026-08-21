import { describe, expect, it } from "vitest";
import {
  exportFileName,
  exportFormReady,
  modelSourceCapability,
  modelSourceSelectionForFile,
  precisionNote,
  resolveSimplifyTarget,
  spacingBoundIsLargeRelativeToMax,
} from "./ConvertFlow";

describe("convert source defaults", () => {
  it("uses millimetre and right-handed Z-up before a file is chosen", () => {
    expect(modelSourceSelectionForFile(null)).toEqual({
      file: null,
      unit: "millimetre",
      axis: "right-handed-z-up",
      frameSource: "default",
    });
  });

  it("reports why a selection is not ready, for each precondition", () => {
    expect(modelSourceCapability(modelSourceSelectionForFile(null))).toEqual({
      ready: false,
      message: "Choose a local model file.",
    });
    expect(
      modelSourceCapability(
        modelSourceSelectionForFile(new File(["x"], "model.step")),
      ),
    ).toEqual({
      ready: false,
      message:
        "This release supports STL, OBJ, glTF, GLB, or 3MF mesh files (.stl, .obj, .gltf, .glb, .3mf).",
    });
    expect(
      modelSourceCapability(
        modelSourceSelectionForFile(new File([], "empty.stl")),
      ),
    ).toEqual({ ready: false, message: "The selected file is empty." });
    expect(
      modelSourceCapability(
        modelSourceSelectionForFile(
          new File([new Uint8Array(33 * 1024 * 1024)], "huge.stl"),
        ),
      ),
    ).toEqual({
      ready: false,
      message: "The selected file exceeds the 32 MiB importer safety ceiling.",
    });
  });

  it("is ready once a valid file is chosen, with the default frame", () => {
    expect(
      modelSourceCapability(
        modelSourceSelectionForFile(new File(["x"], "model.stl")),
      ),
    ).toEqual({
      ready: true,
      message: "Ready to load locally using millimetres and right-handed Z-up.",
    });
  });

  it("accepts glTF/GLB/3MF and starts from the file's own declared frame, not a default", () => {
    const glb = modelSourceSelectionForFile(new File(["x"], "model.glb"));
    expect(glb).toMatchObject({ unit: "", axis: "", frameSource: "default" });
    expect(modelSourceCapability(glb)).toEqual({
      ready: true,
      message:
        "Ready to load locally using this file's own declared source frame.",
    });
  });
});

const skipForm = {
  mode: "skip" as const,
  triangleCountText: "",
  reductionPercentText: "50",
  collapseBoundaryEdges: false,
};

describe("resolveSimplifyTarget", () => {
  it("requires a target when the mode is skip", () => {
    expect(resolveSimplifyTarget(skipForm, 1000)).toEqual({
      error: "Choose a simplification target, or skip simplification.",
    });
  });

  it("resolves a valid triangle-count target strictly below the original count", () => {
    expect(
      resolveSimplifyTarget(
        { ...skipForm, mode: "triangle-count", triangleCountText: "400" },
        1000,
      ),
    ).toEqual({ target: { kind: "triangle-count", triangleCount: 400 } });
  });

  it("rejects a triangle-count target at or above the original count", () => {
    expect(
      resolveSimplifyTarget(
        { ...skipForm, mode: "triangle-count", triangleCountText: "1000" },
        1000,
      ),
    ).toEqual({
      error:
        "The target (1000) must be smaller than the loaded model's 1000 triangles.",
    });
  });

  it("rejects a non-integer or non-positive triangle-count target", () => {
    expect(
      resolveSimplifyTarget(
        { ...skipForm, mode: "triangle-count", triangleCountText: "12.5" },
        1000,
      ),
    ).toEqual({ error: "Enter a positive whole target triangle count." });
    expect(
      resolveSimplifyTarget(
        { ...skipForm, mode: "triangle-count", triangleCountText: "0" },
        1000,
      ),
    ).toEqual({ error: "Enter a positive whole target triangle count." });
    expect(
      resolveSimplifyTarget(
        { ...skipForm, mode: "triangle-count", triangleCountText: "abc" },
        1000,
      ),
    ).toEqual({ error: "Enter a positive whole target triangle count." });
  });

  it("resolves a valid reduction-percentage target to a ratio strictly between 0 and 1", () => {
    expect(
      resolveSimplifyTarget(
        { ...skipForm, mode: "reduction-ratio", reductionPercentText: "60" },
        1000,
      ),
    ).toEqual({ target: { kind: "reduction-ratio", reductionRatio: 0.6 } });
  });

  it("rejects a reduction percentage outside (0, 100)", () => {
    expect(
      resolveSimplifyTarget(
        { ...skipForm, mode: "reduction-ratio", reductionPercentText: "0" },
        1000,
      ),
    ).toEqual({
      error: "Enter a reduction percentage strictly between 0 and 100.",
    });
    expect(
      resolveSimplifyTarget(
        { ...skipForm, mode: "reduction-ratio", reductionPercentText: "100" },
        1000,
      ),
    ).toEqual({
      error: "Enter a reduction percentage strictly between 0 and 100.",
    });
  });
});

describe("spacingBoundIsLargeRelativeToMax", () => {
  it("is true when the sample-spacing bound meets or exceeds the measured maximum", () => {
    expect(
      spacingBoundIsLargeRelativeToMax({
        sampleSpacingUpperBoundMillimetres: 0.5,
        maximumDistanceMillimetres: 0.5,
      }),
    ).toBe(true);
    expect(
      spacingBoundIsLargeRelativeToMax({
        sampleSpacingUpperBoundMillimetres: 1,
        maximumDistanceMillimetres: 0.2,
      }),
    ).toBe(true);
  });

  it("is false when the measured maximum exceeds the sample-spacing bound", () => {
    expect(
      spacingBoundIsLargeRelativeToMax({
        sampleSpacingUpperBoundMillimetres: 0.1,
        maximumDistanceMillimetres: 0.5,
      }),
    ).toBe(false);
  });
});

describe("exportFormReady", () => {
  const filled = {
    format: "stl-binary" as const,
    unit: "millimetre" as const,
    axis: "right-handed-z-up" as const,
    source: "original" as const,
  };

  it("requires a format, a unit, and an axis, in that order, with no silent default", () => {
    expect(exportFormReady({ ...filled, format: "" })).toEqual({
      ready: false,
      message: "Choose an export format.",
    });
    expect(exportFormReady({ ...filled, unit: "" })).toEqual({
      ready: false,
      message: "Choose an output unit.",
    });
    expect(exportFormReady({ ...filled, axis: "" })).toEqual({
      ready: false,
      message: "Choose an output up-axis.",
    });
    expect(exportFormReady(filled)).toEqual({ ready: true });
  });
});

describe("exportFileName", () => {
  it("names the file from the source and target format, unmodified", () => {
    expect(exportFileName("bracket.stl", "obj", "original")).toBe(
      "bracket.obj",
    );
    expect(exportFileName("bracket.stl", "stl-ascii", "original")).toBe(
      "bracket.stl",
    );
  });

  it("marks a simplified export distinctly from the original", () => {
    expect(exportFileName("bracket.stl", "stl-binary", "simplified")).toBe(
      "bracket.simplified.stl",
    );
  });

  it("falls back to a generic name for a source with no extension", () => {
    expect(exportFileName("bracket", "obj", "original")).toBe("bracket.obj");
  });
});

describe("precisionNote", () => {
  it("warns that binary STL is float32-bounded regardless of unit", () => {
    expect(precisionNote("stl-binary", "millimetre")).toMatch(/float32/);
    expect(precisionNote("stl-binary", "inch")).toMatch(/float32/);
  });

  it("promises a bit-identical round trip for text formats at millimetre", () => {
    expect(precisionNote("stl-ascii", "millimetre")).toMatch(/bit-identical/);
    expect(precisionNote("obj", "millimetre")).toMatch(/bit-identical/);
  });

  it("qualifies text formats at a non-millimetre unit with floating-point tolerance", () => {
    expect(precisionNote("obj", "inch")).toMatch(/floating-point/);
    expect(precisionNote("obj", "inch")).toMatch(/ULPs/);
    expect(precisionNote("obj", "inch")).not.toMatch(
      /^This text format's number encoding round-trips exactly, and millimetre/u,
    );
  });
});
