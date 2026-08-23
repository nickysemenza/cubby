import {
  personCreateInput,
  personFilterFields,
  personListResponse,
  personOut,
  personUpdateData,
} from "@cubby/schemas/person";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { defineSlim, registerEntityCrudToolset } from "./_shared";

const slimPerson = defineSlim(personOut, (row) => personOut.parse(row));

export function registerPersonTools(server: McpServer) {
  registerEntityCrudToolset(server, {
    entity: "person",
    entityPlural: "people",
    createInput: personCreateInput.shape,
    updateShape: personUpdateData.shape,
    filterFields: personFilterFields,
    mcpListOut: personListResponse,
    out: personOut,
    slim: slimPerson,
    sort: { orderBy: "name", direction: "asc" },
    descriptions: {
      list: "List household and guest people, optionally filtering by kind or linked-user status.",
      get: "Get one person by shortcode.",
      create: "Create a person and their private funding source.",
      update: "Update a person's name, kind, or notes.",
      delete:
        "Soft-delete people that have no live account or household-ledger references.",
    },
  });
}
