import { oauthContract } from "~/contracts/connected-apps.contract";
import { implementOperationDomain } from "~/server/operation-domain.server";
import {
  countOrphanedOAuthClientsWorkflow,
  listConnectedAppsWorkflow,
  pruneOrphanedOAuthClientsWorkflow,
  revokeConnectedAppWorkflow,
} from "~/server/workflows/oauth.server";

export const oauthHandlers = implementOperationDomain(oauthContract, {
  listConnectedApps: (context) =>
    listConnectedAppsWorkflow(context.db, context.actorContext.userId),
  revokeConnectedApp: (context, input) =>
    revokeConnectedAppWorkflow(context.db, context.actorContext.userId, input),
  countOrphanedClients: (context) =>
    countOrphanedOAuthClientsWorkflow(context.db),
  pruneOrphanedClients: (context) =>
    pruneOrphanedOAuthClientsWorkflow(context.db),
});
