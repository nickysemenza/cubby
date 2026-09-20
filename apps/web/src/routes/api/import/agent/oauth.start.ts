import { createFileRoute } from "@tanstack/react-router";

import { env } from "~/env";
import { APP_ORIGIN } from "~/lib/auth";
import {
  createPkcePair,
  createPurchaseAgentOAuthState,
  ensurePurchaseAgentOAuthClient,
  PURCHASE_AGENT_OAUTH_CALLBACK,
  PURCHASE_AGENT_OAUTH_CLIENT_ID,
  purchaseAgentOAuthCookie,
} from "~/server/purchase-import/agent-auth";
import { createRequestContext, requireActor } from "~/server/request-context";

export const Route = createFileRoute("/api/import/agent/oauth/start")({
  server: {
    handlers: {
      GET: async ({ request }) => {
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
        const authorizeUrl = new URL("/api/auth/oauth2/authorize", APP_ORIGIN);
        authorizeUrl.searchParams.set("response_type", "code");
        authorizeUrl.searchParams.set(
          "client_id",
          PURCHASE_AGENT_OAUTH_CLIENT_ID,
        );
        authorizeUrl.searchParams.set(
          "redirect_uri",
          PURCHASE_AGENT_OAUTH_CALLBACK,
        );
        authorizeUrl.searchParams.set(
          "scope",
          "openid profile email offline_access",
        );
        authorizeUrl.searchParams.set("state", state);
        authorizeUrl.searchParams.set("code_challenge", challenge);
        authorizeUrl.searchParams.set("code_challenge_method", "S256");

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
      },
    },
  },
});
