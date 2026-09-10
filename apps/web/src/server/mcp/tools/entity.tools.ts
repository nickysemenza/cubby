import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  type EntityCommand,
  type EntityKernelContext,
  executeEntity,
} from "~/server/entity-kernel";
import {
  entityBulkUpdateResultSchema,
  ENTITY_KERNEL_ENTITIES,
  entityMcpCommandSchema,
  entityMcpReadCommandSchema,
  entityDeleteResultSchema,
  entityRelationMutationResultSchema,
  entitySearchResultSchema,
} from "~/server/entity-kernel/contracts";
import {
  generatedMcpEntityGetResultSchema,
  generatedMcpEntityListResultSchema,
  generatedMcpEntityMergeResultSchema,
  generatedMcpEntityMutationCreateResultSchema,
  generatedMcpEntityMutationUpdateResultSchema,
} from "~/server/generated/entity-bindings.gen";

import { getEntityKernelContext } from "../kernel-context";
import {
  registerMcpTool,
  READ_ONLY_CLOSED,
  WRITE_DESTRUCTIVE_CLOSED,
} from "./_shared";

const entityToolInput = z.object({ command: entityMcpCommandSchema });
const entityReadToolInput = z.object({ command: entityMcpReadCommandSchema });

const entityReadToolOutput = z.union([
  generatedMcpEntityGetResultSchema,
  generatedMcpEntityListResultSchema,
  entitySearchResultSchema,
]);
const entityToolOutput = z.union([
  entityReadToolOutput,
  generatedMcpEntityMutationCreateResultSchema,
  generatedMcpEntityMutationUpdateResultSchema,
  generatedMcpEntityMergeResultSchema,
  entityDeleteResultSchema,
  entityBulkUpdateResultSchema,
  entityRelationMutationResultSchema,
]);

type EntityResult = z.infer<typeof entityToolOutput>;

/** A single command-shaped executor makes the MCP port mock-free and overload-free. */
export type ExecuteEntity = (
  context: EntityKernelContext,
  command: EntityCommand,
) => Promise<EntityResult>;

const runKernelEntity: ExecuteEntity = async (context, command) =>
  executeEntity(context, command);

export function registerEntityTools(
  server: McpServer,
  runEntity: ExecuteEntity = runKernelEntity,
) {
  server.registerResource(
    "entities_catalog",
    "entities://catalog",
    {
      description:
        "The entity command contract: supported entities, actions, and the precise command JSON Schema.",
      mimeType: "application/json",
    },
    async () => ({
      contents: [
        {
          uri: "entities://catalog",
          mimeType: "application/json",
          text: JSON.stringify({
            entities: ENTITY_KERNEL_ENTITIES,
            commandSchema: z.toJSONSchema(entityMcpCommandSchema),
          }),
        },
      ],
    }),
  );

  registerMcpTool(server, {
    name: "get_entities",
    description:
      "Get, list, or search household entities through { command }. This read-only capability accepts only get, list, and search actions. Ingredient usuallyOnHand means assumed planning availability; recorded inventory remains separate. Recipe availability includes planning coverage and incomplete-quantity warnings.",
    inputSchema: entityReadToolInput,
    outputSchema: entityReadToolOutput,
    annotations: READ_ONLY_CLOSED,
    telemetryEntity: (params) => params.command.entity,
    handler: async (params, extra) =>
      entityReadToolOutput.parse(
        await runEntity(getEntityKernelContext(extra), params.command),
      ),
  });

  registerMcpTool(server, {
    name: "entity",
    description:
      "Read or mutate one supported household entity through { command }. Read entities://catalog first: it publishes the supported entity list and exact action union. This replaces per-entity CRUD tools; workflow-shaped tools remain separate.",
    inputSchema: entityToolInput,
    outputSchema: entityToolOutput,
    annotations: WRITE_DESTRUCTIVE_CLOSED,
    telemetryEntity: (params) => params.command.entity,
    handler: async (params, extra) =>
      entityToolOutput.parse(
        await runEntity(getEntityKernelContext(extra), params.command),
      ),
  });
}
