import { importRunId } from "@cubby/schemas/identifiers";
import { describe, expect, it, vi } from "vitest";

import { Database } from "~/server/db";
import { PURCHASE_AGENT_OAUTH_COOKIE } from "~/server/purchase-import/agent-auth";

import {
  type CallbackDependencies,
  handlePurchaseAgentOAuthCallback,
} from "./oauth.callback";

const database = new Database(() => {
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
  const getQueue = vi.fn<CallbackDependencies["getQueue"]>(() => ({
    send: vi.fn(async () => undefined),
  }));
  const recordDispatch = vi.fn<CallbackDependencies["recordDispatch"]>(
    async () => ({ id: "run-1", status: "running" }),
  );
  const verifyState = vi.fn<CallbackDependencies["verifyState"]>(
    async () => stateClaims,
  );
  return {
    getContext,
    exchangeCode,
    findGrant,
    resumeRuns,
    getQueue,
    recordDispatch,
    verifyState,
  };
}

function expectRedirect(response: Response, status: string) {
  const locationHeader = response.headers.get("location");
  if (!locationHeader) throw new Error("OAuth callback did not redirect");
  const location = new URL(locationHeader);
  expect(response.status).toBe(302);
  expect(location.pathname).toBe("/activity");
  expect(location.searchParams.get("tab")).toBe("connections");
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

  it("uses persisted event ids and records successful queue handoff", async () => {
    const ports = dependencies();
    const send = vi.fn(async () => undefined);
    ports.getQueue.mockReturnValue({ send });
    ports.resumeRuns.mockResolvedValue([
      {
        id: importRunId.parse("15119902-3ed6-4f04-a9cc-8c9860c399b2"),
        publicId: "RUN-4K7M",
        purpose: "account_sync",
        coordinatorModel: "gpt-5.6-terra",
        eventId: "persisted-event",
      },
    ]);

    const response = await handlePurchaseAgentOAuthCallback(
      request("?code=code-1&state=state-1"),
      ports,
    );

    expectRedirect(response, "authorized");
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: "persisted-event", type: "retry" }),
    );
    expect(ports.recordDispatch).toHaveBeenCalledWith(database, {
      runId: "15119902-3ed6-4f04-a9cc-8c9860c399b2",
      eventId: "persisted-event",
    });
  });

  it("marks every missing or rejected queue handoff as recoverable", async () => {
    const runs = [
      {
        id: importRunId.parse("15119902-3ed6-4f04-a9cc-8c9860c399b2"),
        publicId: "RUN-4K7M",
        purpose: "account_sync" as const,
        coordinatorModel: "gpt-5.6-terra",
        eventId: "event-1",
      },
      {
        id: importRunId.parse("25119902-3ed6-4f04-a9cc-8c9860c399b2"),
        publicId: "RUN-4K7N",
        purpose: "account_sync" as const,
        coordinatorModel: "gpt-5.6-terra",
        eventId: "event-2",
      },
    ];
    const [firstRun, secondRun] = runs;
    if (!firstRun || !secondRun) throw new Error("Expected two resumed runs");
    const missing = dependencies();
    missing.resumeRuns.mockResolvedValue(runs);
    missing.getQueue.mockReturnValue(undefined);
    expectRedirect(
      await handlePurchaseAgentOAuthCallback(
        request("?code=code-1&state=state-1"),
        missing,
      ),
      "dispatch_failed",
    );
    expect(missing.recordDispatch).toHaveBeenCalledTimes(2);
    expect(
      missing.recordDispatch.mock.calls.every(([, input]) => input.error),
    ).toBe(true);

    const partial = dependencies();
    partial.resumeRuns.mockResolvedValue(runs);
    partial.getQueue.mockReturnValue({
      send: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error("queue rejected")),
    });
    expectRedirect(
      await handlePurchaseAgentOAuthCallback(
        request("?code=code-1&state=state-1"),
        partial,
      ),
      "dispatch_failed",
    );
    expect(partial.recordDispatch).toHaveBeenCalledWith(database, {
      runId: firstRun.id,
      eventId: firstRun.eventId,
    });
    expect(partial.recordDispatch).toHaveBeenCalledWith(
      database,
      expect.objectContaining({
        runId: secondRun.id,
        eventId: secondRun.eventId,
        error: "queue rejected",
      }),
    );
  });
});
