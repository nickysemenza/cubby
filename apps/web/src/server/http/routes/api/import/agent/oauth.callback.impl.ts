import { z } from "zod";

import { getAuth } from "~/lib/auth";
import { APP_ORIGIN, MCP_RESOURCE } from "~/lib/auth-constants";
import type { Database } from "~/server/db";
import {
  clearPurchaseAgentOAuthCookie,
  findActivePurchaseAgentGrant,
  PURCHASE_AGENT_OAUTH_CALLBACK,
  PURCHASE_AGENT_OAUTH_CLIENT_ID,
  PURCHASE_AGENT_OAUTH_COOKIE,
  purchaseAgentConnectionRedirect,
  type PurchaseAgentConnectionStatus,
  readCookie,
  verifyPurchaseAgentOAuthState,
} from "~/server/domains/purchase-import/repo/agent-auth";
import type { resumeAuthorizedRuns } from "~/server/domains/purchase-import/repo/run-service";
import { getAuthSecret } from "~/server/http/auth-configuration";
import {
  createRequestContext,
  requireActor,
} from "~/server/http/request-context";

const tokenResponse = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
});

type TokenResponse = z.infer<typeof tokenResponse>;
type PurchaseAgentGrant = {
  id: string;
  expiresAt: Date | null;
  sessionId: string | null;
};

type ResumedRun = Awaited<ReturnType<typeof resumeAuthorizedRuns>>[number];

export type CallbackDependencies = {
  getContext(request: Request): Promise<{ db: Database; userId: string }>;
  exchangeCode(
    request: Request,
    code: string,
    verifier: string,
  ): Promise<TokenResponse>;
  findGrant(db: Database, userId: string): Promise<PurchaseAgentGrant | null>;
  resumeRuns(db: Database, userId: string): Promise<ResumedRun[]>;
  verifyState(token: string): Promise<{
    state: string;
    verifier: string;
    userId: string;
  } | null>;
};

const callbackDependencies: CallbackDependencies = {
  async getContext(request) {
    const context = requireActor(
      await createRequestContext({ headers: request.headers }),
    );
    return { db: context.db, userId: context.auth.userId };
  },
  async exchangeCode(request, code, verifier) {
    return tokenResponse.parse(
      await getAuth().api.oauth2Token({
        headers: request.headers,
        body: {
          grant_type: "authorization_code",
          client_id: PURCHASE_AGENT_OAUTH_CLIENT_ID,
          code,
          code_verifier: verifier,
          redirect_uri: PURCHASE_AGENT_OAUTH_CALLBACK,
          resource: MCP_RESOURCE,
        },
      }),
    );
  },
  findGrant: findActivePurchaseAgentGrant,
  // Loaded on request: run-service reaches the AI SDK stack.
  resumeRuns: async (db, userId) =>
    (
      await import("~/server/domains/purchase-import/repo/run-service")
    ).resumeAuthorizedRuns(db, userId),
  verifyState(token) {
    return verifyPurchaseAgentOAuthState(token, getAuthSecret());
  },
};

function callbackResponse(status: PurchaseAgentConnectionStatus) {
  return new Response(null, {
    status: 302,
    headers: {
      Location: purchaseAgentConnectionRedirect(status),
      "Set-Cookie": clearPurchaseAgentOAuthCookie(
        APP_ORIGIN.startsWith("https:"),
      ),
    },
  });
}

export async function handlePurchaseAgentOAuthCallback(
  request: Request,
  overrides: Partial<CallbackDependencies> = {},
) {
  const dependencies = { ...callbackDependencies, ...overrides };
  const url = new URL(request.url);
  let authorized = false;

  try {
    const context = await dependencies.getContext(request);
    const state = url.searchParams.get("state");
    const stateToken = readCookie(request, PURCHASE_AGENT_OAUTH_COOKIE);
    const stateClaims = stateToken
      ? await dependencies.verifyState(stateToken)
      : null;
    if (
      !state ||
      !stateClaims ||
      stateClaims.state !== state ||
      stateClaims.userId !== context.userId
    ) {
      return callbackResponse("failed");
    }
    if (url.searchParams.has("error")) return callbackResponse("denied");
    const code = url.searchParams.get("code");
    if (!code) return callbackResponse("failed");

    await dependencies.exchangeCode(request, code, stateClaims.verifier);
    const grant = await dependencies.findGrant(context.db, context.userId);
    if (!grant) return callbackResponse("failed");
    authorized = true;

    const resumedRuns = await dependencies.resumeRuns(
      context.db,
      context.userId,
    );
    // resumeRuns committed dispatch intent with each resumed generation.
    const dispatchFailed = resumedRuns.some((run) => !run.eventId);
    return callbackResponse(dispatchFailed ? "dispatch_failed" : "authorized");
  } catch {
    return callbackResponse(authorized ? "dispatch_failed" : "failed");
  }
}
