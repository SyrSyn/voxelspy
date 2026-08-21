import { describe, expect, it } from "vitest";
import {
  axisUnitVector,
  modelSourceCapability,
  modelSourceSelectionForFile,
  resolvePlane,
} from "./MeasureSectionFlow";

describe("measure & section model source defaults", () => {
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

  it("says the model is ready once a valid file is chosen", () => {
    expect(
      modelSourceCapability(
        modelSourceSelectionForFile(new File(["x"], "model.stl")),
      ),
    ).toEqual({
      ready: true,
      message:
        "Ready for local measurement using millimetres and right-handed Z-up.",
    });
  });

  it("accepts glTF/GLB/3MF and starts from the file's own declared frame, not a default", () => {
    const glb = modelSourceSelectionForFile(new File(["x"], "model.glb"));
    expect(glb).toMatchObject({ unit: "", axis: "", frameSource: "default" });
    expect(modelSourceCapability(glb)).toEqual({
      ready: true,
      message:
        "Ready for local measurement using this file's own declared source frame.",
    });
  });
});

describe("axisUnitVector", () => {
  it("returns the unit vector for each axis", () => {
    expect(axisUnitVector("x")).toEqual([1, 0, 0]);
    expect(axisUnitVector("y")).toEqual([0, 1, 0]);
    expect(axisUnitVector("z")).toEqual([0, 0, 1]);
  });
});

describe("resolvePlane", () => {
  it("builds a plane from an axis choice and an offset, along that axis's own unit direction", () => {
    expect(resolvePlane("z", [0, 0, 1], 5)).toEqual({
      point: [0, 0, 5],
      normal: [0, 0, 1],
    });
    expect(resolvePlane("x", [0, 0, 1], -3)).toEqual({
      point: [-3, 0, 0],
      normal: [1, 0, 0],
    });
  });

  it("normalizes a non-unit custom normal before applying the offset", () => {
    const result = resolvePlane("custom", [0, 0, 2], 10);
    expect(result).toBeDefined();
    expect(result!.normal).toEqual([0, 0, 2]);
    expect(result!.point).toEqual([0, 0, 10]);
  });

  it("returns undefined for a degenerate custom normal", () => {
    expect(resolvePlane("custom", [0, 0, 0], 5)).toBeUndefined();
  });

  it("returns undefined for a non-finite offset or custom normal component", () => {
    expect(resolvePlane("z", [0, 0, 1], Number.NaN)).toBeUndefined();
    expect(resolvePlane("custom", [0, Number.NaN, 1], 5)).toBeUndefined();
  });
});
