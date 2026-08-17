import { z } from "zod";
import {
  affineTransformSchema,
  canonicalFrameSchema,
  entityIdSchema,
  instanceIdSchema,
  meshIdSchema,
  modelIdSchema,
  nodeIdSchema,
  portableJsonObjectSchema,
  resolvedSourceAxisSchema,
  resolvedSourceUnitSchema,
  sha256DigestSchema,
  sourceAxisSchema,
  sourceNormalizationTransformSchema,
  sourceUnitSchema,
} from "./primitives.js";

export const warningSchema = z.strictObject({
  code: entityIdSchema,
  severity: z.enum(["info", "warning", "error"]),
  message: z.string().min(1).max(2_000),
  location: z.string().min(1).max(1_000).optional(),
  details: portableJsonObjectSchema.optional(),
});
export type ContractWarning = z.infer<typeof warningSchema>;

export const tessellationProvenanceSchema = z.strictObject({
  adapterId: entityIdSchema,
  adapterVersion: z.string().min(1).max(128),
  parameters: portableJsonObjectSchema,
});

export const sourceResolutionSchema = z.strictObject({
  unit: z.enum(["embedded", "declared", "user"]),
  axis: z.enum(["embedded", "declared", "user"]),
});

export const geometryProvenanceSchema = z
  .strictObject({
    formatId: entityIdSchema,
    importerId: entityIdSchema,
    importerVersion: z.string().min(1).max(128),
    sourceName: z.string().min(1).max(1_024),
    sourceDigest: sha256DigestSchema.optional(),
    detectedSourceUnit: sourceUnitSchema,
    detectedSourceAxis: sourceAxisSchema,
    sourceUnit: resolvedSourceUnitSchema,
    sourceAxis: resolvedSourceAxisSchema,
    sourceResolution: sourceResolutionSchema,
    appliedSourceToModel: sourceNormalizationTransformSchema,
    tessellation: tessellationProvenanceSchema.optional(),
    notes: z.array(z.string().min(1).max(1_000)).max(64).default([]),
  })
  .superRefine((provenance, context) => {
    if (
      provenance.sourceResolution.unit === "embedded" &&
      provenance.detectedSourceUnit !== provenance.sourceUnit
    ) {
      context.addIssue({
        code: "custom",
        path: ["detectedSourceUnit"],
        message: "Embedded unit resolution must match the detected unit",
      });
    }
    if (
      provenance.sourceResolution.axis === "embedded" &&
      provenance.detectedSourceAxis !== provenance.sourceAxis
    ) {
      context.addIssue({
        code: "custom",
        path: ["detectedSourceAxis"],
        message: "Embedded axis resolution must match the detected axis",
      });
    }
    const unitScale = {
      micrometre: 0.001,
      millimetre: 1,
      centimetre: 10,
      metre: 1_000,
      inch: 25.4,
      foot: 304.8,
    }[provenance.sourceUnit];
    const expected =
      provenance.sourceAxis === "right-handed-z-up"
        ? [
            unitScale,
            0,
            0,
            0,
            0,
            unitScale,
            0,
            0,
            0,
            0,
            unitScale,
            0,
            0,
            0,
            0,
            1,
          ]
        : [
            unitScale,
            0,
            0,
            0,
            0,
            0,
            unitScale,
            0,
            0,
            -unitScale,
            0,
            0,
            0,
            0,
            0,
            1,
          ];
    if (
      !provenance.appliedSourceToModel.every(
        (value, index) => value === expected[index],
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["appliedSourceToModel"],
        message: "Source normalization must match the resolved unit and axis",
      });
    }
  });
export type GeometryProvenance = z.infer<typeof geometryProvenanceSchema>;

function ownsTransferableBuffer(view: Float64Array | Uint32Array): boolean {
  return (
    view.buffer instanceof ArrayBuffer &&
    view.buffer.byteLength > 0 &&
    view.byteOffset === 0 &&
    view.byteLength === view.buffer.byteLength
  );
}

/** Validation safety ceiling, not a release-support or performance claim. */
export const MAX_MESH_BUFFER_ELEMENTS = 50_000_000;

export const meshBufferSchema = z
  .strictObject({
    positions: z.instanceof(Float64Array),
    indices: z.instanceof(Uint32Array),
  })
  .superRefine(({ positions, indices }, context) => {
    if (!ownsTransferableBuffer(positions)) {
      context.addIssue({
        code: "custom",
        path: ["positions"],
        message: "Positions must own one complete transferable ArrayBuffer",
      });
      return;
    }
    if (!ownsTransferableBuffer(indices)) {
      context.addIssue({
        code: "custom",
        path: ["indices"],
        message: "Indices must own one complete transferable ArrayBuffer",
      });
      return;
    }
    if (
      positions.length > MAX_MESH_BUFFER_ELEMENTS ||
      indices.length > MAX_MESH_BUFFER_ELEMENTS
    ) {
      context.addIssue({
        code: "custom",
        message: "Mesh buffer exceeds the contract validation safety ceiling",
      });
      return;
    }
    if (positions.length % 3 !== 0) {
      context.addIssue({
        code: "custom",
        path: ["positions"],
        message: "Positions must contain complete xyz triples",
      });
    }
    if (indices.length % 3 !== 0) {
      context.addIssue({
        code: "custom",
        path: ["indices"],
        message: "Indices must contain complete triangles",
      });
    }
    for (let index = 0; index < positions.length; index += 1) {
      if (!Number.isFinite(positions[index])) {
        context.addIssue({
          code: "custom",
          path: ["positions", index],
          message: "Positions must be finite",
        });
        break;
      }
    }
    const vertexCount = positions.length / 3;
    for (let index = 0; index < indices.length; index += 1) {
      const value = indices[index];
      if (value === undefined || value >= vertexCount) {
        context.addIssue({
          code: "custom",
          path: ["indices", index],
          message: "Index is outside the position buffer",
        });
        break;
      }
    }
  });
export type MeshBuffer = z.infer<typeof meshBufferSchema>;

export const meshRecordSchema = z.strictObject({
  id: meshIdSchema,
  geometry: meshBufferSchema,
});
export type MeshRecord = z.infer<typeof meshRecordSchema>;

const flatInstanceSchema = z.strictObject({
  id: instanceIdSchema,
  meshId: meshIdSchema,
  meshToModel: affineTransformSchema,
});

const hierarchicalInstanceSchema = z.strictObject({
  id: instanceIdSchema,
  meshId: meshIdSchema,
  meshToNode: affineTransformSchema,
});

export const assemblyNodeSchema = z.strictObject({
  id: nodeIdSchema,
  name: z.string().min(1).max(1_000).optional(),
  childIds: z.array(nodeIdSchema).max(10_000),
  instanceIds: z.array(instanceIdSchema).max(10_000),
  localToParent: affineTransformSchema,
});
export type AssemblyNode = z.infer<typeof assemblyNodeSchema>;

export const modelPlacementSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("flat"),
    instances: z.array(flatInstanceSchema).min(1).max(100_000),
  }),
  z.strictObject({
    kind: z.literal("hierarchy"),
    instances: z.array(hierarchicalInstanceSchema).min(1).max(100_000),
    rootIds: z.array(nodeIdSchema).min(1).max(10_000),
    nodes: z.array(assemblyNodeSchema).min(1).max(100_000),
  }),
]);
export type ModelPlacement = z.infer<typeof modelPlacementSchema>;

const normalizedModelShape = z.strictObject({
  contractVersion: z.literal(1),
  id: modelIdSchema,
  frame: canonicalFrameSchema,
  meshes: z.array(meshRecordSchema).min(1).max(100_000),
  placement: modelPlacementSchema,
  warnings: z.array(warningSchema).max(10_000),
  provenance: geometryProvenanceSchema,
});

function validateModel(
  model: z.infer<typeof normalizedModelShape>,
  context: z.RefinementCtx,
): void {
  const buffers = model.meshes.flatMap(({ geometry }) => [
    geometry.positions.buffer,
    geometry.indices.buffer,
  ]);
  if (new Set(buffers).size !== buffers.length) {
    context.addIssue({
      code: "custom",
      path: ["meshes"],
      message: "Every geometry view must own a distinct transferable buffer",
    });
  }
  const meshIds = new Set(model.meshes.map(({ id }) => id));
  const instanceIds = new Set(model.placement.instances.map(({ id }) => id));
  if (meshIds.size !== model.meshes.length) {
    context.addIssue({
      code: "custom",
      path: ["meshes"],
      message: "Mesh IDs must be unique",
    });
  }
  if (instanceIds.size !== model.placement.instances.length) {
    context.addIssue({
      code: "custom",
      path: ["placement", "instances"],
      message: "Instance IDs must be unique",
    });
  }
  model.placement.instances.forEach((instance, index) => {
    if (!meshIds.has(instance.meshId)) {
      context.addIssue({
        code: "custom",
        path: ["placement", "instances", index, "meshId"],
        message: "Unknown mesh reference",
      });
    }
  });
  const categoryIds = [model.id, ...meshIds, ...instanceIds].map(String);

  if (model.placement.kind === "flat") {
    if (new Set(categoryIds).size !== categoryIds.length) {
      context.addIssue({
        code: "custom",
        path: ["placement"],
        message: "Cross-category IDs must not collide",
      });
    }
    return;
  }

  const nodeIds = new Set(model.placement.nodes.map(({ id }) => id));
  if (nodeIds.size !== model.placement.nodes.length) {
    context.addIssue({
      code: "custom",
      path: ["placement", "nodes"],
      message: "Node IDs must be unique",
    });
  }
  if (
    new Set([...categoryIds, ...nodeIds].map(String)).size !==
    categoryIds.length + nodeIds.size
  ) {
    context.addIssue({
      code: "custom",
      path: ["placement"],
      message: "Cross-category IDs must not collide",
    });
  }
  if (
    new Set(model.placement.rootIds).size !== model.placement.rootIds.length
  ) {
    context.addIssue({
      code: "custom",
      path: ["placement", "rootIds"],
      message: "Root IDs must be unique",
    });
  }
  const roots = new Set(model.placement.rootIds);
  model.placement.rootIds.forEach((rootId, index) => {
    if (!nodeIds.has(rootId))
      context.addIssue({
        code: "custom",
        path: ["placement", "rootIds", index],
        message: "Unknown root node",
      });
  });

  const nodes = new Map<string, AssemblyNode>(
    model.placement.nodes.map((node) => [node.id, node]),
  );
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  model.placement.rootIds.forEach((rootId, index) => {
    const root = nodes.get(rootId);
    if (
      root &&
      !root.localToParent.every(
        (value, matrixIndex) => value === identity[matrixIndex],
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["placement", "rootIds", index],
        message: "Root nodes must use an identity local-to-parent transform",
      });
    }
  });
  const parentCounts = new Map<string, number>();
  const attachedInstances = new Map<string, number>();
  model.placement.nodes.forEach((node, nodeIndex) => {
    if (new Set(node.childIds).size !== node.childIds.length) {
      context.addIssue({
        code: "custom",
        path: ["placement", "nodes", nodeIndex, "childIds"],
        message: "Child references must be unique",
      });
    }
    if (new Set(node.instanceIds).size !== node.instanceIds.length) {
      context.addIssue({
        code: "custom",
        path: ["placement", "nodes", nodeIndex, "instanceIds"],
        message: "Instance references must be unique",
      });
    }
    node.childIds.forEach((childId, childIndex) => {
      if (!nodeIds.has(childId))
        context.addIssue({
          code: "custom",
          path: ["placement", "nodes", nodeIndex, "childIds", childIndex],
          message: "Unknown child node",
        });
      parentCounts.set(childId, (parentCounts.get(childId) ?? 0) + 1);
    });
    node.instanceIds.forEach((instanceId, instanceIndex) => {
      if (!instanceIds.has(instanceId))
        context.addIssue({
          code: "custom",
          path: ["placement", "nodes", nodeIndex, "instanceIds", instanceIndex],
          message: "Unknown mesh instance",
        });
      attachedInstances.set(
        instanceId,
        (attachedInstances.get(instanceId) ?? 0) + 1,
      );
    });
  });
  for (const nodeId of nodeIds) {
    const parents = parentCounts.get(nodeId) ?? 0;
    if (
      (roots.has(nodeId) && parents !== 0) ||
      (!roots.has(nodeId) && parents !== 1)
    ) {
      context.addIssue({
        code: "custom",
        path: ["placement"],
        message: "Hierarchy nodes require exactly one parent, except roots",
      });
      break;
    }
  }
  for (const instanceId of instanceIds) {
    if (attachedInstances.get(instanceId) !== 1) {
      context.addIssue({
        code: "custom",
        path: ["placement"],
        message: "Every instance must attach to exactly one hierarchy node",
      });
      break;
    }
  }

  const state = new Map<string, "visiting" | "visited">();
  let cycle = false;
  for (const rootId of model.placement.rootIds) {
    if (state.get(rootId) === "visited") continue;
    const stack: Array<{ id: string; exit: boolean }> = [
      { id: rootId, exit: false },
    ];
    while (stack.length > 0 && !cycle) {
      const current = stack.pop();
      if (!current) break;
      if (current.exit) {
        state.set(current.id, "visited");
        continue;
      }
      const currentState = state.get(current.id);
      if (currentState === "visiting") {
        cycle = true;
        break;
      }
      if (currentState === "visited") continue;
      const node = nodes.get(current.id);
      if (!node) continue;
      state.set(current.id, "visiting");
      stack.push({ id: current.id, exit: true });
      for (let index = node.childIds.length - 1; index >= 0; index -= 1) {
        const childId = node.childIds[index];
        if (childId !== undefined) stack.push({ id: childId, exit: false });
      }
    }
  }
  if (cycle) {
    context.addIssue({
      code: "custom",
      path: ["placement"],
      message: "Hierarchy contains a cycle",
    });
  }
  const visitedCount = [...state.values()].filter(
    (value) => value === "visited",
  ).length;
  if (visitedCount !== nodes.size) {
    context.addIssue({
      code: "custom",
      path: ["placement"],
      message: "Every hierarchy node must be reachable from a root",
    });
  }
}

export const normalizedModelSchema =
  normalizedModelShape.superRefine(validateModel);
export type NormalizedModel = z.infer<typeof normalizedModelSchema>;
