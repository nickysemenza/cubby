import {
  inventoryFilterFields,
  inventoryMcpBulkMoveOut,
  inventoryMcpListOut,
  inventoryMcpOut,
  inventoryPlacement,
  moveInventoryEntriesPayload,
} from "@cubby/schemas/inventory";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  getCaller,
  idParam,
  registerEntityCrudToolset,
  registerMcpTool,
  respondList,
  slimInventory,
  WRITE_DESTRUCTIVE_CLOSED,
} from "./_shared";

export function registerInventoryTools(server: McpServer) {
  registerEntityCrudToolset(server, {
    entity: "inventory",
    // Every tool here is renamed: the entity is "inventory" but a row is an
    // "inventory entry", so the derived `${entityPlural}` names would read
    // `create_inventorys`.
    names: {
      list: "list_inventory",
      get: "get_inventory_entry",
      create: "create_inventory_entry",
      update: "update_inventory_entry",
      delete: "delete_inventory_entries",
      batchCreate: "create_inventory_entries",
      batchUpdate: "update_inventory_entries",
    },
    createInput: {
      productId: idParam("product"),
      locationId: idParam("location"),
      value: z.number().positive().describe("Quantity value (must be > 0)"),
      unit: z.string().describe("Unit (e.g. 'each', 'lb', 'oz', 'cup')"),
      placement: inventoryPlacement
        .optional()
        .describe(
          "Defaults to 'stock'. Pass 'installed' for a fixture wired or plumbed in — the row is kept but excluded from browsing, counting and recounts.",
        ),
    },
    updateShape: {
      value: z
        .number()
        .positive()
        .optional()
        .describe("New quantity value, must be > 0 (requires unit)"),
      unit: z.string().optional().describe("New unit (requires value)"),
      productId: idParam("product")
        .optional()
        .describe("Move the entry to this product"),
      locationId: idParam("location")
        .optional()
        .describe("Move the entry to this location"),
      placement: inventoryPlacement
        .optional()
        .describe(
          "'stock' = movable; 'installed' = a fixed installation. Flipping this does NOT move the entry — it stays at its location and simply stops being counted.",
        ),
    },
    filterFields: inventoryFilterFields,
    mcpListOut: inventoryMcpListOut,
    out: inventoryMcpOut,
    slim: slimInventory,
    sort: { orderBy: "createdAt", direction: "desc" },
    descriptions: {
      list: "List inventory entries with optional filters.",
      get: "Get a single inventory entry by ID.",
      create:
        "Add a product to a location. Use search_products and list_locations first to get IDs.",
      update:
        "Update an inventory entry's amount, product, location, or placement. When updating amount, both value and unit must be provided together.",
      delete: "Soft-delete inventory entries by IDs.",
    },
    create: (caller, params) =>
      caller.inventory.create({
        productId: params.productId,
        locationId: params.locationId,
        amount: { value: params.value, unit: params.unit },
        ...(params.placement ? { placement: params.placement } : {}),
      }),
    // The generic update handler hands `data` everything but `id`; fold the
    // flat `value`/`unit` pair the tool advertises into the `amount` object
    // the router expects, and require both together — matching create_*'s
    // combined amount shape rather than allowing a partial, ambiguous edit.
    resolveUpdateData: (_caller, data) => {
      const { value, unit, ...rest } = data;
      if (value !== undefined && unit !== undefined) {
        return { ...rest, amount: { value, unit } };
      }
      if (value !== undefined || unit !== undefined) {
        throw new Error(
          "Both value and unit must be provided together when updating amount.",
        );
      }
      return rest;
    },
  });

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
