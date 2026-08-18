import { rigidTransformSchema } from "@voxelspy/contracts";
import { describe, expect, it } from "vitest";
import {
  buildPlacementMatrix,
  IDENTITY_PLACEMENT,
  isIdentityPlacement,
  type PartPlacement,
} from "./clearance-placement";

describe("clearance placement", () => {
  it("treats the identity placement as identity, and any other placement as not", () => {
    expect(isIdentityPlacement(IDENTITY_PLACEMENT)).toBe(true);
    expect(
      isIdentityPlacement({
        translationMillimetres: [1, 0, 0],
        rotationDegrees: [0, 0, 0],
      }),
    ).toBe(false);
    expect(
      isIdentityPlacement({
        translationMillimetres: [0, 0, 0],
        rotationDegrees: [0, 0, 5],
      }),
    ).toBe(false);
  });

  it("builds the exact identity matrix for the identity placement", () => {
    expect(buildPlacementMatrix(IDENTITY_PLACEMENT)).toEqual([
      1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
    ]);
  });

  it("places translation directly in the matrix's translation column", () => {
    const matrix = buildPlacementMatrix({
      translationMillimetres: [12, -5, 3.5],
      rotationDegrees: [0, 0, 0],
    });
    expect(matrix.slice(12, 15)).toEqual([12, -5, 3.5]);
    // No rotation: the rotation block stays identity.
    expect(matrix.slice(0, 12)).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]);
  });

  it("rotates 90 degrees about Z the way a right-handed frame requires", () => {
    // A 90-degree rotation about Z maps the local +X axis onto comparison +Y.
    const matrix = buildPlacementMatrix({
      translationMillimetres: [0, 0, 0],
      rotationDegrees: [0, 0, 90],
    });
    expect(matrix[0]).toBeCloseTo(0, 10);
    expect(matrix[1]).toBeCloseTo(1, 10);
    expect(matrix[2]).toBeCloseTo(0, 10);
  });

  it("produces a matrix every placement passes as a valid rigid transform", () => {
    const placements: PartPlacement[] = [
      IDENTITY_PLACEMENT,
      { translationMillimetres: [10, 20, -30], rotationDegrees: [0, 0, 0] },
      { translationMillimetres: [0, 0, 0], rotationDegrees: [90, 0, 0] },
      { translationMillimetres: [0, 0, 0], rotationDegrees: [0, 90, 0] },
      { translationMillimetres: [0, 0, 0], rotationDegrees: [0, 0, 180] },
      {
        translationMillimetres: [1.5, -2.25, 100],
        rotationDegrees: [15, -40, 270],
      },
    ];
    for (const placement of placements) {
      expect(() =>
        rigidTransformSchema.parse(buildPlacementMatrix(placement)),
      ).not.toThrow();
    }
  });
});
