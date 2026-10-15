import { oauthContract } from "~/contracts/connected-apps.contract";
import {
  countOrphanedOAuthClients,
  listConnectedApps,
  pruneOrphanedOAuthClients,
  revokeConnectedApp,
} from "~/server/http/oauth/oauth-consent";
import { implementOperationDomain } from "~/server/operation-runtime/operation-domain.server";

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
