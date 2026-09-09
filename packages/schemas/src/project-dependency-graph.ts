import { z } from "zod";

import { projectShortcode, taskShortcode } from "./identifiers";
import { plainDate } from "./base-entity";

export const projectGraphNodeId = z.union([projectShortcode, taskShortcode]);

const projectGraphNodeSchema = z.object({
  id: projectGraphNodeId,
  kind: z.enum(["project", "task"]),
  name: z.string(),
  status: z.string(),
  locations: z.array(z.string()).optional(),
  dueDate: plainDate.nullable(),
  dueEndDate: plainDate.nullable(),
  parentId: projectGraphNodeId.nullable(),
  external: z.boolean(),
});

const projectGraphEdgeSchema = z.object({
  source: projectGraphNodeId,
  target: projectGraphNodeId,
  kind: z.enum(["hierarchy", "dependency"]),
});

/** An optional project root; its complete live subtree is the graph scope. */
export const projectDependencyGraphInput = z
  .object({ projectId: projectShortcode.optional() })
  .optional();

export const projectDependencyGraphSchema = z.object({
  nodes: z.array(projectGraphNodeSchema),
  edges: z.array(projectGraphEdgeSchema),
});

export type ProjectGraphNode = z.infer<typeof projectGraphNodeSchema>;
export type ProjectGraphEdge = z.infer<typeof projectGraphEdgeSchema>;
export type ProjectDependencyGraph = z.infer<
  typeof projectDependencyGraphSchema
>;
