import { afterEach, expect, it, vi } from "vitest";

import agentEvalModel from "./agent-eval-model";

// Failure modes: the agent's SDK placeholder credentials reach the gateway; a
// paid eval is labelled production; the candidate is not swapped in; the
// endpoint or query is dropped on the way upstream.
const env = {
  ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
  AI_GATEWAY_API_KEY: "synthetic-key",
  GATEWAY_ENVIRONMENT: "development" as const,
};
const ctx = { waitUntil: () => undefined };
const upstream = vi.fn<typeof fetch>();
afterEach(() => {
  upstream.mockReset();
  vi.unstubAllGlobals();
});

it("forwards the swapped candidate to the gateway's OpenAI route", async () => {
  vi.stubGlobal("fetch", upstream);
  upstream.mockResolvedValue(new Response("ok"));
  await agentEvalModel.fetch(
    new Request("https://eval-model.test/configure", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-6-luna", effort: "high" }),
    }),
    env,
    ctx,
  );
  await agentEvalModel.fetch(
    new Request("https://ai-gateway.invalid/openai/responses?stream=true", {
      method: "POST",
      headers: {
        authorization: "Bearer sdk-placeholder",
        "x-api-key": "sdk-placeholder",
        "cf-aig-metadata": JSON.stringify({
          environment: "production",
          feature: "purchase_import_agent",
          operation: "agent.turn",
        }),
      },
      body: JSON.stringify({ model: "gpt-6-sol", reasoning: {} }),
    }),
    env,
    ctx,
  );

  const [url, init] = upstream.mock.lastCall ?? [];
  expect(String(url)).toBe(
    `https://gateway.ai.cloudflare.com/v1/${env.ACCOUNT_ID}/cubby/openai/responses?stream=true`,
  );
  const headers = new Headers(init?.headers);
  expect(headers.get("authorization")).toBeNull();
  expect(headers.get("x-api-key")).toBeNull();
  expect(headers.get("cf-aig-authorization")).toBe("Bearer synthetic-key");
  expect(JSON.parse(headers.get("cf-aig-metadata") ?? "{}")).toEqual({
    environment: "development",
    feature: "purchase_import_agent",
    operation: "agent.turn",
  });
  expect(JSON.parse(String(init?.body))).toEqual({
    model: "gpt-6-luna",
    reasoning: { effort: "high" },
  });
});
