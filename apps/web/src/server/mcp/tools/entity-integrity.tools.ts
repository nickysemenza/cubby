/**
 * Entity-integrity MCP tools — advisory attach/detach planning before a write.
 */

import {
  previewOperationInputSchema,
  previewOperationSchema,
} from "@cubby/schemas/entity-integrity";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { READ_ONLY_CLOSED, registerRouterTool } from "./_shared";

export function registerEntityIntegrityTools(server: McpServer) {
  registerRouterTool(server, {
    name: "preview_entity_operation",
    description:
      "Preview what an attach or detach would do before running it. Read-only: it performs no writes and changes nothing. Returns `blockers`, `changes`, and `sideEffects`, each with a total and per-target-id breakdown. `canProceed` is false when a blocker was found. Results describe the database right now and are advisory only: the mutation re-validates in its own transaction, so concurrent changes can invalidate a clean preview.",
    inputSchema: previewOperationInputSchema,
    outputSchema: previewOperationSchema,
    annotations: READ_ONLY_CLOSED,
    call: (caller, params) => caller.entityIntegrity.previewOperation(params),
  });
}
