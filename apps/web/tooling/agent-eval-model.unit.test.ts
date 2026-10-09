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

it("counts a rejected upstream socket as an unpriced attempted request", async () => {
  vi.stubGlobal("fetch", upstream);
  upstream.mockRejectedValue(new Error("synthetic socket failure"));
  await agentEvalModel.fetch(
    new Request("https://eval-model.test/configure", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-6-luna", effort: "high" }),
    }),
    env,
    ctx,
  );
  await expect(
    agentEvalModel.fetch(
      new Request("https://ai-gateway.invalid/openai/responses", {
        method: "POST",
        body: JSON.stringify({ model: "gpt-6-sol", input: [] }),
      }),
      env,
      ctx,
    ),
  ).rejects.toThrow("synthetic socket failure");
  const result = await agentEvalModel.fetch(
    new Request("https://eval-model.test/usage"),
    env,
    ctx,
  );
  await expect(result.json()).resolves.toMatchObject({
    requests: 1,
    failedRequests: 1,
    calls: [],
    failures: [{ stage: "transport", message: "synthetic socket failure" }],
  });
});

it("retains a bounded credential-scrubbed upstream refusal for acceptance diagnosis", async () => {
  vi.stubGlobal("fetch", upstream);
  upstream.mockResolvedValue(
    new Response(
      "Unsupported subscription field: metadata; authorization=Bearer sk-synthetic-secret",
      { status: 502 },
    ),
  );
  await agentEvalModel.fetch(
    new Request("https://eval-model.test/configure", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-6-sol", effort: "high" }),
    }),
    env,
    ctx,
  );
  const result = await agentEvalModel.fetch(
    new Request("https://eval-model.test/openai/responses", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-6-sol", input: [] }),
    }),
    env,
    ctx,
  );
  expect(result.status).toBe(502);
  const report = await agentEvalModel.fetch(
    new Request("https://eval-model.test/usage"),
    env,
    ctx,
  );
  const diagnostics = await report.json();
  expect(diagnostics).toMatchObject({
    requests: 1,
    failedRequests: 1,
    failures: [
      {
        stage: "http",
        status: 502,
        message: expect.stringContaining(
          "Unsupported subscription field: metadata",
        ),
      },
    ],
  });
  expect(JSON.stringify(diagnostics)).not.toContain("sk-synthetic-secret");
});

it("returns an oversized refusal without waiting for its unread caller branch", async () => {
  vi.stubGlobal("fetch", upstream);
  upstream.mockResolvedValue(
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("x".repeat(9000)));
        },
      }),
      { status: 502 },
    ),
  );
  await agentEvalModel.fetch(
    new Request("https://eval-model.test/configure", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-6-sol", effort: "high" }),
    }),
    env,
    ctx,
  );
  const outcome = await Promise.race([
    agentEvalModel
      .fetch(
        new Request("https://eval-model.test/openai/responses", {
          method: "POST",
          body: JSON.stringify({ model: "gpt-6-sol", input: [] }),
        }),
        env,
        ctx,
      )
      .then((response) => response.status),
    new Promise<"timed out">((resolve) =>
      setTimeout(() => resolve("timed out"), 100),
    ),
  ]);
  expect(outcome).toBe(502);
});
