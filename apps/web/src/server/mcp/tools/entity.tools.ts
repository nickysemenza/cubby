import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  type EntityCommand,
  type EntityKernelContext,
  executeEntity,
} from "~/server/entity-kernel";
import {
  ENTITY_KERNEL_ENTITIES,
  entityCommandSchema,
  entityMutationResultSchema,
  entityQueryResultSchema,
} from "~/server/entity-kernel/contracts";

import { getEntityKernelContext } from "../kernel-context";
import { registerMcpTool, WRITE_DESTRUCTIVE_CLOSED } from "./_shared";

const entityToolInput = z.object({ command: entityCommandSchema });

const entityToolOutput = z.union([
  entityQueryResultSchema,
  entityMutationResultSchema,
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
            commandSchema: z.toJSONSchema(entityCommandSchema),
          }),
        },
      ],
    }),
  );

  registerMcpTool(server, {
    name: "entity",
    description:
      "Read or mutate one supported household entity through { command }. Read entities://catalog first: it publishes the supported entity list and exact action union. This replaces per-entity CRUD tools; workflow-shaped tools remain separate.",
    inputSchema: entityToolInput,
    outputSchema: entityToolOutput,
    annotations: WRITE_DESTRUCTIVE_CLOSED,
    telemetryEntity: (params) => params.command.entity,
    handler: async (params, extra) =>
      await runEntity(getEntityKernelContext(extra), params.command),
  });
}
