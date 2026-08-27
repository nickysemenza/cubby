import { oauth } from "~/app/account/connected-apps.functions";
import { implementOperationDomain } from "~/server/operation-domain.server";
import {
  countOrphanedOAuthClientsWorkflow,
  listConnectedAppsWorkflow,
  pruneOrphanedOAuthClientsWorkflow,
  revokeConnectedAppWorkflow,
} from "~/server/workflows/oauth.server";

export const oauthHandlers = implementOperationDomain(oauth, {
  listConnectedApps: (context) =>
    listConnectedAppsWorkflow(context.db, context.actorContext.userId),
  revokeConnectedApp: (context, input) =>
    revokeConnectedAppWorkflow(context.db, context.actorContext.userId, input),
  countOrphanedClients: (context) =>
    countOrphanedOAuthClientsWorkflow(context.db),
  pruneOrphanedClients: (context) =>
    pruneOrphanedOAuthClientsWorkflow(context.db),
});
