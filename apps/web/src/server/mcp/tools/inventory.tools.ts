import {
  inventoryDuplicateFindOut,
  inventoryFilterFields,
  inventoryMcpBulkMoveOut,
  inventoryMcpListOut,
  inventoryMcpOut,
  positiveAmount,
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
  resolveOptionalId,
  resolvePublicId,
  resolvePublicIds,
  respond,
  respondList,
  slimInventory,
  WRITE_CLOSED,
  WRITE_DESTRUCTIVE_CLOSED,
} from "./_shared";

/**
 * `inventoryFilterFields.locationIdFilter` is a branded uuid shared with the
 * tRPC router (apps/web/src/app/inventory/inventoryitemlist.tsx also filters
 * by it) — packages/schemas stays uuid-only, so the shortcode swap is local.
 */
const inventoryFilterMcpFields = {
  ...inventoryFilterFields,
  locationIdFilter: idParam("location")
    .optional()
    .describe("Filter by exact location shortcode"),
};

/**
 * `bulkMovePayload` (sourceLocationId/targetLocationId/items[].inventoryEntryId)
 * is shared with the tRPC router and the inventory-session workbench UI, so
 * this MCP-only shape is defined fresh rather than derived via `.extend()`
 * (the nested `items[]` object isn't separately exported to extend).
 */
const bulkMoveMcpInput = z.object({
  sourceLocationId: idParam("location"),
  targetLocationId: idParam("location"),
  items: z
    .array(
      z.object({
        inventoryEntryId: idParam("inventory"),
        quantity: positiveAmount,
      }),
    )
    .min(1),
});

export function registerInventoryTools(server: McpServer) {
  registerEntityListTool(server, {
    name: "list_inventory",
    description: "List inventory entries with optional filters.",
    router: "inventory",
    filterFields: inventoryFilterMcpFields,
    outputSchema: inventoryMcpListOut,
    slim: slimInventory,
    sort: { orderBy: "createdAt", direction: "desc" },
    annotations: READ_ONLY_CLOSED,
    buildFilters: async (caller, params) => {
      const filters: Record<string, unknown> = {};
      for (const key of [
        "productNameFilter",
        "locationNameFilter",
        "manufacturerFilter",
        "categoryFilter",
      ] as const) {
        if (params[key] !== undefined) filters[key] = params[key];
      }
      if (params.locationIdFilter !== undefined) {
        filters.locationIdFilter = await resolveOptionalId(
          caller,
          "location",
          params.locationIdFilter as string,
        );
      }
      return filters;
    },
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
        productId: await resolvePublicId(caller, "product", params.productId),
        locationId: await resolvePublicId(
          caller,
          "location",
          params.locationId,
        ),
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
        data.productId = await resolvePublicId(
          caller,
          "product",
          params.productId,
        );
      }
      if (params.locationId !== undefined) {
        data.locationId = await resolvePublicId(
          caller,
          "location",
          params.locationId,
        );
      }
      const result = await caller.inventory.update({
        id: await resolvePublicId(caller, "inventory", params.id),
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
    inputSchema: bulkMoveMcpInput.shape,
    outputSchema: inventoryMcpBulkMoveOut,
    annotations: WRITE_DESTRUCTIVE_CLOSED,
    handler: async (params, extra) => {
      const caller = getCaller(extra);
      const items = params.items as Array<{
        inventoryEntryId: string;
        quantity: { value: number; unit: string };
      }>;
      // resolvePublicIds returns exactly one id per input code, in order —
      // both `!`s below index a result whose length matches its own input.
      const [sourceLocationId, targetLocationId] = await resolvePublicIds(
        caller,
        "location",
        [params.sourceLocationId, params.targetLocationId],
      );
      const entryIds = await resolvePublicIds(
        caller,
        "inventory",
        items.map((item) => item.inventoryEntryId),
      );
      const result = await caller.inventory.bulkMove({
        sourceLocationId: sourceLocationId!,
        targetLocationId: targetLocationId!,
        items: items.map((item, i) => ({
          inventoryEntryId: entryIds[i]!,
          quantity: item.quantity,
        })),
      });
      return respondList(result, slimInventory);
    },
  });

  registerMcpTool(server, {
    name: "find_duplicate_inventory",
    description:
      "Find unique products (expectedQuantity = 1) that appear in more than one location — likely duplicates to consolidate.",
    inputSchema: {
      excludeLocationId: idParam("location")
        .optional()
        .describe("Ignore duplicates that involve this location"),
    },
    outputSchema: inventoryDuplicateFindOut,
    annotations: READ_ONLY_CLOSED,
    handler: async (params, extra) => {
      const caller = getCaller(extra);
      const excludeLocationId = await resolveOptionalId(
        caller,
        "location",
        params.excludeLocationId,
      );
      const result = await caller.inventory.findDuplicates({
        // The filter is "omit this location", so a null code is just absence.
        excludeLocationId: excludeLocationId ?? undefined,
      });
      return { items: result };
    },
  });
}
