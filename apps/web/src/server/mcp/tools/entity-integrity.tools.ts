/**
 * Entity-integrity MCP tools — advisory attach/detach planning before a write.
 */

import { previewOperationSchema } from "@cubby/schemas/entity-integrity";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  generatedMcpEntityRelationCommandSchema,
  generatedMcpEntityRelationPreviewInputSchema,
} from "~/server/generated/entity-relation-contracts.gen";
import { previewOperation } from "~/server/workflows/entity-integrity-preview.server";

import { READ_ONLY_CLOSED, registerRouterTool } from "./_shared";

export function registerEntityIntegrityTools(server: McpServer) {
  registerRouterTool(server, {
    name: "preview_entity_operation",
    description:
      "Preview what an attach or detach would do before running it. Read-only: it performs no writes and changes nothing. Returns `blockers`, `changes`, and `sideEffects`, each with a total and per-target-id breakdown. `canProceed` is false when a blocker was found. Results describe the database right now and are advisory only: the mutation re-validates in its own transaction, so concurrent changes can invalidate a clean preview.",
    inputSchema: generatedMcpEntityRelationPreviewInputSchema,
    outputSchema: previewOperationSchema,
    annotations: READ_ONLY_CLOSED,
    readPolicy: () => "strong",
    call: (context, params) =>
      previewOperation(
        context.readDb,
        generatedMcpEntityRelationCommandSchema.parse(params),
        new Date(),
      ),
  });
}
