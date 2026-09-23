/**
 * Entity-integrity MCP tools — advisory attach/detach planning before a write.
 */

import {
  entityConnectionsInput,
  entityConnectionsOut,
} from "@cubby/schemas/entity-connections";
import { previewOperationSchema } from "@cubby/schemas/entity-integrity";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  generatedMcpEntityRelationCommandSchema,
  generatedMcpEntityRelationPreviewInputSchema,
} from "~/server/generated/entity-relation-contracts.gen";

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
    call: (caller, params) =>
      caller.entityIntegrity.previewOperation(
        generatedMcpEntityRelationCommandSchema.parse(params),
      ),
  });

  registerRouterTool(server, {
    name: "get_entity_connections",
    description:
      'One-hop physical connections of any entity: what points at it (`incoming`) and what it points at (`outgoing`), grouped by edge with a count and the first linked records. A merged-away code reads its survivor and reports `redirectedFrom`. Pass `operation: "delete"` or `"merge"` to see each incoming group\'s declared disposition (block, detach, repoint, ...) before running it; the preview is advisory and the mutation re-validates.',
    inputSchema: entityConnectionsInput,
    outputSchema: entityConnectionsOut,
    annotations: READ_ONLY_CLOSED,
    readPolicy: () => "strong",
    call: (caller, params) => caller.entityGraph.connections(params),
  });
}
