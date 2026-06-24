import { mcpPaginationParams } from "@cubby/schemas/pagination";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  deleteHandler,
  getByIdHandler,
  getCaller,
  idParam,
  idsParam,
  json,
  jsonError,
  listHandler,
  respond,
  respondList,
  slimInventory,
  withErrorHandling,
} from "./_shared";

export function registerInventoryTools(server: McpServer) {
  server.tool(
    "list_inventory",
    "List inventory entries with optional filters.",
    {
      productName: z.string().optional().describe("Filter by product name"),
      locationName: z.string().optional().describe("Filter by location name"),
      locationId: z.string().optional().describe("Filter by exact location ID"),
      ...mcpPaginationParams,
    },
    listHandler("inventory", slimInventory, {
      orderBy: "createdAt",
      direction: "desc",
      buildFilters: (p) => ({
        productNameFilter: p.productName,
        locationNameFilter: p.locationName,
        locationIdFilter: p.locationId,
      }),
    }),
  );

  server.tool(
    "get_inventory_entry",
    "Get a single inventory entry by ID.",
    { id: idParam("Inventory entry") },
    getByIdHandler("inventory", slimInventory),
  );

  server.tool(
    "create_inventory_entry",
    "Add a product to a location. Use search_products and list_locations first to get IDs.",
    {
      productId: idParam("Product"),
      locationId: idParam("Location"),
      value: z.number().positive().describe("Quantity value (must be > 0)"),
      unit: z.string().describe("Unit (e.g. 'each', 'lb', 'oz', 'cup')"),
    },
    withErrorHandling(async (params, extra) => {
      const caller = getCaller(extra);
      const result = await caller.inventory.create({
        productId: params.productId,
        locationId: params.locationId,
        amount: { value: params.value, unit: params.unit },
      });
      return respond(result, slimInventory);
    }),
  );

  server.tool(
    "update_inventory_entry",
    "Update an inventory entry's amount, product, or location. When updating amount, both value and unit must be provided together.",
    {
      id: idParam("Inventory entry"),
      value: z
        .number()
        .positive()
        .optional()
        .describe("New quantity value, must be > 0 (requires unit)"),
      unit: z.string().optional().describe("New unit (requires value)"),
      productId: idParam("Product").optional().describe("New product ID"),
      locationId: idParam("Location").optional().describe("New location ID"),
    },
    withErrorHandling(async (params, extra) => {
      const caller = getCaller(extra);
      const data: Record<string, unknown> = {};
      // Require both value and unit together to avoid silent defaults
      if (params.value !== undefined && params.unit !== undefined) {
        data.amount = { value: params.value, unit: params.unit };
      } else if (params.value !== undefined || params.unit !== undefined) {
        return jsonError(
          "Both value and unit must be provided together when updating amount.",
        );
      }
      if (params.productId !== undefined) data.productId = params.productId;
      if (params.locationId !== undefined) data.locationId = params.locationId;
      const result = await caller.inventory.update({ id: params.id, data });
      return respond(result, slimInventory);
    }),
  );

  server.tool(
    "delete_inventory_entries",
    "Soft-delete inventory entries by IDs.",
    { ids: idsParam("inventory entry") },
    deleteHandler("inventory"),
  );

  server.tool(
    "bulk_move_inventory",
    "Move inventory entries between locations. Supports partial moves.",
    {
      sourceLocationId: idParam("Source location"),
      targetLocationId: idParam("Target location"),
      items: z
        .array(
          z.object({
            inventoryEntryId: idParam("Inventory entry"),
            value: z
              .number()
              .positive()
              .describe("Quantity to move (must be > 0)"),
            unit: z.string().describe("Unit"),
          }),
        )
        .describe("Items to move with quantities"),
    },
    withErrorHandling(async (params, extra) => {
      const caller = getCaller(extra);
      const items = params.items as {
        inventoryEntryId: string;
        value: number;
        unit: string;
      }[];
      const result = await caller.inventory.bulkMove({
        sourceLocationId: params.sourceLocationId,
        targetLocationId: params.targetLocationId,
        items: items.map((item) => ({
          inventoryEntryId: item.inventoryEntryId,
          quantity: { value: item.value, unit: item.unit },
        })),
      });
      return respondList(result, slimInventory);
    }),
  );

  server.tool(
    "find_duplicate_inventory",
    "Find unique products (expectedQuantity = 1) that appear in more than one location — likely duplicates to consolidate.",
    {
      excludeLocationId: z
        .string()
        .optional()
        .describe("Ignore duplicates that involve this location"),
    },
    withErrorHandling(async (params, extra) => {
      const caller = getCaller(extra);
      const result = await caller.inventory.findDuplicates({
        excludeLocationId: params.excludeLocationId,
      });
      return json(result);
    }),
  );
}
