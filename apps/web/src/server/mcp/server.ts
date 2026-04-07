import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

/**
 * MCP Server for Cubby inventory and product management.
 *
 * The McpServer + tools are created once (module scope). Only the transport
 * is per-request — the SDK requires a fresh transport in stateless mode,
 * but the server itself is stateless and safe to reuse.
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

/** Case-insensitive substring match for nullable string fields */
function matchesFilter(value: string | null, filter: unknown): boolean {
  if (typeof filter !== "string") return true;
  return value?.toLowerCase().includes(filter.toLowerCase()) ?? false;
}

/** Case-insensitive substring match against a string array */
function matchesArrayFilter(values: string[], filter: unknown): boolean {
  if (typeof filter !== "string") return true;
  const lower = filter.toLowerCase();
  return values.some((v) => v.toLowerCase().includes(lower));
}

function notionUnavailable() {
  return {
    content: [
      {
        type: "text" as const,
        text: "Notion integration is not configured. Set the NOTION_API_KEY environment variable.",
      },
    ],
    isError: true,
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
    externalIds: p.externalIds,
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

/**
 * Handle an authenticated MCP request.
 * Per-request server+transport: the SDK's McpServer.connect() can only be
 * called once per instance, and the transport can't be reused in stateless mode.
 */
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

const pageSize = z
  .number()
  .int()
  .min(1)
  .max(100)
  .optional()
  .describe("Items per page (default 50, max 100)");
const pageIndex = z
  .number()
  .int()
  .min(0)
  .optional()
  .describe("Page index, 0-based (default 0)");

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
      pageIndex,
      pageSize,
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
          pageIndex: params.pageIndex ?? 0,
          pageSize: params.pageSize ?? 50,
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
    "Update an inventory entry's amount, product, or location. When updating amount, both value and unit must be provided together.",
    {
      id: z.string().describe("Inventory entry ID"),
      value: z
        .number()
        .optional()
        .describe("New quantity value (requires unit)"),
      unit: z.string().optional().describe("New unit (requires value)"),
      productId: z.string().optional().describe("New product ID"),
      locationId: z.string().optional().describe("New location ID"),
    },
    withErrorHandling(async (params, extra) => {
      const caller = getCaller(extra);
      const data: Record<string, unknown> = {};
      // Require both value and unit together to avoid silent defaults
      if (params.value !== undefined && params.unit !== undefined) {
        data.amount = { value: params.value, unit: params.unit };
      } else if (params.value !== undefined || params.unit !== undefined) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Both value and unit must be provided together when updating amount.",
            },
          ],
          isError: true,
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
      pageIndex,
      pageSize,
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
          pageIndex: params.pageIndex ?? 0,
          pageSize: params.pageSize ?? 50,
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
      externalIds: z
        .array(
          z.object({
            id: z
              .string()
              .optional()
              .describe("Existing external ID record ID (for updates)"),
            source: z
              .string()
              .describe("Source name (e.g. 'amazon', 'mcmaster', 'mouser')"),
            externalId: z
              .string()
              .describe("The identifier (ASIN, part number, etc.)"),
            url: z
              .string()
              .optional()
              .describe("Direct link to the product page"),
          }),
        )
        .optional()
        .describe(
          "External identifiers. Replaces all existing IDs when provided.",
        ),
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
    {
      nameFilter: z.string().optional().describe("Filter by location name"),
      pageIndex,
      pageSize: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .describe("Items per page (default 200, max 200)"),
    },
    withErrorHandling(async (params, extra) => {
      const caller = getCaller(extra);
      const result = await caller.location.list({
        filters: { nameFilter: params.nameFilter },
        sort: { orderBy: "name", direction: "asc" },
        pagination: {
          pageIndex: params.pageIndex ?? 0,
          pageSize: params.pageSize ?? 200,
        },
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

  server.tool(
    "create_location",
    "Create a new location. Use list_locations to find a parent location ID.",
    {
      name: z.string().describe("Location name"),
      type: z
        .string()
        .optional()
        .describe("Location type (e.g. 'room', 'shelf', 'drawer', 'box')"),
      parentId: z
        .string()
        .optional()
        .describe("Parent location ID for nesting"),
    },
    withErrorHandling(async (params, extra) => {
      const caller = getCaller(extra);
      const result = await caller.location.create({
        name: params.name,
        type: params.type,
        parentId: params.parentId,
      });
      return json(slimLocation(result as Record<string, unknown>));
    }),
  );

  server.tool(
    "update_location",
    "Update a location's name, type, or parent.",
    {
      id: z.string().describe("Location ID"),
      name: z.string().optional().describe("New name"),
      type: z.string().optional().describe("New type"),
      parentId: z.string().optional().describe("New parent location ID"),
    },
    withErrorHandling(async (params, extra) => {
      const caller = getCaller(extra);
      const { id, ...data } = params;
      const cleanData = Object.fromEntries(
        Object.entries(data).filter(([, v]) => v !== undefined),
      );
      const result = await caller.location.update({ id, data: cleanData });
      return json(slimLocation(result as Record<string, unknown>));
    }),
  );

  server.tool(
    "delete_locations",
    "Soft-delete locations by IDs. Fails if locations have inventory entries.",
    {
      ids: z.array(z.string()).describe("Array of location IDs to delete"),
    },
    withErrorHandling(async (params, extra) => {
      const caller = getCaller(extra);
      await caller.location.delete({ ids: params.ids });
      return json({ deleted: (params.ids as string[]).length });
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
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe("Max results (default 10, max 50)"),
    },
    withErrorHandling(async (params, extra) => {
      const caller = getCaller(extra);
      const result = await caller.search.global({
        query: params.query,
        limit: params.limit ?? 10,
      });
      return json(result);
    }),
  );

  // ---------------------------------------------------------------------------
  // Notion tools (read-only)
  // ---------------------------------------------------------------------------

  const notionLimit = z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .describe("Max results to return (default 50, max 200)");

  server.tool(
    "list_projects",
    "List Notion projects with optional filters. Returns project name, status, kind, location, cost estimate, dates, and Notion URL.",
    {
      status: z.string().optional().describe("Filter by status (substring)"),
      kind: z.string().optional().describe("Filter by kind (substring)"),
      location: z
        .string()
        .optional()
        .describe("Filter by location (substring match on any location tag)"),
      name: z
        .string()
        .optional()
        .describe("Filter by project name (substring)"),
      limit: notionLimit,
    },
    withErrorHandling(async (params, extra) => {
      const caller = getCaller(extra);
      const dashboard = await caller.notion.dashboard();
      if (!dashboard) return notionUnavailable();

      const filtered = dashboard.projects
        .filter(
          (p: Record<string, unknown>) =>
            matchesFilter(p.status as string | null, params.status) &&
            matchesFilter(p.kind as string | null, params.kind) &&
            matchesArrayFilter(p.location as string[], params.location) &&
            matchesFilter(p.name as string | null, params.name),
        )
        .slice(0, params.limit ?? 50);

      return json({ count: filtered.length, projects: filtered });
    }),
  );

  server.tool(
    "list_tasks",
    "List Notion tasks with optional filters. Returns task name, status, due date, category, project name, and Notion URL.",
    {
      status: z.string().optional().describe("Filter by status (substring)"),
      projectName: z
        .string()
        .optional()
        .describe("Filter by project name (substring)"),
      category: z
        .string()
        .optional()
        .describe("Filter by category (substring)"),
      name: z.string().optional().describe("Filter by task name (substring)"),
      limit: notionLimit,
    },
    withErrorHandling(async (params, extra) => {
      const caller = getCaller(extra);
      const dashboard = await caller.notion.dashboard();
      if (!dashboard) return notionUnavailable();

      const filtered = dashboard.tasks
        .filter(
          (t: Record<string, unknown>) =>
            matchesFilter(t.status as string | null, params.status) &&
            matchesFilter(t.projectName as string | null, params.projectName) &&
            matchesFilter(t.category as string | null, params.category) &&
            matchesFilter(t.name as string | null, params.name),
        )
        .slice(0, params.limit ?? 50);

      return json({ count: filtered.length, tasks: filtered });
    }),
  );

  server.tool(
    "list_purchases",
    "List Notion purchases with optional filters. Returns purchase name, cost, date, category, purchaser, project name, and Notion URL.",
    {
      category: z
        .string()
        .optional()
        .describe("Filter by category (substring)"),
      projectName: z
        .string()
        .optional()
        .describe("Filter by project name (substring)"),
      purchaser: z
        .string()
        .optional()
        .describe("Filter by purchaser (substring)"),
      name: z
        .string()
        .optional()
        .describe("Filter by purchase name (substring)"),
      limit: notionLimit,
    },
    withErrorHandling(async (params, extra) => {
      const caller = getCaller(extra);
      const dashboard = await caller.notion.dashboard();
      if (!dashboard) return notionUnavailable();

      const filtered = dashboard.purchases
        .filter(
          (p: Record<string, unknown>) =>
            matchesFilter(p.category as string | null, params.category) &&
            matchesFilter(p.projectName as string | null, params.projectName) &&
            matchesFilter(p.purchaser as string | null, params.purchaser) &&
            matchesFilter(p.name as string | null, params.name),
        )
        .slice(0, params.limit ?? 50);

      return json({ count: filtered.length, purchases: filtered });
    }),
  );

  server.tool(
    "get_project_content",
    "Fetch the page content of a Notion project by its page ID. Returns structured blocks (paragraphs, headings, lists, images, etc.).",
    {
      pageId: z
        .string()
        .describe("Notion page ID (from list_projects results)"),
    },
    withErrorHandling(async (params, extra) => {
      const caller = getCaller(extra);
      const content = await caller.notion.projectContent({
        pageId: params.pageId,
      });
      if (content === null) return notionUnavailable();
      return json(content);
    }),
  );
}
