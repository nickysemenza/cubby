import { describe, expect, it, vi } from "vitest";

import { createDatabase } from "~/server/db/database-runtime";
import { PURCHASE_AGENT_OAUTH_COOKIE } from "~/server/domains/purchase-import/repo/agent-auth";

import {
  type CallbackDependencies,
  handlePurchaseAgentOAuthCallback,
} from "./oauth.callback.impl";

const database = createDatabase(() => {
  throw new Error("OAuth callback unit tests do not query the database");
});
const stateClaims = {
  state: "state-1",
  verifier: "v".repeat(48),
  userId: "user-1",
};

function request(query: string) {
  return new Request(
    `https://cubby.example/api/import/agent/oauth/callback${query}`,
    {
      headers: { cookie: `${PURCHASE_AGENT_OAUTH_COOKIE}=state-token` },
    },
  );
}

function dependencies() {
  const getContext = vi.fn<CallbackDependencies["getContext"]>(async () => ({
    db: database,
    userId: "user-1",
  }));
  const exchangeCode = vi.fn<CallbackDependencies["exchangeCode"]>(
    async () => ({
      access_token: "access-token",
      refresh_token: "refresh-token",
    }),
  );
  const findGrant = vi.fn<CallbackDependencies["findGrant"]>(async () => ({
    id: "grant-1",
    expiresAt: null,
    sessionId: "session-1",
  }));
  const resumeRuns = vi.fn<CallbackDependencies["resumeRuns"]>(async () => []);
  const verifyState = vi.fn<CallbackDependencies["verifyState"]>(
    async () => stateClaims,
  );
  return {
    getContext,
    exchangeCode,
    findGrant,
    resumeRuns,
    verifyState,
  };
}

function expectRedirect(response: Response, status: string) {
  const locationHeader = response.headers.get("location");
  if (!locationHeader) throw new Error("OAuth callback did not redirect");
  const location = new URL(locationHeader);
  expect(response.status).toBe(302);
  expect(location.pathname).toBe("/settings");
  expect(location.searchParams.get("purchaseAgent")).toBe(status);
  expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
}

describe("purchase agent OAuth callback", () => {
  it("clears state and reports an explicit provider denial", async () => {
    const ports = dependencies();
    const response = await handlePurchaseAgentOAuthCallback(
      request("?error=access_denied&state=state-1"),
      ports,
    );

    expectRedirect(response, "denied");
    expect(ports.getContext).toHaveBeenCalledOnce();
  });

  it("clears state when callback validation or token exchange fails", async () => {
    const invalidState = dependencies();
    invalidState.verifyState.mockResolvedValue(null);
    expectRedirect(
      await handlePurchaseAgentOAuthCallback(
        request("?code=code-1&state=state-1"),
        invalidState,
      ),
      "failed",
    );
    expect(invalidState.exchangeCode).not.toHaveBeenCalled();

    const failedExchange = dependencies();
    failedExchange.exchangeCode.mockRejectedValue(new Error("invalid_grant"));
    expectRedirect(
      await handlePurchaseAgentOAuthCallback(
        request("?code=code-1&state=state-1"),
        failedExchange,
      ),
      "failed",
    );
  });

  it("does not resume runs when token exchange creates no durable grant", async () => {
    const ports = dependencies();
    ports.findGrant.mockResolvedValue(null);

    const response = await handlePurchaseAgentOAuthCallback(
      request("?code=code-1&state=state-1"),
      ports,
    );

    expectRedirect(response, "failed");
    expect(ports.resumeRuns).not.toHaveBeenCalled();
  });

  it("reports a recoverable failure when transactional resume cannot persist intent", async () => {
    const ports = dependencies();
    ports.resumeRuns.mockRejectedValue(
      new Error("Synthetic admission failure"),
    );
    expectRedirect(
      await handlePurchaseAgentOAuthCallback(
        request("?code=code-1&state=state-1"),
        ports,
      ),
      "dispatch_failed",
    );
    expect(ports.resumeRuns).toHaveBeenCalledOnce();
  });
});
