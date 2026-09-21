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
  entityCommandSchema,
  entityMcpCommandSchema,
  entityMcpReadCommandSchema,
  entityDeleteResultSchema,
  entityRelationMutationResultSchema,
  entitySearchResultSchema,
} from "~/server/entity-kernel/contracts";
import {
  entityPreviewInputSchema,
  entityPreviewOutputSchema,
  previewEntity,
} from "~/server/entity-kernel/preview";
import {
  generatedMcpEntityCreateCommandSchema,
  generatedMcpEntityGetResultSchema,
  generatedMcpEntityListResultSchema,
  generatedMcpEntityMergeResultSchema,
  generatedMcpEntityMutationCreateResultSchema,
  generatedMcpEntityMutationUpdateResultSchema,
  generatedMcpEntityUpdateCommandSchema,
} from "~/server/generated/entity-bindings.gen";

import { getEntityKernelContext } from "../kernel-context";
import {
  registerBatchTool,
  registerMcpTool,
  READ_ONLY_CLOSED,
  WRITE_DESTRUCTIVE_CLOSED,
} from "./_shared";
import {
  entitySummaryResultSchema,
  projectEntityResult,
} from "./response-projection";
import type { McpToolRegistrationRuntime } from "./tool-registration";

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
  entitySummaryResultSchema,
]);

const kernelCommand = (
  command: z.infer<typeof entityMcpCommandSchema>,
): EntityCommand => {
  if (!("resultDetail" in command)) return entityCommandSchema.parse(command);
  const { resultDetail: _resultDetail, ...rest } = command;
  return entityCommandSchema.parse(rest);
};

/**
 * `entity_batch` carries create and update commands only. Delete and bulkUpdate
 * already take `ids[]`; merge, attach and detach are deliberate one-at-a-time
 * decisions. Each item is the ordinary kernel command, so the per-entity input
 * schema, side effects and error shape are exactly those of `entity`.
 */
const entityBatchItemInput = z.union([
  generatedMcpEntityCreateCommandSchema,
  generatedMcpEntityUpdateCommandSchema,
]);
const entityBatchItemOutput = z.union([
  generatedMcpEntityMutationCreateResultSchema,
  generatedMcpEntityMutationUpdateResultSchema,
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
  runtime?: McpToolRegistrationRuntime,
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
            preview: {
              tool: "entity_preview",
              inputSchema: z.toJSONSchema(entityPreviewInputSchema),
              outputSchema: z.toJSONSchema(entityPreviewOutputSchema),
              writes: false,
            },
            batchPreview: {
              tool: "entity_batch_preview",
              itemInputSchema: z.toJSONSchema(entityPreviewInputSchema),
              itemOutputSchema: z.toJSONSchema(entityPreviewOutputSchema),
              maxItems: 50,
              writes: false,
            },
          }),
        },
      ],
    }),
  );

  registerMcpTool(
    server,
    {
      name: "get_entities",
      description:
        "Get, list, or search household entities through { command }. This read-only capability accepts only get, list, and search actions. Ingredient usuallyOnHand means assumed planning availability; recorded inventory remains separate. Recipe availability includes planning coverage and incomplete-quantity warnings.",
      inputSchema: entityReadToolInput,
      outputSchema: z.union([entityReadToolOutput, entitySummaryResultSchema]),
      annotations: READ_ONLY_CLOSED,
      telemetryEntity: (params) =>
        entityMcpReadCommandSchema.parse(params.command).entity,
      handler: async (params, extra) => {
        const command = entityMcpReadCommandSchema.parse(params.command);
        const result = await runEntity(
          getEntityKernelContext(extra),
          kernelCommand(command),
        );
        // SAFETY: the shared registration seam parses this projection through
        // the declared union once before emitting either MCP representation.
        return projectEntityResult(command, result) as z.output<
          typeof entityReadToolOutput | typeof entitySummaryResultSchema
        >;
      },
    },
    runtime,
  );

  registerMcpTool(
    server,
    {
      name: "entity_preview",
      description:
        "Preview a create for any entity before writing it. Contextual seeds are merged first, explicit data wins, and manifest-declared Jev suggestions are returned with confidence and provenance. This operation never writes.",
      inputSchema: entityPreviewInputSchema,
      outputSchema: entityPreviewOutputSchema,
      annotations: READ_ONLY_CLOSED,
      telemetryEntity: (params) =>
        entityPreviewInputSchema.parse(params).entity,
      handler: async (params, extra) =>
        entityPreviewOutputSchema.parse(
          await previewEntity(getEntityKernelContext(extra), params),
        ),
    },
    runtime,
  );

  registerMcpTool(
    server,
    {
      name: "entity",
      description:
        'Read or mutate one supported household entity through { command }. Start with this tool\'s published command schema; consult entities://catalog only when the supported entity/action remains unclear. This replaces per-entity CRUD tools; workflow-shaped tools remain separate. For many creates/updates in one call use entity_batch. Merge example: {command:{action:"merge",entity:"product",keepId:"PRD-2ABC",mergeIds:["PRD-3DEF"]}}.',
      inputSchema: entityToolInput,
      outputSchema: entityToolOutput,
      annotations: WRITE_DESTRUCTIVE_CLOSED,
      isMutation: (params) => {
        const command = entityMcpCommandSchema.parse(params.command);
        return !["get", "list", "search"].includes(command.action);
      },
      telemetryEntity: (params) =>
        entityMcpCommandSchema.parse(params.command).entity,
      handler: async (params, extra) => {
        const command = entityMcpCommandSchema.parse(params.command);
        const result = await runEntity(
          getEntityKernelContext(extra),
          kernelCommand(command),
        );
        // SAFETY: the shared registration seam parses this projection through
        // the declared union once before emitting either MCP representation.
        return projectEntityResult(command, result) as z.output<
          typeof entityToolOutput
        >;
      },
    },
    runtime,
  );

  registerBatchTool(
    server,
    {
      name: "entity_batch_preview",
      description:
        "Preview up to 50 entity creates without writing. Each item is evaluated independently using the same generated create schema and Jev suggestion pipeline as entity_preview.",
      itemInputSchema: entityPreviewInputSchema,
      itemOutputSchema: entityPreviewOutputSchema,
      projectReference: (result) =>
        `${result.entity}:${String(result.proposed.id ?? "preview")}`,
      annotations: READ_ONLY_CLOSED,
      telemetryEntity: ({ items }) => items[0]?.entity,
      run: async (_caller, item, context) => {
        if (!context)
          throw new Error("Authenticated entity-kernel context is missing");
        return entityPreviewOutputSchema.parse(
          await previewEntity(context, item),
        );
      },
    },
    runtime,
  );

  registerBatchTool(
    server,
    {
      name: "entity_batch",
      description:
        "Run up to 50 entity create/update commands in request order, each with the same validation, side effects and result shape as the `entity` tool. Items succeed or fail independently — a failed item does not stop or roll back the others — so read every result. Use this instead of 50 separate `entity` calls when importing a receipt's lines or promoting a batch of products.",
      itemInputSchema: entityBatchItemInput,
      itemOutputSchema: entityBatchItemOutput,
      projectReference: (result) => result.item.id,
      annotations: WRITE_DESTRUCTIVE_CLOSED,
      telemetryEntity: ({ items }) => items[0]?.entity,
      run: async (_caller, item, context) => {
        if (!context)
          throw new Error("Authenticated entity-kernel context is missing");
        return entityBatchItemOutput.parse(await runEntity(context, item));
      },
    },
    runtime,
  );
}
