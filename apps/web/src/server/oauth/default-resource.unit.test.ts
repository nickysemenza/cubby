import { describe, expect, it, vi } from "vitest";

vi.mock("~/lib/auth", () => ({
  MCP_RESOURCE: "https://cubby.example.com/api/mcp",
}));

const { withDefaultResource } = await import("./default-resource");

const TOKEN_URL = "https://cubby.example.com/api/auth/oauth2/token";

function form(body: Record<string, string>, url = TOKEN_URL) {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
}

async function params(request: Request) {
  return new URLSearchParams(await request.text());
}

describe("withDefaultResource", () => {
  // The bug this exists for: claude.ai's connector never sends `resource`, so
  // better-auth minted an opaque access token and every MCP call 401'd.
  it("fills in the resource when a token request omits it", async () => {
    const result = await withDefaultResource(
      form({ grant_type: "authorization_code", code: "abc" }),
    );

    expect((await params(result)).get("resource")).toBe(
      "https://cubby.example.com/api/mcp",
    );
  });

  it("leaves an explicit resource alone", async () => {
    const result = await withDefaultResource(
      form({ grant_type: "refresh_token", resource: "https://other/api" }),
    );

    expect((await params(result)).get("resource")).toBe("https://other/api");
  });

  it("defaults the resource on JSON token requests too", async () => {
    const request = new Request(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ grant_type: "refresh_token" }),
    });

    const result = await withDefaultResource(request);

    expect(await result.json()).toEqual({
      grant_type: "refresh_token",
      resource: "https://cubby.example.com/api/mcp",
    });
  });

  it("passes malformed JSON through for better-auth to reject", async () => {
    const request = new Request(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });

    expect(await (await withDefaultResource(request)).text()).toBe("{not json");
  });

  it.each([
    [
      "a non-token auth path",
      form({}, "https://cubby.example.com/api/auth/sign-in/email"),
    ],
    ["a GET", new Request(TOKEN_URL, { method: "GET" })],
  ])("does not touch %s", async (_, request) => {
    expect(await withDefaultResource(request)).toBe(request);
  });
});
