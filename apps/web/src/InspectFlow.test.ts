import { describe, expect, it } from "vitest";
import {
  modelSourceCapability,
  modelSourceSelectionForFile,
} from "./InspectFlow";

describe("inspect source defaults", () => {
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
        "Ready for local inspection using millimetres and right-handed Z-up.",
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

  it("accepts glTF/GLB/3MF and starts from the file's own declared frame, not a default", () => {
    const glb = modelSourceSelectionForFile(new File(["x"], "model.glb"));
    expect(glb).toMatchObject({ unit: "", axis: "", frameSource: "default" });
    expect(modelSourceCapability(glb)).toEqual({
      ready: true,
      message:
        "Ready for local inspection using this file's own declared source frame.",
    });

    const threeMf = modelSourceSelectionForFile(new File(["x"], "model.3mf"));
    expect(threeMf).toMatchObject({ unit: "", axis: "" });
    expect(modelSourceCapability(threeMf)).toMatchObject({ ready: true });

    const overridden = {
      ...glb,
      unit: "inch" as const,
      frameSource: "expert" as const,
    };
    expect(modelSourceCapability(overridden)).toEqual({
      ready: true,
      message:
        "Ready for local inspection using the selected override source frame.",
    });
  });
});
