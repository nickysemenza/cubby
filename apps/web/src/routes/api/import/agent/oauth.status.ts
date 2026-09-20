import { createFileRoute } from "@tanstack/react-router";
import { and, eq, isNull } from "drizzle-orm";

import { oauthRefreshToken } from "~/server/db/schema";
import {
  findActivePurchaseAgentGrant,
  PURCHASE_AGENT_OAUTH_CLIENT_ID,
} from "~/server/purchase-import/agent-auth";
import { pauseAuthorizedImportRuns } from "~/server/purchase-import/run-service";
import { getDb } from "~/server/repo/database-helpers";
import { createRequestContext, requireActor } from "~/server/request-context";

export const Route = createFileRoute("/api/import/agent/oauth/status")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const context = requireActor(
          await createRequestContext({ headers: request.headers }),
        );
        const grant = await findActivePurchaseAgentGrant(
          context.db,
          context.auth.userId,
        );
        return Response.json({
          authorized: grant !== null,
          expiresAt: grant?.expiresAt?.toISOString() ?? null,
        });
      },
      DELETE: async ({ request }) => {
        const context = requireActor(
          await createRequestContext({ headers: request.headers }),
        );
        await getDb(context.db)
          .update(oauthRefreshToken)
          .set({ revoked: new Date() })
          .where(
            and(
              eq(oauthRefreshToken.clientId, PURCHASE_AGENT_OAUTH_CLIENT_ID),
              eq(oauthRefreshToken.userId, context.auth.userId),
              isNull(oauthRefreshToken.revoked),
            ),
          );
        await pauseAuthorizedImportRuns(context.db, context.auth.userId);
        return Response.json({ authorized: false });
      },
    },
  },
});
