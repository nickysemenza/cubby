import {
  connectedAppsOut,
  orphanedOAuthClientsOut,
  pruneOrphanedOAuthClientsOut,
  revokeConnectedAppInput,
  revokeConnectedAppOut,
} from "@cubby/schemas/oauth";
import { z } from "zod";

import {
  defineOperationDomain,
  mutation,
  query,
} from "~/integrations/tanstack-query/operation-catalog";

export const oauth = defineOperationDomain("oauth", {
  listConnectedApps: query({
    input: z.null(),
    output: connectedAppsOut,
    tags: [["oauth", "connectedApps"]],
  }),
  revokeConnectedApp: mutation({
    input: revokeConnectedAppInput,
    output: revokeConnectedAppOut,
    invalidates: [["oauth", "connectedApps"]],
  }),
  countOrphanedClients: query({
    input: z.null(),
    output: orphanedOAuthClientsOut,
    tags: [["oauth", "orphaned"]],
  }),
  pruneOrphanedClients: mutation({
    input: z.null(),
    output: pruneOrphanedOAuthClientsOut,
    invalidates: [["oauth", "orphaned"]],
  }),
});
