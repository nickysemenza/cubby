import { locationCreateInput } from "@cubby/schemas/location";
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
  type Row,
  respond,
  slimLocation,
  updateHandler,
  withErrorHandling,
} from "./_shared";

export function registerLocationTools(server: McpServer) {
  server.tool(
    "list_locations",
    "List all locations with optional name filter. Use to resolve location names to IDs.",
    {
      nameFilter: z.string().optional().describe("Filter by location name"),
      // Locations intentionally diverge: only nameFilter is exposed (not
      // itemTypeFilter) and the page size is capped higher (200) since the
      // location tree is small and usually wanted whole. Each row carries its
      // parent + children pointers, so the hierarchy is navigable from here.
      pageIndex: mcpPaginationParams.pageIndex,
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
        locations: result.items.map((l: Row) => slimLocation(l)),
      });
    }),
  );

  server.tool(
    "get_location",
    "Get a location by ID, including parent info.",
    { id: idParam("Location") },
    getByIdHandler("location", slimLocation),
  );

  server.tool(
    "create_location",
    "Create a new location. Use list_locations to find a parent location ID.",
    {
      // Field shapes + descriptions from canonical locationCreateInput (name
      // required; type/parentId optional). Images are managed elsewhere.
      name: locationCreateInput.shape.name,
      ...locationCreateInput.pick({ type: true, parentId: true }).partial()
        .shape,
    },
    withErrorHandling(async (params, extra) => {
      const caller = getCaller(extra);
      const result = await caller.location.create({
        name: params.name,
        type: params.type,
        parentId: params.parentId,
      });
      return respond(result, slimLocation);
    }),
  );

  server.tool(
    "update_location",
    "Update a location's name, type, or parent.",
    {
      id: idParam("Location"),
      // Curated subset of canonical locationCreateInput (all optional for update).
      ...locationCreateInput
        .pick({ name: true, type: true, parentId: true })
        .partial().shape,
    },
    updateHandler("location", slimLocation),
  );

  server.tool(
    "delete_locations",
    "Soft-delete locations by IDs. Fails if locations have inventory entries.",
    { ids: idsParam("location") },
    deleteHandler("location"),
  );
}
