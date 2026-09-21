import { describe, expect, it } from "vitest";

import { MCP_RESOURCE } from "~/lib/auth-constants";

import {
  createPkcePair,
  createPurchaseAgentOAuthState,
  issuePurchaseAgentDelegation,
  purchaseAgentAuthorizeURL,
  purchaseAgentConnectionRedirect,
  verifyPurchaseAgentDelegation,
  verifyPurchaseAgentOAuthState,
} from "./agent-auth";

const secret = "test-secret-with-more-than-enough-entropy";

describe("purchase agent auth tokens", () => {
  it("round trips an OAuth state without exposing it to JavaScript cookies", async () => {
    const token = await createPurchaseAgentOAuthState({
      state: "state-1",
      verifier: "v".repeat(48),
      userId: "user-1",
      secret,
    });

    await expect(verifyPurchaseAgentOAuthState(token, secret)).resolves.toEqual(
      {
        typ: "purchase-agent-oauth-state",
        state: "state-1",
        verifier: "v".repeat(48),
        userId: "user-1",
      },
    );
    await expect(
      verifyPurchaseAgentOAuthState(token, `${secret}-wrong`),
    ).resolves.toBeNull();
  });

  it("binds a short-lived delegation to one run and grant", async () => {
    const runId = "15119902-3ed6-4f04-a9cc-8c9860c399b2";
    const token = await issuePurchaseAgentDelegation({
      runId,
      userId: "user-1",
      grantId: "grant-1",
      secret,
    });

    await expect(
      verifyPurchaseAgentDelegation(token, secret),
    ).resolves.toMatchObject({
      sub: "user-1",
      run_id: runId,
      grant_id: "grant-1",
      azp: "cubby-purchase-agent",
    });
  });

  it("generates an S256-compatible verifier and challenge", async () => {
    const pair = await createPkcePair();
    expect(pair.verifier.length).toBeGreaterThanOrEqual(43);
    expect(pair.challenge).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("redirects to the connections activity with a closed status vocabulary", () => {
    const url = new URL(purchaseAgentConnectionRedirect("dispatch_failed"));
    expect(url.pathname).toBe("/activity");
    expect(url.searchParams.get("tab")).toBe("connections");
    expect(url.searchParams.get("purchaseAgent")).toBe("dispatch_failed");
  });

  it("starts authorization with PKCE and the protected MCP resource", () => {
    const url = purchaseAgentAuthorizeURL({
      state: "state-1",
      challenge: "challenge-1",
    });
    expect(url.pathname).toBe("/api/auth/oauth2/authorize");
    expect(url.searchParams.get("state")).toBe("state-1");
    expect(url.searchParams.get("code_challenge")).toBe("challenge-1");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("resource")).toBe(MCP_RESOURCE);
  });
});
