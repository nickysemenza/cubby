import type { PurchaseAgentEvent } from "@cubby/schemas/purchase-import";
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import { env } from "~/env";
import { auth } from "~/lib/auth";
import { APP_ORIGIN, MCP_RESOURCE } from "~/lib/auth-constants";
import { getPurchaseAgentQueue } from "~/server/cf-env";
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
} from "~/server/purchase-import/agent-auth";
import { recordRunDispatchAttempt } from "~/server/purchase-import/dispatch";
import { resumeAuthorizedRuns } from "~/server/purchase-import/run-service";
import { createRequestContext, requireActor } from "~/server/request-context";

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
type DispatchAttempt = {
  id: string;
  status: string;
};

export type ResumedRun = Awaited<
  ReturnType<typeof resumeAuthorizedRuns>
>[number];

export type CallbackDependencies = {
  getContext(request: Request): Promise<{ db: Database; userId: string }>;
  exchangeCode(
    request: Request,
    code: string,
    verifier: string,
  ): Promise<TokenResponse>;
  findGrant(db: Database, userId: string): Promise<PurchaseAgentGrant | null>;
  resumeRuns(db: Database, userId: string): Promise<ResumedRun[]>;
  getQueue(): { send(event: PurchaseAgentEvent): Promise<void> } | undefined;
  recordDispatch(
    db: Database,
    input: { runId: string; eventId: string; error?: string },
  ): Promise<DispatchAttempt>;
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
      await auth.api.oauth2Token({
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
  resumeRuns: resumeAuthorizedRuns,
  getQueue: getPurchaseAgentQueue,
  recordDispatch: recordRunDispatchAttempt,
  verifyState(token) {
    return verifyPurchaseAgentOAuthState(token, env.BETTER_AUTH_SECRET);
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

async function dispatchResumedRuns(
  db: Database,
  runs: ResumedRun[],
  dependencies: CallbackDependencies,
) {
  const queue = dependencies.getQueue();
  let failed = false;
  await Promise.all(
    runs.map(async (run) => {
      try {
        if (!run.eventId)
          throw new Error("Purchase Agent queue event is unavailable");
        if (!queue) throw new Error("Purchase Agent queue is unavailable");
        await queue.send({
          version: 1,
          runId: run.id,
          purpose: z
            .enum(["account_sync", "product_enrichment", "purchase_validation"])
            .parse(run.purpose),
          coordinatorModel: "gpt-6-sol",
          eventId: run.eventId,
          type: "start_or_resume",
        });
      } catch (error) {
        failed = true;
        if (run.eventId) {
          await dependencies.recordDispatch(db, {
            runId: run.id,
            eventId: run.eventId,
            error:
              error instanceof Error
                ? error.message
                : "Purchase Agent dispatch failed",
          });
        }
        return;
      }
      await dependencies.recordDispatch(db, {
        runId: run.id,
        eventId: run.eventId!,
      });
    }),
  );
  return failed;
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
    const dispatchFailed = await dispatchResumedRuns(
      context.db,
      resumedRuns,
      dependencies,
    );
    return callbackResponse(dispatchFailed ? "dispatch_failed" : "authorized");
  } catch {
    return callbackResponse(authorized ? "dispatch_failed" : "failed");
  }
}

export const Route = createFileRoute("/api/import/agent/oauth/callback")({
  server: {
    handlers: {
      GET: ({ request }) => handlePurchaseAgentOAuthCallback(request),
    },
  },
});
