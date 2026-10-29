import type { NormalizedModel } from "@voxelspy/contracts";

/** Preview ceiling, independent of conversion/import acceptance. */
export const MAX_CONVERT_PREVIEW_TRIANGLES = 100_000;

/** Clone only transferable geometry so preview cannot detach retained source data. */
export function cloneConversionPreview(
  model: NormalizedModel,
  placedTriangles: number,
): NormalizedModel {
  if (placedTriangles > MAX_CONVERT_PREVIEW_TRIANGLES)
    throw new Error(
      `3D preview is limited to ${MAX_CONVERT_PREVIEW_TRIANGLES} placed triangles. Numerical reports and exports remain available.`,
    );
  return {
    ...model,
    meshes: model.meshes.map((mesh) => ({
      ...mesh,
      geometry: {
        positions: mesh.geometry.positions.slice(),
        indices: mesh.geometry.indices.slice(),
      },
    })),
  };
}
