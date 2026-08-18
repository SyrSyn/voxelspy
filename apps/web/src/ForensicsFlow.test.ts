import { describe, expect, it } from "vitest";
import {
  modelSourceCapability,
  modelSourceSelectionForFile,
} from "./ForensicsFlow";

describe("forensics source defaults", () => {
  it("uses millimetre and right-handed Z-up before a file is chosen", () => {
    expect(modelSourceSelectionForFile(null)).toEqual({
      file: null,
      unit: "millimetre",
      axis: "right-handed-z-up",
      frameSource: "default",
    });
  });

  it("restores the defaults when a file is chosen or replaced", () => {
    const first = modelSourceSelectionForFile(new File(["first"], "model.stl"));
    const expertSelection = {
      ...first,
      unit: "inch" as const,
      axis: "right-handed-y-up" as const,
      frameSource: "expert" as const,
    };
    const replacement = modelSourceSelectionForFile(
      new File(["replacement"], "replacement.obj"),
    );

    expect(modelSourceCapability(expertSelection)).toMatchObject({
      ready: true,
    });
    expect(replacement).toMatchObject({
      unit: "millimetre",
      axis: "right-handed-z-up",
      frameSource: "default",
    });
    expect(modelSourceCapability(replacement)).toEqual({
      ready: true,
      message:
        "Ready for local analysis using millimetres and right-handed Z-up.",
    });
  });

  it("reports why a selection is not ready, for each precondition", () => {
    expect(modelSourceCapability(modelSourceSelectionForFile(null))).toEqual({
      ready: false,
      message: "Choose a local STL or OBJ file.",
    });
    expect(
      modelSourceCapability(
        modelSourceSelectionForFile(new File(["x"], "model.glb")),
      ),
    ).toEqual({
      ready: false,
      message: "This release supports STL and OBJ mesh files.",
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
});
