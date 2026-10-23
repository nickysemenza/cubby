import {
  connectedAppsOut,
  orphanedOAuthClientsOut,
  pruneOrphanedOAuthClientsOut,
  revokeConnectedAppInput,
  revokeConnectedAppOut,
} from "@cubby/schemas/oauth";
import { z } from "zod";

import { defineContract, mutation, query } from "~/contracts/define";

export const oauthContract = defineContract(
  "oauth",
  {
    listConnectedApps: query({
      exposure: "internal",
      readPolicy: "strong",
      input: z.null(),
      output: connectedAppsOut,
      cache: { tags: [["oauth", "connectedApps"]] },
    }),
    revokeConnectedApp: mutation({
      exposure: "internal",
      input: revokeConnectedAppInput,
      output: revokeConnectedAppOut,
      invalidates: ["connectedApps"],
    }),
    // Credentials and live operational state.
    countOrphanedClients: query({
      description:
        "Count OAuth client records that no longer have a connected app. This is a read-only preview of what prune_orphaned_clients would remove.",
      readPolicy: "strong",
      input: z.null(),
      output: orphanedOAuthClientsOut,
      cache: { tags: [["oauth", "orphaned"]] },
    }),
    pruneOrphanedClients: mutation({
      description:
        "Delete orphaned OAuth client records after reviewing count_orphaned_clients. It does not remove a connected app or revoke a live grant.",
      destructive: true,
      input: z.null(),
      output: pruneOrphanedOAuthClientsOut,
      invalidates: ["orphanedOAuth"],
    }),
  },
  { exposure: "capability", mcpToolGroup: "maintenance" },
);
