import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import { env } from "~/env";
import { APP_ORIGIN, auth, MCP_RESOURCE } from "~/lib/auth";
import { getPurchaseAgentQueue } from "~/server/cf-env";
import {
  clearPurchaseAgentOAuthCookie,
  findActivePurchaseAgentGrant,
  PURCHASE_AGENT_OAUTH_CALLBACK,
  PURCHASE_AGENT_OAUTH_CLIENT_ID,
  PURCHASE_AGENT_OAUTH_COOKIE,
  readCookie,
  verifyPurchaseAgentOAuthState,
} from "~/server/purchase-import/agent-auth";
import { resumeAuthorizedImportRuns } from "~/server/purchase-import/run-service";
import { createRequestContext, requireActor } from "~/server/request-context";

const tokenResponse = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
});

export const Route = createFileRoute("/api/import/agent/oauth/callback")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const context = requireActor(
          await createRequestContext({ headers: request.headers }),
        );
        const url = new URL(request.url);
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        const stateToken = readCookie(request, PURCHASE_AGENT_OAUTH_COOKIE);
        const stateClaims = stateToken
          ? await verifyPurchaseAgentOAuthState(
              stateToken,
              env.BETTER_AUTH_SECRET,
            )
          : null;
        if (
          !code ||
          !state ||
          !stateClaims ||
          stateClaims.state !== state ||
          stateClaims.userId !== context.auth.userId
        ) {
          return Response.json(
            {
              error: "Purchase Agent authorization state is invalid or expired",
            },
            { status: 400 },
          );
        }

        const rawTokenResponse = await auth.api.oauth2Token({
          headers: request.headers,
          body: {
            grant_type: "authorization_code",
            client_id: PURCHASE_AGENT_OAUTH_CLIENT_ID,
            code,
            code_verifier: stateClaims.verifier,
            redirect_uri: PURCHASE_AGENT_OAUTH_CALLBACK,
            resource: MCP_RESOURCE,
          },
        });
        tokenResponse.parse(rawTokenResponse);
        const grant = await findActivePurchaseAgentGrant(
          context.db,
          context.auth.userId,
        );
        if (!grant) {
          return Response.json(
            {
              error:
                "Purchase Agent authorization did not create a durable grant",
            },
            { status: 502 },
          );
        }
        const resumedRuns = await resumeAuthorizedImportRuns(
          context.db,
          context.auth.userId,
        );
        const queue = getPurchaseAgentQueue();
        if (queue) {
          await Promise.all(
            resumedRuns.map((run) =>
              queue.send({
                version: 1,
                runId: run.id,
                publicId: run.publicId,
                eventId: crypto.randomUUID(),
                type: "start_or_resume",
              }),
            ),
          );
        }

        return new Response(null, {
          status: 302,
          headers: {
            Location: new URL(
              "/settings?purchaseAgent=authorized",
              APP_ORIGIN,
            ).toString(),
            "Set-Cookie": clearPurchaseAgentOAuthCookie(
              APP_ORIGIN.startsWith("https:"),
            ),
          },
        });
      },
    },
  },
});
