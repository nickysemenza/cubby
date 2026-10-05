import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

// A reserved stub method can intercept authorization before the session runs.
// Also exercise native fetch through the session: Node mocks do not enforce
// Workers' receiver binding. Only the external OpenAI response is synthetic.
describe("ChatGPT authorization RPC", () => {
  it("reaches session validation through the real Durable Object stub", async () => {
    const name = crypto.randomUUID();
    const response = await SELF.fetch(`http://${name}/chatgpt/authorize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code: "synthetic-code",
        clientId: "oaiapp_example",
        verifier: "too-short",
        nonce: "synthetic-nonce-value",
        redirectUri: "http://127.0.0.1:12345/auth/callback",
      }),
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("ZodError");
    const plan = env.CHATGPT_PLAN.getByName(name);
    expect(await plan.status()).toMatchObject({ connected: false });
  });

  it("reaches token exchange using native Workers fetch", async () => {
    const name = crypto.randomUUID();
    const response = await SELF.fetch(`http://${name}/chatgpt/authorize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code: "synthetic-code",
        clientId: "oaiapp_example",
        verifier: "v".repeat(43),
        nonce: "synthetic-nonce-value",
        redirectUri: "http://127.0.0.1:12345/auth/callback",
      }),
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain(
      "OpenAI HTTP 400: synthetic token rejection",
    );
    expect(await env.CHATGPT_PLAN.getByName(name).status()).toMatchObject({
      connected: false,
    });
  });
});
