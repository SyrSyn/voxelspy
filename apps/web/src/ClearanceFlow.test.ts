import { describe, expect, it } from "vitest";
import {
  desiredClearanceCapability,
  partSelectionForFile,
  partSourceCapability,
} from "./ClearanceFlow";

describe("clearance part source defaults", () => {
  it("uses millimetre, right-handed Z-up, and the identity placement before a file is chosen", () => {
    expect(partSelectionForFile(null)).toEqual({
      file: null,
      unit: "millimetre",
      axis: "right-handed-z-up",
      frameSource: "default",
      placement: {
        translationMillimetres: [0, 0, 0],
        rotationDegrees: [0, 0, 0],
      },
    });
  });

  it("restores the defaults, including the identity placement, when a file is chosen or replaced", () => {
    const first = partSelectionForFile(new File(["first"], "model.stl"));
    const moved = {
      ...first,
      unit: "inch" as const,
      axis: "right-handed-y-up" as const,
      frameSource: "expert" as const,
      placement: {
        translationMillimetres: [10, 0, 0] as [number, number, number],
        rotationDegrees: [0, 0, 0] as [number, number, number],
      },
    };
    expect(partSourceCapability(moved)).toMatchObject({ ready: true });

    const replacement = partSelectionForFile(
      new File(["replacement"], "replacement.obj"),
    );
    expect(replacement).toMatchObject({
      unit: "millimetre",
      axis: "right-handed-z-up",
      frameSource: "default",
      placement: {
        translationMillimetres: [0, 0, 0],
        rotationDegrees: [0, 0, 0],
      },
    });
  });

  it("reports why a part is not ready, for each precondition", () => {
    expect(partSourceCapability(partSelectionForFile(null))).toEqual({
      ready: false,
      message: "Choose a local STL or OBJ file.",
    });
    expect(
      partSourceCapability(partSelectionForFile(new File(["x"], "model.glb"))),
    ).toEqual({
      ready: false,
      message: "This release supports STL and OBJ mesh files.",
    });
    expect(
      partSourceCapability(partSelectionForFile(new File([], "empty.stl"))),
    ).toEqual({ ready: false, message: "The selected file is empty." });
    expect(
      partSourceCapability(
        partSelectionForFile(
          new File([new Uint8Array(33 * 1024 * 1024)], "huge.stl"),
        ),
      ),
    ).toEqual({
      ready: false,
      message: "The selected file exceeds the 32 MiB importer safety ceiling.",
    });
  });

  it("is not ready when a placement field is not a number", () => {
    const selection = {
      ...partSelectionForFile(new File(["x"], "model.stl")),
      placement: {
        translationMillimetres: [Number.NaN, 0, 0] as [number, number, number],
        rotationDegrees: [0, 0, 0] as [number, number, number],
      },
    };
    expect(partSourceCapability(selection)).toEqual({
      ready: false,
      message:
        "Enter a numeric value for every translation and rotation field.",
    });
  });

  it("says plainly whether a ready part is at the identity placement or a set one", () => {
    const identitySelection = partSelectionForFile(
      new File(["x"], "model.stl"),
    );
    expect(partSourceCapability(identitySelection)).toEqual({
      ready: true,
      message: "Ready, at the identity placement (not moved).",
    });
    const movedSelection = {
      ...identitySelection,
      placement: {
        translationMillimetres: [1, 0, 0] as [number, number, number],
        rotationDegrees: [0, 0, 0] as [number, number, number],
      },
    };
    expect(partSourceCapability(movedSelection)).toEqual({
      ready: true,
      message: "Ready, at the placement set below.",
    });
  });
});

describe("desired clearance capability", () => {
  it("requires a finite, non-negative value", () => {
    expect(desiredClearanceCapability(Number.NaN)).toEqual({
      ready: false,
      message: "Enter the desired clearance in millimetres.",
    });
    expect(desiredClearanceCapability(-1)).toEqual({
      ready: false,
      message: "Desired clearance must be zero or greater.",
    });
    expect(desiredClearanceCapability(0)).toMatchObject({ ready: true });
    expect(desiredClearanceCapability(1.5)).toMatchObject({ ready: true });
  });
});
