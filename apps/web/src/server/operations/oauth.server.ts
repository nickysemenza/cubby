import { oauthContract } from "~/contracts/connected-apps.contract";
import { implementOperationDomain } from "~/server/operation-domain.server";
import {
  countOrphanedOAuthClients,
  listConnectedApps,
  pruneOrphanedOAuthClients,
  revokeConnectedApp,
} from "~/server/repo/oauth-consent";

export const oauthHandlers = implementOperationDomain(oauthContract, {
  listConnectedApps: (context) =>
    listConnectedApps(context.db, context.actorContext.userId),
  revokeConnectedApp: (context, input) =>
    revokeConnectedApp(
      context.db,
      context.actorContext.userId,
      input.consentId,
    ),
  countOrphanedClients: (context) => countOrphanedOAuthClients(context.db),
  pruneOrphanedClients: (context) => pruneOrphanedOAuthClients(context.db),
});
