import { describe, expect, it } from "vitest";

import {
  createPkcePair,
  createPurchaseAgentOAuthState,
  issuePurchaseAgentDelegation,
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
});
