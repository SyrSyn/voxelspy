import type { GeometryProvenance } from "@voxelspy/contracts";
const recorded = new WeakMap<File, GeometryProvenance>();
export function recordHostedSource(file: File, provenance: GeometryProvenance) {
  recorded.set(file, provenance);
}
export function hostedProvenance(file: File | undefined) {
  return file ? recorded.get(file) : undefined;
}
export function recordedFrameOptions(provenance: GeometryProvenance) {
  return {
    ...(provenance.sourceResolution.unit === "user"
      ? { userUnit: provenance.sourceUnit }
      : provenance.sourceResolution.unit === "declared"
        ? { declaredUnit: provenance.sourceUnit }
        : {}),
    ...(provenance.sourceResolution.axis === "user"
      ? { userAxis: provenance.sourceAxis }
      : provenance.sourceResolution.axis === "declared"
        ? { declaredAxis: provenance.sourceAxis }
        : {}),
  };
}
