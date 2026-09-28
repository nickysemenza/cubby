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
    readPolicy: "strong",
    input: z.null(),
    output: connectedAppsOut,
    cache: { tags: [["oauth", "connectedApps"]] },
  }),
  revokeConnectedApp: mutation({
    input: revokeConnectedAppInput,
    output: revokeConnectedAppOut,
    invalidates: ["connectedApps"],
  }),
  // Credentials and live operational state.
  countOrphanedClients: query({
    readPolicy: "strong",
    input: z.null(),
    output: orphanedOAuthClientsOut,
    cache: { tags: [["oauth", "orphaned"]] },
  }),
  pruneOrphanedClients: mutation({
    input: z.null(),
    output: pruneOrphanedOAuthClientsOut,
    invalidates: ["orphanedOAuth"],
  }),
});
