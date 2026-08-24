import {
  inventoryMcpBulkMoveOut,
  moveInventoryEntriesPayload,
} from "@cubby/schemas/inventory";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  getCaller,
  registerMcpTool,
  respondList,
  slimInventory,
  WRITE_DESTRUCTIVE_CLOSED,
} from "./_shared";

export function registerInventoryTools(server: McpServer) {
  // Replaces `bulk_move_inventory`, which pinned ONE source and ONE target for
  // the whole call and so could only express "empty this shelf into that one".
  // Reorganizing is inherently many→many, and the old shape turned a shelf
  // fanning out across twelve drawers into a run of single-entry updates. This
  // is a strict superset: the source is derivable from the entry, and per-item
  // `quantity` still covers partial moves.
  registerMcpTool(server, {
    name: "move_inventory_entries",
    description:
      "Move inventory entries to per-item destination locations, in one atomic call. Each item names an entry and where it should end up, so a single call can fan one location out across many, consolidate many into one, or both. Omit an item's quantity to move the whole entry; include it for a partial move, and list one entry twice to split it across destinations. Entries merge into an existing entry for the same product at the destination. The source location is not asked for — an entry already knows where it is.",
    inputSchema: moveInventoryEntriesPayload.shape,
    outputSchema: inventoryMcpBulkMoveOut,
    annotations: WRITE_DESTRUCTIVE_CLOSED,
    handler: async (params, extra) => {
      const caller = getCaller(extra);
      // The router returns `{ items, sideEffects }`; MCP publishes just the
      // moved rows (side effects are internal bookkeeping).
      const { items: moved } = await caller.inventory.moveEntries({
        items: params.items,
      });
      return respondList(moved, slimInventory);
    },
  });
}
