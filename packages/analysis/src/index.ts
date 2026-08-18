export {
  ANALYSIS_LIMITS,
  AXIS_ALIGNED_BOX_METHOD,
  SAMPLE_SPACING_EDGE_FACTOR,
  SURFACE_DISTANCE_METHOD,
  analyzeModelPair,
  supportedAnalysisMethods,
} from "./analyze.js";
export type {
  AnalysisInput,
  AnalysisMethodCapability,
  AnalysisResourceLimits,
} from "./analyze.js";
export { summarizeModelComparison, summarizeModelGeometry } from "./summary.js";
export type {
  CompactAnalysisSummary,
  DeltaDirection,
  ModelBoundsSummary,
  ModelComparisonPresentationSummary,
  ModelPresentationDeltas,
  ModelPresentationSummary,
  ModelVolumeSummary,
  NumericDelta,
  TopologyExampleLocation,
  TopologySummary,
  VolumeDelta,
  VolumeUnavailableReason,
} from "./summary.js";
export {
  DEFAULT_MAX_MESH_BREAKDOWN_ENTRIES,
  DEFAULT_MAX_TOPOLOGY_EXAMPLES,
  InspectionResourceLimitError,
  MAX_MESH_BREAKDOWN_ENTRIES,
  MAX_TOPOLOGY_EXAMPLES,
  inspectModel,
} from "./inspect.js";
export type {
  InspectOptions,
  InspectionResult,
  MeshBreakdown,
  MeshBreakdownEntry,
  TopologyFinding,
  TopologyFindingKind,
  WatertightnessReason,
  WatertightnessVerdict,
} from "./inspect.js";
