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
export {
  DEFAULT_MAX_BOUNDARY_LOOPS,
  DEFAULT_MAX_BOUNDARY_LOOP_POINTS,
  DEFAULT_MAX_ISSUE_ITEMS,
  MAX_BOUNDARY_LOOPS,
  MAX_BOUNDARY_LOOP_POINTS,
  MAX_ISSUE_ITEMS,
  diagnoseMeshHealth,
} from "./diagnose.js";
export type {
  BoundaryLoop,
  BoundaryLoopSet,
  DegenerateTriangleSet,
  EdgeSegmentSet,
  MeshHealthDiagnosis,
  MeshHealthOptions,
} from "./diagnose.js";
export type {
  TopologyDegenerateTriangle,
  TopologyEdgeSegment,
} from "./summary.js";
export {
  CLEARANCE_METHOD_ID,
  CLEARANCE_METHOD_VERSION,
  DEFAULT_MAX_INTERFERING_TRIANGLE_PAIRS,
  DEFAULT_MAX_TIGHT_REGIONS,
  MAX_INTERFERING_TRIANGLE_PAIRS,
  MAX_TIGHT_REGIONS,
  checkClearance,
} from "./clearance.js";
export type {
  CheckClearanceInput,
  CheckClearanceOptions,
  ClearanceCheckComplete,
  ClearanceCheckIndeterminate,
  ClearanceCheckResult,
  ClearanceInterference,
  ClearanceInterferenceVolume,
  ClearancePart,
  ClearancePlacement,
  ClearanceState,
  ClearanceTightRegion,
  ClearanceTightRegionSet,
  ClearanceTrianglePair,
  ClearanceWarning,
  ClosestPointPair,
} from "./clearance.js";
export {
  AlignmentGeometryError,
  AlignmentInputError,
  AlignmentResourceLimitError,
  DEFAULT_ICP_CONVERGENCE_TOLERANCE_MILLIMETRES,
  DEFAULT_MAX_ICP_ITERATIONS,
  MAX_CORRESPONDENCES,
  MAX_ICP_CONVERGENCE_TOLERANCE_MILLIMETRES,
  MAX_ICP_ITERATIONS,
  MIN_CORRESPONDENCES,
  POOR_FIT_RESIDUAL_RATIO,
  estimateAlignment,
} from "./alignment.js";
export type {
  AlignmentEstimate,
  AlignmentEvidence,
  AlignmentResidualStats,
  AlignmentTargetPlacement,
  AlignmentWarning,
  CorrespondencePoint,
  CorrespondencePointsInput,
  EstimateAlignmentInput,
  EstimateAlignmentOptions,
  IterativeClosestPointInput,
} from "./alignment.js";
export {
  DEFAULT_SNAP_TOLERANCE_MILLIMETRES,
  MAX_SNAP_TOLERANCE_MILLIMETRES,
  MeasurementInputError,
  MeasurementResourceLimitError,
  measureOnModel,
} from "./measure.js";
export type {
  BoundingExtentQuery,
  BoundingExtentResult,
  MeasureOptions,
  MeasurementQuery,
  MeasurementResult,
  PointToPointQuery,
  PointToPointResult,
  PointToSurfaceQuery,
  PointToSurfaceResult,
  SnapClassification,
  SnapPointInput,
  SnapPointOutcome,
  SnapPointQuery,
  SnapPointResult,
} from "./measure.js";
export {
  DEFAULT_MAX_SECTION_LOOP_POINTS,
  DEFAULT_MAX_SECTION_LOOPS,
  MAX_SECTION_LOOP_POINTS,
  MAX_SECTION_LOOPS,
  SectionInputError,
  SectionResourceLimitError,
  sectionModel,
} from "./section.js";
export type {
  SectionLoop,
  SectionLoopArea,
  SectionLoopSet,
  SectionOptions,
  SectionPlane,
  SectionResult,
  SectionWarning,
} from "./section.js";
