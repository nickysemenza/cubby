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
  }),
  revokeConnectedApp: mutation({
    input: revokeConnectedAppInput,
    output: revokeConnectedAppOut,
  }),
  // Credentials and live operational state.
  countOrphanedClients: query({
    readPolicy: "strong",
    input: z.null(),
    output: orphanedOAuthClientsOut,
  }),
  pruneOrphanedClients: mutation({
    input: z.null(),
    output: pruneOrphanedOAuthClientsOut,
  }),
});
