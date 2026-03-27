import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

/**
 * MCP Server for Cubby inventory and product management.
 *
 * Each request creates a fresh McpServer + transport (required by the SDK
 * for stateless mode — transport can't be reused and server can't reconnect).
 */

// biome-ignore lint/suspicious/noExplicitAny: server-side tRPC caller type
type Caller = any;

function getCaller(extra: {
  authInfo?: { extra?: Record<string, unknown> };
}): Caller {
  return extra.authInfo?.extra?.caller;
}

/** Wrap a tool handler with error handling that returns tRPC/Zod error details */
function withErrorHandling(
  fn: (
    params: Record<string, unknown>,
    extra: { authInfo?: { extra?: Record<string, unknown> } },
  ) => Promise<{ content: { type: "text"; text: string }[] }>,
) {
  return async (
    params: Record<string, unknown>,
    extra: { authInfo?: { extra?: Record<string, unknown> } },
  ) => {
    try {
      return await fn(params, extra);
    } catch (error) {
      let message: string;
      if (error instanceof TRPCError) {
        const reason = (error.cause as { reason?: string })?.reason;
        message = reason
          ? `${error.code}: ${error.message} (${reason})`
          : `${error.code}: ${error.message}`;
      } else if (error instanceof Error) {
        message = error.message;
      } else {
        message = String(error);
      }
      return {
        content: [{ type: "text" as const, text: message }],
        isError: true,
      };
    }
  };
}

/** JSON response helper — pretty-printed for readability in MCP clients */
function json(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

/** Strip heavy fields from location objects */
function slimLocation(loc: Record<string, unknown>) {
  return {
    id: loc.id,
    name: loc.name,
    shortcode: loc.shortcode,
    type: loc.type,
    parentName: (loc.parent as Record<string, unknown> | null)?.name ?? null,
  };
}

/** Strip heavy fields from inventory entries */
function slimInventory(entry: Record<string, unknown>) {
  const product = entry.product as Record<string, unknown> | null;
  const location = entry.location as Record<string, unknown> | null;
  return {
    id: entry.id,
    amount: entry.amount,
    valuation: entry.valuation,
    product: product
      ? {
          id: product.id,
          name: product.name,
          manufacturer: product.manufacturer,
          shortcode: product.shortcode,
        }
      : null,
    location: location ? { id: location.id, name: location.name } : null,
  };
}

/** Strip heavy fields from product objects */
function slimProduct(p: Record<string, unknown>) {
  return {
    id: p.id,
    name: p.name,
    shortcode: p.shortcode,
    manufacturer: p.manufacturer,
    upc: p.upc,
    category: p.category,
    price: p.price,
    expectedQuantity: p.expectedQuantity,
  };
}

function createMcpServer() {
  const server = new McpServer({
    name: "cubby",
    version: "1.0.0",
  });
  registerTools(server);
  return server;
}

/** Handle an authenticated MCP request (per-request server+transport for stateless mode) */
export async function handleMcpRequest(
  request: Request,
  authInfo: AuthInfo,
): Promise<Response> {
  const server = createMcpServer();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  return transport.handleRequest(request, { authInfo });
}

function registerTools(server: McpServer) {
  // ---------------------------------------------------------------------------
  // Inventory tools
  // ---------------------------------------------------------------------------

  server.tool(
    "list_inventory",
    "List inventory entries with optional filters.",
    {
      productName: z.string().optional().describe("Filter by product name"),
      locationName: z.string().optional().describe("Filter by location name"),
      locationId: z.string().optional().describe("Filter by exact location ID"),
      pageIndex: z
        .number()
        .optional()
        .describe("Page index, 0-based (default 0)"),
      pageSize: z.number().optional().describe("Items per page (default 50)"),
    },
    withErrorHandling(async (params, extra) => {
      const caller = getCaller(extra);
      const result = await caller.inventory.list({
        filters: {
          productNameFilter: params.productName,
          locationNameFilter: params.locationName,
          locationIdFilter: params.locationId,
        },
        sort: { orderBy: "createdAt", direction: "desc" },
        pagination: {
          pageIndex: (params.pageIndex as number) ?? 0,
          pageSize: (params.pageSize as number) ?? 50,
        },
      });
      return json({
        meta: result.meta,
        items: result.items.map((i: Record<string, unknown>) =>
          slimInventory(i),
        ),
      });
    }),
  );

  server.tool(
    "get_inventory_entry",
    "Get a single inventory entry by ID.",
    { id: z.string().describe("Inventory entry ID") },
    withErrorHandling(async (params, extra) => {
      const caller = getCaller(extra);
      const result = await caller.inventory.getByID({ id: params.id });
      return json(slimInventory(result as Record<string, unknown>));
    }),
  );

  server.tool(
    "create_inventory_entry",
    "Add a product to a location. Use search_products and list_locations first to get IDs.",
    {
      productId: z.string().describe("Product ID"),
      locationId: z.string().describe("Location ID"),
      value: z.number().describe("Quantity value"),
      unit: z.string().describe("Unit (e.g. 'each', 'lb', 'oz', 'cup')"),
    },
    withErrorHandling(async (params, extra) => {
      const caller = getCaller(extra);
      const result = await caller.inventory.create({
        productId: params.productId,
        locationId: params.locationId,
        amount: { value: params.value, unit: params.unit },
      });
      return json(slimInventory(result as Record<string, unknown>));
    }),
  );

  server.tool(
    "update_inventory_entry",
    "Update an inventory entry's amount, product, or location.",
    {
      id: z.string().describe("Inventory entry ID"),
      value: z.number().optional().describe("New quantity value"),
      unit: z.string().optional().describe("New unit"),
      productId: z.string().optional().describe("New product ID"),
      locationId: z.string().optional().describe("New location ID"),
    },
    withErrorHandling(async (params, extra) => {
      const caller = getCaller(extra);
      const data: Record<string, unknown> = {};
      if (params.value !== undefined || params.unit !== undefined) {
        data.amount = {
          value: (params.value as number) ?? 0,
          unit: (params.unit as string) ?? "each",
        };
      }
      if (params.productId !== undefined) data.productId = params.productId;
      if (params.locationId !== undefined) data.locationId = params.locationId;
      const result = await caller.inventory.update({ id: params.id, data });
      return json(slimInventory(result as Record<string, unknown>));
    }),
  );

  server.tool(
    "delete_inventory_entries",
    "Soft-delete inventory entries by IDs.",
    {
      ids: z
        .array(z.string())
        .describe("Array of inventory entry IDs to delete"),
    },
    withErrorHandling(async (params, extra) => {
      const caller = getCaller(extra);
      await caller.inventory.delete({ ids: params.ids });
      return json({ deleted: (params.ids as string[]).length });
    }),
  );

  server.tool(
    "bulk_move_inventory",
    "Move inventory entries between locations. Supports partial moves.",
    {
      sourceLocationId: z.string().describe("Source location ID"),
      targetLocationId: z.string().describe("Target location ID"),
      items: z
        .array(
          z.object({
            inventoryEntryId: z.string().describe("Inventory entry ID to move"),
            value: z.number().describe("Quantity to move"),
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
      return json(
        (result as Record<string, unknown>[]).map((i) => slimInventory(i)),
      );
    }),
  );

  // ---------------------------------------------------------------------------
  // Product tools
  // ---------------------------------------------------------------------------

  server.tool(
    "search_products",
    "Search products by name, manufacturer, UPC, or category.",
    {
      name: z.string().optional().describe("Filter by product name"),
      manufacturer: z.string().optional().describe("Filter by manufacturer"),
      upc: z.string().optional().describe("Filter by UPC code"),
      category: z.string().optional().describe("Filter by category"),
      pageIndex: z
        .number()
        .optional()
        .describe("Page index, 0-based (default 0)"),
      pageSize: z.number().optional().describe("Items per page (default 50)"),
    },
    withErrorHandling(async (params, extra) => {
      const caller = getCaller(extra);
      const result = await caller.product.list({
        filters: {
          nameFilter: params.name,
          manufacturerFilter: params.manufacturer,
          upcFilter: params.upc,
          categoryFilter: params.category,
        },
        sort: { orderBy: "name", direction: "asc" },
        pagination: {
          pageIndex: (params.pageIndex as number) ?? 0,
          pageSize: (params.pageSize as number) ?? 50,
        },
      });
      return json({
        meta: result.meta,
        items: result.items.map((p: Record<string, unknown>) => slimProduct(p)),
      });
    }),
  );

  server.tool(
    "get_product",
    "Get a product by ID.",
    { id: z.string().describe("Product ID") },
    withErrorHandling(async (params, extra) => {
      const caller = getCaller(extra);
      const result = await caller.product.getByID({ id: params.id });
      return json(slimProduct(result as Record<string, unknown>));
    }),
  );

  server.tool(
    "create_product",
    "Create a new product. Use for items not found via search_products.",
    {
      name: z.string().describe("Product name"),
      manufacturer: z
        .string()
        .optional()
        .describe("Manufacturer (defaults to '(unspecified)')"),
      upc: z.string().optional().describe("UPC barcode"),
      price: z.number().optional().describe("Unit price in dollars"),
      expectedQuantity: z
        .number()
        .optional()
        .describe("Expected quantity (1 for unique items, null for unlimited)"),
    },
    withErrorHandling(async (params, extra) => {
      const caller = getCaller(extra);
      const result = await caller.product.quickCreate({
        name: params.name,
        manufacturer: params.manufacturer,
        upc: params.upc,
        price: params.price,
        expectedQuantity: params.expectedQuantity,
      });
      return json(slimProduct(result as Record<string, unknown>));
    }),
  );

  server.tool(
    "update_product",
    "Update a product's fields.",
    {
      id: z.string().describe("Product ID"),
      name: z.string().optional().describe("New name"),
      manufacturer: z.string().optional().describe("New manufacturer"),
      upc: z.string().optional().describe("New UPC"),
      price: z.number().optional().describe("New price"),
      category: z.string().optional().describe("New category"),
      notes: z.string().optional().describe("Notes or URLs"),
    },
    withErrorHandling(async (params, extra) => {
      const caller = getCaller(extra);
      const { id, ...data } = params;
      const cleanData = Object.fromEntries(
        Object.entries(data).filter(([, v]) => v !== undefined),
      );
      const result = await caller.product.update({ id, data: cleanData });
      return json(slimProduct(result as Record<string, unknown>));
    }),
  );

  server.tool(
    "delete_products",
    "Soft-delete products by IDs. Fails if products have inventory entries.",
    {
      ids: z.array(z.string()).describe("Array of product IDs to delete"),
    },
    withErrorHandling(async (params, extra) => {
      const caller = getCaller(extra);
      await caller.product.delete({ ids: params.ids });
      return json({ deleted: (params.ids as string[]).length });
    }),
  );

  server.tool(
    "find_product_by_upc",
    "Find or create a product by UPC barcode. Checks local DB, then USDA, then UPC lookup service.",
    {
      upc: z.string().describe("UPC barcode (12-14 digits)"),
      defaultName: z
        .string()
        .optional()
        .describe("Fallback name if not found in any database"),
    },
    withErrorHandling(async (params, extra) => {
      const caller = getCaller(extra);
      const result = await caller.product.findOrCreateByUPC({
        upc: params.upc,
        defaultName: params.defaultName,
      });
      return json(slimProduct(result as Record<string, unknown>));
    }),
  );

  // ---------------------------------------------------------------------------
  // Location tools
  // ---------------------------------------------------------------------------

  server.tool(
    "list_locations",
    "List all locations with optional name filter. Use to resolve location names to IDs.",
    { nameFilter: z.string().optional().describe("Filter by location name") },
    withErrorHandling(async (params, extra) => {
      const caller = getCaller(extra);
      const result = await caller.location.list({
        filters: { nameFilter: params.nameFilter },
        sort: { orderBy: "name", direction: "asc" },
        pagination: { pageIndex: 0, pageSize: 200 },
      });
      return json({
        totalCount: result.meta.totalCount,
        locations: result.items.map((l: Record<string, unknown>) =>
          slimLocation(l),
        ),
      });
    }),
  );

  server.tool(
    "get_location",
    "Get a location by ID, including parent info.",
    { id: z.string().describe("Location ID") },
    withErrorHandling(async (params, extra) => {
      const caller = getCaller(extra);
      const result = await caller.location.getByID({ id: params.id });
      return json(slimLocation(result as Record<string, unknown>));
    }),
  );

  // ---------------------------------------------------------------------------
  // Search tools
  // ---------------------------------------------------------------------------

  server.tool(
    "global_search",
    "Search across all entities (products, locations, inventory, recipes).",
    {
      query: z.string().describe("Search query"),
      limit: z.number().optional().describe("Max results (default 10)"),
    },
    withErrorHandling(async (params, extra) => {
      const caller = getCaller(extra);
      const result = await caller.search.global({
        query: params.query,
        limit: (params.limit as number) ?? 10,
      });
      return json(result);
    }),
  );
}
