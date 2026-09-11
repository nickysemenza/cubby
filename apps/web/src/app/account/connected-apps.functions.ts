import { oauthContract } from "~/contracts/connected-apps.contract";
import { ripple } from "~/integrations/tanstack-query/cache-tags";
import { defineOperationDomain } from "~/integrations/tanstack-query/operation-catalog";

export const oauth = defineOperationDomain(oauthContract, {
  listConnectedApps: { tags: [["oauth", "connectedApps"]] },
  revokeConnectedApp: { invalidates: ripple.connectedApps },
  countOrphanedClients: { tags: [["oauth", "orphaned"]] },
  pruneOrphanedClients: { invalidates: ripple.orphanedOAuth },
});
