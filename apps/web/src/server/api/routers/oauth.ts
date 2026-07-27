import { z } from "zod";
import { createTRPCRouter, protectedProcedure } from "~/server/api/trpc";
import {
  countOrphanedOAuthClients,
  listConnectedApps,
  pruneOrphanedOAuthClients,
  revokeConnectedApp,
} from "~/server/repo/oauth-consent";

/**
 * OAuth clients connected to this account (the MCP connectors).
 *
 * Not covered by `@daveyplate/better-auth-ui` at the pinned version, and the
 * plugin's own consent endpoints can't express a real revoke, so this is a thin
 * router over the repo.
 */
export const oauthRouter = createTRPCRouter({
  listConnectedApps: protectedProcedure.query(({ ctx }) =>
    listConnectedApps(ctx.db, ctx.actorContext.userId),
  ),

  revokeConnectedApp: protectedProcedure
    .input(z.object({ consentId: z.string() }))
    .mutation(({ ctx, input }) =>
      revokeConnectedApp(ctx.db, ctx.actorContext.userId, input.consentId),
    ),

  /** Registrations left behind by connect attempts that never reached consent. */
  countOrphanedClients: protectedProcedure.query(({ ctx }) =>
    countOrphanedOAuthClients(ctx.db),
  ),

  pruneOrphanedClients: protectedProcedure.mutation(({ ctx }) =>
    pruneOrphanedOAuthClients(ctx.db),
  ),
});
