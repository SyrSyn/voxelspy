export type SourceUnit =
  "micrometre" | "millimetre" | "centimetre" | "metre" | "inch" | "foot";

export type SourceAxis = "right-handed-z-up" | "right-handed-y-up";

export type WarningCode =
  | "ambiguous-axis"
  | "ambiguous-unit"
  | "archive-entry-rejected"
  | "degenerate-triangle"
  | "external-resource-rejected"
  | "non-finite-coordinate"
  | "unsupported-feature";

export interface ImportWarning {
  readonly code: WarningCode;
  readonly message: string;
}

export interface GeometryProvenance {
  readonly format: "3mf" | "gltf" | "obj" | "step-tessellation" | "stl";
  readonly importer: string;
  readonly sourceName: string;
  readonly sourceUnit: SourceUnit;
  readonly sourceAxis: SourceAxis;
  readonly sourceToMillimetres: number;
  readonly sourceToZUp: readonly number[];
  readonly notes: readonly string[];
}

export interface MeshGeometry {
  readonly positions: Float64Array;
  readonly indices: Uint32Array;
}

export interface AssemblyNode {
  readonly id: string;
  readonly name?: string;
  readonly mesh?: number;
  readonly children: readonly number[];
  readonly transform: readonly number[];
}

export interface NormalizedModel {
  readonly coordinateSystem: "right-handed-z-up";
  readonly unit: "millimetre";
  readonly meshes: readonly MeshGeometry[];
  readonly assembly?: readonly AssemblyNode[];
  readonly warnings: readonly ImportWarning[];
  readonly provenance: GeometryProvenance;
}

export interface ImportOptions {
  readonly sourceName: string;
  readonly declaredUnit?: SourceUnit;
  readonly declaredAxis?: SourceAxis;
  readonly limits?: Partial<ImportLimits>;
  readonly allowUnboundedDeflate?: boolean;
}

export interface ImportLimits {
  readonly maxArchiveEntries: number;
  readonly maxExpandedBytes: number;
  readonly maxCompressionRatio: number;
  readonly maxTriangles: number;
}

export const DEFAULT_LIMITS: ImportLimits = {
  maxArchiveEntries: 256,
  maxExpandedBytes: 64 * 1024 * 1024,
  maxCompressionRatio: 200,
  maxTriangles: 2_000_000,
};

export interface TessellatedStepMesh {
  readonly positions: Float64Array;
  readonly indices: Uint32Array;
  readonly sourceUnit: SourceUnit;
  readonly sourceAxis: SourceAxis;
  readonly name?: string;
}

export interface TessellatedStepNode {
  readonly id: string;
  readonly name?: string;
  readonly mesh?: number;
  readonly children: readonly number[];
  readonly transform: readonly number[];
}

export interface TessellatedStepResult {
  readonly sourceName: string;
  readonly tessellator: string;
  readonly linearDeflection: number;
  readonly angularDeflection: number;
  readonly meshes: readonly TessellatedStepMesh[];
  readonly assembly: readonly TessellatedStepNode[];
  readonly warnings?: readonly string[];
}
