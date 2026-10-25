import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  BROWSER_AUTH,
  createAuthenticator,
  delegatedRunHolds,
  isChallenge,
  MCP_AUTH,
  type Principal,
} from "./authenticate";

/**
 * The cases only the Auth step decides; the HTTP API tests cover API keys,
 * bearer sessions and cookie writes through the same authenticator.
 */

const RUN_ID = "00000000-0000-4000-8000-000000000001";

const ports = {
  getSession: vi.fn(),
  verifyApiKey: vi.fn(),
  verifyMcpToken: vi.fn(),
  context: vi.fn(),
  delegationHolds: vi.fn(),
};
const authenticate = createAuthenticator(ports);

const request = (init: RequestInit = {}) =>
  new Request("https://cubby.example/api/operations/entity.mutate", init);

const principal = (result: Awaited<ReturnType<typeof authenticate>>) => {
  if (isChallenge(result)) throw new Error(`Challenged: ${result.message}`);
  return result;
};

beforeEach(() => {
  vi.resetAllMocks();
  ports.getSession.mockResolvedValue({
    response: {
      user: { id: "user-fixture" },
      session: { id: "session-fixture", token: "token" },
    },
    headers: new Headers(),
  });
  ports.context.mockImplementation(async ({ actor }) => ({
    actorContext: actor,
    auth: { userId: actor.userId, sessionId: actor.sessionId },
  }));
  ports.delegationHolds.mockResolvedValue(true);
});

describe("the same-origin rule", () => {
  type RequestTraits = {
    method: string;
    origin?: string;
    site?: string;
    upgrade?: string;
  };

  it.each<[string, RequestTraits]>([
    [
      "a same-origin write",
      { method: "POST", origin: "https://cubby.example" },
    ],
    [
      "a same-site fetch without Origin",
      { method: "POST", site: "same-origin" },
    ],
    ["a cross-site read", { method: "GET", origin: "https://foreign.example" }],
  ])("admits %s with a cookie", async (_name, { method, origin, site }) => {
    const headers = new Headers({ cookie: "session=fixture" });
    if (origin) headers.set("origin", origin);
    if (site) headers.set("sec-fetch-site", site);
    expect(
      isChallenge(
        await authenticate(request({ method, headers }), BROWSER_AUTH),
      ),
    ).toBe(false);
  });

  it.each<[string, RequestTraits]>([
    [
      "a cross-site write",
      { method: "POST", origin: "https://foreign.example" },
    ],
    ["a write without Origin", { method: "POST" }],
    [
      "a cross-site WebSocket upgrade",
      {
        method: "GET",
        origin: "https://foreign.example",
        upgrade: "websocket",
      },
    ],
  ])(
    "refuses %s with a cookie before verifying it",
    async (_name, { method, origin, upgrade }) => {
      const headers = new Headers({ cookie: "session=fixture" });
      if (origin) headers.set("origin", origin);
      if (upgrade) headers.set("upgrade", upgrade);
      expect(
        await authenticate(request({ method, headers }), BROWSER_AUTH),
      ).toMatchObject({ status: 403, code: "FORBIDDEN" });
      expect(ports.getSession).not.toHaveBeenCalled();
    },
  );

  it("answers a write with no credential at all as unauthenticated", async () => {
    ports.getSession.mockResolvedValue({
      response: null,
      headers: new Headers(),
    });
    expect(
      await authenticate(request({ method: "POST" }), BROWSER_AUTH),
    ).toMatchObject({ status: 401, code: "UNAUTHORIZED" });
  });

  it("exempts a bearer credential, which a foreign page cannot send ambiently", async () => {
    const result = await authenticate(
      request({
        method: "POST",
        headers: { authorization: "Bearer token.signature" },
      }),
      BROWSER_AUTH,
    );
    expect(principal(result)).toMatchObject({
      channel: "browser",
      credential: "bearer",
    });
  });
});

describe("credential policy", () => {
  it("refuses a credential the endpoint does not accept without verifying it", async () => {
    expect(
      await authenticate(
        request({ method: "POST", headers: { "x-api-key": "key" } }),
        BROWSER_AUTH,
      ),
    ).toMatchObject({ status: 401, code: "UNAUTHORIZED" });
    expect(ports.verifyApiKey).not.toHaveBeenCalled();
    expect(ports.getSession).not.toHaveBeenCalled();
  });
});

describe("MCP tokens", () => {
  const mcpRequest = () =>
    request({ method: "POST", headers: { authorization: "Bearer jws" } });

  it("mints an MCP principal with the tool budget and no delegation", async () => {
    ports.verifyMcpToken.mockResolvedValue({
      userId: "user-fixture",
      sessionId: null,
      clientId: "client-fixture",
    });
    const minted: Principal = principal(
      await authenticate(mcpRequest(), MCP_AUTH),
    );
    expect(minted).toMatchObject({
      channel: "mcp",
      credential: "mcp-token",
      delegation: null,
      budget: { ms: { read: 18_000, write: 230_000 } },
    });
    expect(minted.context.actorContext).toMatchObject({
      channel: "mcp",
      oauthClientId: "client-fixture",
      runId: null,
    });
  });

  it("carries a delegation only while its grant and Run hold", async () => {
    ports.verifyMcpToken.mockResolvedValue({
      userId: "user-fixture",
      sessionId: null,
      clientId: "agent-fixture",
      purchaseAgentRunId: RUN_ID,
      purchaseAgentGrantId: "grant-fixture",
      purchaseAgentGeneration: "generation-1",
    });
    expect(principal(await authenticate(mcpRequest(), MCP_AUTH))).toMatchObject(
      {
        delegation: {
          runId: RUN_ID,
          grantId: "grant-fixture",
          generation: "generation-1",
        },
        context: { actorContext: { runId: RUN_ID } },
      },
    );

    ports.delegationHolds.mockResolvedValue(false);
    expect(await authenticate(mcpRequest(), MCP_AUTH)).toMatchObject({
      status: 401,
    });
  });

  it("refuses a run-scoped token without its grant", async () => {
    ports.verifyMcpToken.mockResolvedValue({
      userId: "user-fixture",
      sessionId: null,
      clientId: "agent-fixture",
      purchaseAgentRunId: RUN_ID,
    });
    expect(await authenticate(mcpRequest(), MCP_AUTH)).toMatchObject({
      status: 401,
    });
    expect(ports.context).not.toHaveBeenCalled();
  });

  it("refuses a session cookie on the MCP endpoint", async () => {
    expect(
      await authenticate(
        request({
          method: "POST",
          headers: { origin: "https://cubby.example" },
        }),
        MCP_AUTH,
      ),
    ).toMatchObject({ status: 401 });
    expect(ports.getSession).not.toHaveBeenCalled();
  });
});

// Regression (RUN-DFBE2): a photo Run owned by the other member's party
// 401'd its own coordinator's MCP calls.
describe("a delegated Run", () => {
  const member = { id: "party-member-a" };
  const run = (
    purpose: string,
    ledgerPartyId = "party-member-b",
    actorUserId = "user-a",
  ) => ({ actorUserId, ledgerPartyId, public: { purpose } });
  it("holds a photo Run the actor started, whichever member owns it", () => {
    expect(delegatedRunHolds(run("photo_inventory"), "user-a", member)).toBe(
      true,
    );
  });
  it("holds other Runs only for the owning member's party", () => {
    expect(delegatedRunHolds(run("mail_import"), "user-a", member)).toBe(false);
    expect(
      delegatedRunHolds(run("mail_import", member.id), "user-a", member),
    ).toBe(true);
  });
  it("refuses another actor's Run and an actor without a member party", () => {
    expect(
      delegatedRunHolds(
        run("photo_inventory", member.id, "user-b"),
        "user-a",
        member,
      ),
    ).toBe(false);
    expect(delegatedRunHolds(run("photo_inventory"), "user-a", null)).toBe(
      false,
    );
  });
});
