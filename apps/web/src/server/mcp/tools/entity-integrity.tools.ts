/**
 * Entity-integrity MCP tools — "what would this destructive operation actually
 * do?", answered before doing it.
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
      "Preview what a delete or merge would do BEFORE running it. Read-only: it performs no writes and changes nothing. Returns `blockers` (things that will make the operation fail), `changes` (rows that will be soft-deleted, hard-deleted, detached, re-pointed, or deduplicated), and `sideEffects` (recomputes, search-index cleanup, and other consequences with no row count), each with a total and a per-target-id breakdown so a bulk operation shows WHICH target carries the problem. `canProceed` is false when a blocker was found. Call this before any delete_* or merge_* tool when the targets might have dependents — a product with inventory, a cookbook whose recipes will cascade, an ingredient still used by recipes — so you can report the consequences rather than discovering them from an error. IMPORTANT: results describe the database as it is right now and are advisory only. They are not a lock or an approval: the mutation re-validates everything in its own transaction, so it can still refuse even after a clean preview, and concurrent changes can invalidate a preview between the two calls. For a merge, omit `keepId` to get `candidates` — per-candidate ranking data (weight plus the underlying counts) for choosing which record to keep — then call again with the chosen `keepId` for the real impact.",
    inputSchema: previewOperationInputSchema,
    outputSchema: previewOperationSchema,
    annotations: READ_ONLY_CLOSED,
    call: (caller, params) => caller.entityIntegrity.previewOperation(params),
  });
}
