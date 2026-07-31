import {
  locationFilterFields,
  locationMcpListOut,
  locationMcpOut,
  locationUpdateData,
  mcpLocationCreateInput,
} from "@cubby/schemas/location";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerEntityCrudToolset, slimLocation } from "./_shared";

export function registerLocationTools(server: McpServer) {
  registerEntityCrudToolset(server, {
    entity: "location",
    createInput: mcpLocationCreateInput.shape,
    updateShape: locationUpdateData.shape,
    filterFields: locationFilterFields,
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
  });
}
