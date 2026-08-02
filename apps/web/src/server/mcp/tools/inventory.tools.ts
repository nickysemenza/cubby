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
  READ_ONLY_CLOSED,
  registerEntityDeleteTool,
  registerEntityGetTool,
  registerEntityListTool,
  registerMcpTool,
  respond,
  respondList,
  slimInventory,
  WRITE_CLOSED,
  WRITE_DESTRUCTIVE_CLOSED,
} from "./_shared";

export function registerInventoryTools(server: McpServer) {
  registerEntityListTool(server, {
    name: "list_inventory",
    description: "List inventory entries with optional filters.",
    router: "inventory",
    filterFields: inventoryFilterFields,
    outputSchema: inventoryMcpListOut,
    slim: slimInventory,
    sort: { orderBy: "createdAt", direction: "desc" },
    annotations: READ_ONLY_CLOSED,
  });

  registerEntityGetTool(server, {
    name: "get_inventory_entry",
    description: "Get a single inventory entry by ID.",
    router: "inventory",
    entity: "inventory",
    outputSchema: inventoryMcpOut,
    slim: slimInventory,
    annotations: READ_ONLY_CLOSED,
  });

  registerMcpTool(server, {
    name: "create_inventory_entry",
    description:
      "Add a product to a location. Use search_products and list_locations first to get IDs.",
    inputSchema: {
      productId: idParam("product"),
      locationId: idParam("location"),
      value: z.number().positive().describe("Quantity value (must be > 0)"),
      unit: z.string().describe("Unit (e.g. 'each', 'lb', 'oz', 'cup')"),
    },
    outputSchema: inventoryMcpOut,
    annotations: WRITE_CLOSED,
    handler: async (params, extra) => {
      const caller = getCaller(extra);
      const result = await caller.inventory.create({
        productId: params.productId,
        locationId: params.locationId,
        amount: { value: params.value, unit: params.unit },
      });
      return respond(result, slimInventory);
    },
  });

  registerMcpTool(server, {
    name: "update_inventory_entry",
    description:
      "Update an inventory entry's amount, product, or location. When updating amount, both value and unit must be provided together.",
    inputSchema: {
      id: idParam("inventory"),
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
    outputSchema: inventoryMcpOut,
    annotations: WRITE_CLOSED,
    handler: async (params, extra) => {
      const caller = getCaller(extra);
      const data: Record<string, unknown> = {};
      if (params.value !== undefined && params.unit !== undefined) {
        data.amount = { value: params.value, unit: params.unit };
      } else if (params.value !== undefined || params.unit !== undefined) {
        throw new Error(
          "Both value and unit must be provided together when updating amount.",
        );
      }
      if (params.productId !== undefined) {
        data.productId = params.productId;
      }
      if (params.locationId !== undefined) {
        data.locationId = params.locationId;
      }
      const result = await caller.inventory.update({
        id: params.id,
        data,
      });
      return respond(result, slimInventory);
    },
  });

  registerEntityDeleteTool(server, {
    name: "delete_inventory_entries",
    description: "Soft-delete inventory entries by IDs.",
    router: "inventory",
    entity: "inventory",
    annotations: WRITE_DESTRUCTIVE_CLOSED,
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
