import { env } from "~/env";
import { APP_ORIGIN } from "~/lib/auth-constants";
import type { HttpRouteHandlers } from "~/lib/http-route-handler";
import {
  createPkcePair,
  createPurchaseAgentOAuthState,
  ensurePurchaseAgentOAuthClient,
  purchaseAgentAuthorizeURL,
  purchaseAgentOAuthCookie,
  purchaseAgentConnectionRedirect,
} from "~/server/domains/purchase-import/repo/agent-auth";
import {
  createRequestContext,
  requireActor,
} from "~/server/http/request-context";

export const handlers: HttpRouteHandlers<Record<never, never>, "GET"> = {
  GET: async ({ request }) => {
    try {
      const context = requireActor(
        await createRequestContext({ headers: request.headers }),
      );
      await ensurePurchaseAgentOAuthClient(context.db);

      const state = crypto.randomUUID();
      const { verifier, challenge } = await createPkcePair();
      const stateToken = await createPurchaseAgentOAuthState({
        state,
        verifier,
        userId: context.auth.userId,
        secret: env.BETTER_AUTH_SECRET,
      });
      const authorizeUrl = purchaseAgentAuthorizeURL({ state, challenge });

      return new Response(null, {
        status: 302,
        headers: {
          Location: authorizeUrl.toString(),
          "Set-Cookie": purchaseAgentOAuthCookie(
            stateToken,
            APP_ORIGIN.startsWith("https:"),
          ),
        },
      });
    } catch {
      return Response.redirect(purchaseAgentConnectionRedirect("failed"), 302);
    }
  },
};
