import { beforeEach, describe, expect, it, vi } from "vitest";

// ~/lib/auth pulls in the DB client and env validation; the two constants below
// are all this module actually consumes from it.
vi.mock("~/lib/auth", () => ({
  MCP_RESOURCE: "http://localhost:3000/api/mcp",
  OAUTH_ISSUER: "http://localhost:3000/api/auth",
}));

const verifyAccessToken = vi.fn();
vi.mock("better-auth/oauth2", () => ({
  verifyAccessToken: (...args: unknown[]) => verifyAccessToken(...args),
}));

const { unauthorizedResponse, verifyMcpToken } = await import("./auth");

function request(headers: Record<string, string> = {}) {
  return new Request("http://localhost:3000/api/mcp", {
    method: "POST",
    headers,
  });
}

describe("verifyMcpToken", () => {
  beforeEach(() => {
    verifyAccessToken.mockReset();
  });

  it("verifies against this resource server's issuer and audience", async () => {
    verifyAccessToken.mockResolvedValue({ sub: "user_1", sid: "sess_1" });

    const actor = await verifyMcpToken(
      request({ authorization: "Bearer token.abc.def" }),
    );

    expect(actor).toEqual({ userId: "user_1", sessionId: "sess_1" });
    expect(verifyAccessToken).toHaveBeenCalledWith("token.abc.def", {
      jwksUrl: "http://localhost:3000/api/auth/jwks",
      verifyOptions: {
        issuer: "http://localhost:3000/api/auth",
        audience: "http://localhost:3000/api/mcp",
      },
    });
  });

  it("tolerates a token with no session claim", async () => {
    verifyAccessToken.mockResolvedValue({ sub: "user_1" });

    await expect(
      verifyMcpToken(request({ authorization: "Bearer t" })),
    ).resolves.toEqual({ userId: "user_1", sessionId: null });
  });

  it.each([
    ["no authorization header", {}],
    ["a non-bearer scheme", { authorization: "Basic abc" }],
    ["an empty bearer value", { authorization: "Bearer " }],
  ])("returns null for %s without calling the verifier", async (_, headers) => {
    await expect(verifyMcpToken(request(headers))).resolves.toBeNull();
    expect(verifyAccessToken).not.toHaveBeenCalled();
  });

  it("returns null when verification rejects (bad signature, wrong issuer/audience, expired)", async () => {
    verifyAccessToken.mockRejectedValue(new Error("JWTClaimValidationFailed"));

    await expect(
      verifyMcpToken(request({ authorization: "Bearer t" })),
    ).resolves.toBeNull();
  });

  it("returns null when the token carries no subject", async () => {
    verifyAccessToken.mockResolvedValue({ sid: "sess_1" });

    await expect(
      verifyMcpToken(request({ authorization: "Bearer t" })),
    ).resolves.toBeNull();
  });
});

describe("unauthorizedResponse", () => {
  // This header is the entry point to the whole OAuth flow: without it a client
  // reports a failed connection instead of offering to sign in.
  it("points clients at the RFC 9728 metadata for this resource", () => {
    const response = unauthorizedResponse();

    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toBe(
      'Bearer resource_metadata="http://localhost:3000/.well-known/oauth-protected-resource/api/mcp"',
    );
  });
});
