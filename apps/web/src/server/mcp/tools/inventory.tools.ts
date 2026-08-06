import {
  bulkMovePayload,
  inventoryFilterFields,
  inventoryMcpBulkMoveOut,
  inventoryMcpListOut,
  inventoryMcpOut,
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
        "Update an inventory entry's amount, product, or location. When updating amount, both value and unit must be provided together.",
      delete: "Soft-delete inventory entries by IDs.",
    },
    create: (caller, params) =>
      caller.inventory.create({
        productId: params.productId,
        locationId: params.locationId,
        amount: { value: params.value, unit: params.unit },
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

  registerMcpTool(server, {
    name: "bulk_move_inventory",
    description:
      "Move inventory entries between locations. Supports partial moves.",
    inputSchema: bulkMovePayload.shape,
    outputSchema: inventoryMcpBulkMoveOut,
    annotations: WRITE_DESTRUCTIVE_CLOSED,
    handler: async (params, extra) => {
      const caller = getCaller(extra);
      // The router returns `{ items, sideEffects }`; MCP publishes just the
      // moved rows (side effects are internal bookkeeping).
      const { items: moved } = await caller.inventory.bulkMove({
        sourceLocationId: params.sourceLocationId,
        targetLocationId: params.targetLocationId,
        items: params.items,
      });
      return respondList(moved, slimInventory);
    },
  });
}
