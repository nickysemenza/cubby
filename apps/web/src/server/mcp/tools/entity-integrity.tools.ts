/**
 * Entity-integrity MCP tools — "what would this merge, attach, or detach
 * actually do?", answered before doing it.
 *
 * Delete has no preview: `delete_entity`'s structured refusal (a typed
 * `reason` plus, where the guard can attribute it, `blockers`) IS the
 * contract — attempt the delete and read what it says, rather than asking
 * twice.
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
      "Preview what a merge, attach, or detach would do BEFORE running it. Read-only: it performs no writes and changes nothing. Returns `blockers` (things that will make the operation fail), `changes` (rows that will be detached, re-pointed, or deduplicated), and `sideEffects` (recomputes, search-index cleanup, and other consequences with no row count), each with a total and a per-target-id breakdown so a bulk operation shows WHICH target carries the problem. `canProceed` is false when a blocker was found. Call this before any merge_* or attach_entity/detach_entity call when the targets might have dependents — an ingredient still used by recipes, a purchase that would collide on order id. There is no delete preview: call delete_entity directly and read its `refusal` object, which names what blocked it. IMPORTANT: results describe the database as it is right now and are advisory only. They are not a lock or an approval: the mutation re-validates everything in its own transaction, so it can still refuse even after a clean preview, and concurrent changes can invalidate a preview between the two calls. For a merge, omit `keepId` to get `candidates` — per-candidate ranking data (weight plus the underlying counts) for choosing which record to keep — then call again with the chosen `keepId` for the real impact.",
    inputSchema: previewOperationInputSchema,
    outputSchema: previewOperationSchema,
    annotations: READ_ONLY_CLOSED,
    call: (caller, params) => caller.entityIntegrity.previewOperation(params),
  });
}
