import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createMcpTokenVerifier,
  createUnauthorizedResponse,
  type McpAuthRejectionDetail,
  type VerifyMcpAccessToken,
} from "./auth-verifier";

const RESOURCE = "http://localhost:3000/api/mcp";
const ISSUER = "http://localhost:3000/api/auth";

const getJwks = vi.fn<() => Promise<{ keys: never[] }>>();
const verifyAccessToken = vi.fn<VerifyMcpAccessToken>();
const verificationOptions = {
  jwksFetch: () => getJwks(),
  jwksCacheKey: {},
  verifyOptions: { issuer: ISSUER, audience: RESOURCE },
} satisfies Parameters<VerifyMcpAccessToken>[1];
const reportRejection =
  vi.fn<(message: string, detail: McpAuthRejectionDetail) => void>();
const verifyMcpToken = createMcpTokenVerifier({
  verifyAccessToken,
  verificationOptions,
  reportRejection,
});
const unauthorizedResponse = createUnauthorizedResponse(RESOURCE);

function request(headers: Record<string, string> = {}) {
  return new Request("http://localhost:3000/api/mcp", {
    method: "POST",
    headers,
  });
}

describe("verifyMcpToken", () => {
  beforeEach(() => {
    verifyAccessToken.mockReset();
    getJwks.mockReset();
    reportRejection.mockReset();
  });

  it("verifies against this resource server's issuer and audience", async () => {
    verifyAccessToken.mockResolvedValue({
      sub: "user_1",
      sid: "sess_1",
      azp: "oauth-client-1",
    });

    const actor = await verifyMcpToken(
      request({ authorization: "Bearer token.abc.def" }),
    );

    expect(actor).toEqual({
      userId: "user_1",
      sessionId: "sess_1",
      clientId: "oauth-client-1",
    });
    expect(verifyAccessToken).toHaveBeenCalledWith(
      "token.abc.def",
      expect.objectContaining({
        verifyOptions: {
          issuer: ISSUER,
          audience: RESOURCE,
        },
      }),
    );
  });

  // Regression: `jwksUrl: "<origin>/api/auth/jwks"` made the Worker subrequest
  // its own hostname, which Cloudflare doesn't route back — every production
  // token failed with "Jwks failed: <none>" while local dev passed.
  it("reads the key set in-process rather than over the network", async () => {
    verifyAccessToken.mockResolvedValue({ sub: "user_1" });
    getJwks.mockResolvedValue({ keys: [] });

    await verifyMcpToken(request({ authorization: "Bearer t" }));

    expect(Object.keys(verificationOptions)).not.toContain("jwksUrl");
    expect(verificationOptions.jwksCacheKey).toBeDefined();
    await verificationOptions.jwksFetch();
    expect(getJwks).toHaveBeenCalled();
  });

  it("tolerates a token with no session claim", async () => {
    verifyAccessToken.mockResolvedValue({ sub: "user_1" });

    await expect(
      verifyMcpToken(request({ authorization: "Bearer t" })),
    ).resolves.toEqual({
      userId: "user_1",
      sessionId: null,
      clientId: null,
    });
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
