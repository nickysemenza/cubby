import {
  connectedAppsOut,
  orphanedOAuthClientsOut,
  pruneOrphanedOAuthClientsOut,
  revokeConnectedAppInput,
  revokeConnectedAppOut,
} from "@cubby/schemas/oauth";
import { z } from "zod";

import { defineContract, mutation, query } from "~/contracts/define";

export const oauthContract = defineContract("oauth", {
  listConnectedApps: query({
    mcp: { omit: "auth_connection" },
    readPolicy: "strong",
    input: z.null(),
    output: connectedAppsOut,
    cache: { tags: [["oauth", "connectedApps"]] },
  }),
  revokeConnectedApp: mutation({
    mcp: { omit: "auth_connection" },
    input: revokeConnectedAppInput,
    output: revokeConnectedAppOut,
    invalidates: ["connectedApps"],
  }),
  // Credentials and live operational state.
  countOrphanedClients: query({
    mcp: { omit: "operator_maintenance" },
    readPolicy: "strong",
    input: z.null(),
    output: orphanedOAuthClientsOut,
    cache: { tags: [["oauth", "orphaned"]] },
  }),
  pruneOrphanedClients: mutation({
    mcp: { omit: "operator_maintenance" },
    input: z.null(),
    output: pruneOrphanedOAuthClientsOut,
    invalidates: ["orphanedOAuth"],
  }),
});
