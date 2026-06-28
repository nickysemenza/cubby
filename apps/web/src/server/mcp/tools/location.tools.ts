import {
  locationFilterFields,
  locationMcpListOut,
  locationMcpOut,
  mcpLocationCreateInput,
  mcpLocationUpdateInput,
} from "@cubby/schemas/location";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  READ_ONLY_CLOSED,
  registerEntityCreateTool,
  registerEntityDeleteTool,
  registerEntityGetTool,
  registerEntityListTool,
  registerEntityUpdateTool,
  slimLocation,
  WRITE_CLOSED,
  WRITE_DESTRUCTIVE_CLOSED,
  withIdInput,
} from "./_shared";

export function registerLocationTools(server: McpServer) {
  registerEntityListTool(server, {
    name: "list_locations",
    description:
      "List all locations with optional name filter. Use to resolve location names to IDs.",
    router: "location",
    filterFields: locationFilterFields,
    outputSchema: locationMcpListOut,
    slim: slimLocation,
    sort: { orderBy: "name", direction: "asc" },
    defaultPageSize: 200,
    maxPageSize: 200,
    annotations: READ_ONLY_CLOSED,
  });

  registerEntityGetTool(server, {
    name: "get_location",
    description: "Get a location by ID, including parent info.",
    router: "location",
    idLabel: "Location",
    outputSchema: locationMcpOut,
    slim: slimLocation,
    annotations: READ_ONLY_CLOSED,
  });

  registerEntityCreateTool(server, {
    name: "create_location",
    description:
      "Create a new location. Use list_locations to find a parent location ID.",
    inputSchema: mcpLocationCreateInput.shape,
    outputSchema: locationMcpOut,
    slim: slimLocation,
    annotations: WRITE_CLOSED,
    create: (caller, params) =>
      caller.location.create({
        name: params.name,
        type: params.type,
        parentId: params.parentId,
      }),
  });

  registerEntityUpdateTool(server, {
    name: "update_location",
    description: "Update a location's name, type, or parent.",
    inputSchema: withIdInput("Location", mcpLocationUpdateInput.shape),
    outputSchema: locationMcpOut,
    slim: slimLocation,
    router: "location",
    annotations: WRITE_CLOSED,
  });

  registerEntityDeleteTool(server, {
    name: "delete_locations",
    description:
      "Soft-delete locations by IDs. Fails if locations have inventory entries.",
    router: "location",
    entityLabel: "location",
    annotations: WRITE_DESTRUCTIVE_CLOSED,
  });
}
