import {
  locationFilterFields,
  locationMcpListOut,
  locationMcpOut,
  locationUpdateData,
  mcpLocationCreateInput,
} from "@cubby/schemas/location";
import { oneOrMany } from "@cubby/schemas/pagination";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  idParam,
  registerEntityCrudToolset,
  resolveOneOrManyFilter,
  resolveOptionalId,
  slimLocation,
} from "./_shared";

/**
 * `mcpLocationCreateInput`/`locationUpdateData` are branded-uuid `parentId`
 * fields shared with the tRPC router — packages/schemas stays uuid-only, so
 * the shortcode swap happens in these MCP-local overrides instead.
 */
const locationCreateMcpInput = mcpLocationCreateInput.extend({
  parentId: idParam("location")
    .nullable()
    .describe(
      "Parent location shortcode — nest this location under another (omit/null for a top-level location).",
    ),
});

const locationUpdateMcpShape = {
  ...locationUpdateData.shape,
  parentId: idParam("location")
    .nullable()
    .optional()
    .describe(
      "Parent location shortcode — nest this location under another (omit/null for a top-level location).",
    ),
};

const locationFilterMcpFields = {
  ...locationFilterFields,
  parentId: oneOrMany(idParam("location"))
    .optional()
    .describe("Filter by parent location shortcode(s)"),
};

export function registerLocationTools(server: McpServer) {
  registerEntityCrudToolset(server, {
    entity: "location",
    createInput: locationCreateMcpInput.shape,
    updateShape: locationUpdateMcpShape,
    filterFields: locationFilterMcpFields,
    mcpListOut: locationMcpListOut,
    out: locationMcpOut,
    slim: slimLocation,
    sort: { orderBy: "name", direction: "asc" },
    paging: { defaultPageSize: 200, maxPageSize: 200 },
    descriptions: {
      list: 'List all locations with optional name filter. Filter by parent with parentId (one or more location shortcodes) or parentPresenceFilter — "none" is top-level locations with no parent, "has" is every location that has one; matches DIRECT children only (no subtree walk). Use to resolve location names to shortcodes.',
      get: "Get a location by ID, including parent info.",
      create:
        "Create a new location. Use list_locations to find a parent location shortcode.",
      update: "Update a location's name, type, or parent.",
      delete:
        "Soft-delete locations by IDs. Fails if locations have inventory entries.",
    },
    create: async (caller, params) => {
      const parentCode = await resolveOptionalId(
        caller,
        "location",
        params.parentId,
      );
      return caller.location.create({
        name: params.name,
        type: params.type,
        // `resolveOptionalId` passes through whichever nullish it was given;
        // the router's `parentId` is `string | null`.
        parentId: parentCode ?? null,
      });
    },
    resolveUpdateData: async (caller, data) => {
      if (data.parentId === undefined || data.parentId === null) return data;
      return {
        ...data,
        parentId: await resolveOptionalId(
          caller,
          "location",
          data.parentId as string,
        ),
      };
    },
    buildFilters: async (caller, params) => {
      const filters: Record<string, unknown> = {};
      for (const key of [
        "nameFilter",
        "itemTypeFilter",
        "parentPresenceFilter",
        "inventoryPresenceFilter",
      ] as const) {
        if (params[key] !== undefined) filters[key] = params[key];
      }
      if (params.parentId !== undefined) {
        filters.parentId = await resolveOneOrManyFilter(
          caller,
          "location",
          params.parentId as string | string[],
        );
      }
      return filters;
    },
  });
}
