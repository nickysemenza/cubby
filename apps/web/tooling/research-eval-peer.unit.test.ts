import { afterEach, expect, it, vi } from "vitest";

import researchEvalPeer from "./research-eval-peer";
import { chatGptRequest } from "../src/server/ai/chatgpt/transport";

// Billing boundary: oversized context, exhausted allowance, or a broader tool
// surface must fail before upstream inference. Fixed sources contain no oracle.
const upstream = vi.fn<typeof fetch>();
const env = {
  ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
  AI_GATEWAY_API_KEY: "synthetic-key",
  GATEWAY_ENVIRONMENT: "development" as const,
  ROLE: "researcher" as const,
};
const ctx = { waitUntil: () => undefined };
afterEach(() => {
  upstream.mockReset();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("refuses unrelated tools in the production subscription declaration before transmission", async () => {
  vi.stubGlobal("fetch", upstream);
  upstream.mockResolvedValue(new Response("ok"));
  await researchEvalPeer.fetch(
    new Request("https://eval.test/configure", {
      method: "POST",
      body: JSON.stringify({
        model: "gpt-6-sol",
        effort: "high",
        limits: { requests: 2, tokens: 4000, outputTokens: 100 },
        sources: [],
      }),
    }),
    env,
    ctx,
  );
  const body = chatGptRequest(
    {
      input: [{ role: "user", content: "Synthetic source investigation" }],
      tools: [
        {
          type: "function",
          name: "expense_create",
          parameters: { type: "object", properties: {} },
        },
      ],
    },
    "gpt-6-sol",
  );
  const response = await researchEvalPeer.fetch(
    new Request("https://eval.test/openai/responses", {
      method: "POST",
      body: JSON.stringify(body),
    }),
    env,
    ctx,
  );
  expect(response.status).toBe(429);
  expect(upstream).not.toHaveBeenCalled();
});

it("refuses an oversized or exhausted research request before billing", async () => {
  vi.stubGlobal("fetch", upstream);
  upstream.mockResolvedValue(new Response("ok"));
  await researchEvalPeer.fetch(
    new Request("https://eval.test/configure", {
      method: "POST",
      body: JSON.stringify({
        model: "gpt-6-luna",
        effort: "medium",
        limits: { requests: 1, tokens: 2_000, outputTokens: 100 },
        sources: [],
      }),
    }),
    env,
    ctx,
  );
  const send = (input: string) =>
    researchEvalPeer.fetch(
      new Request("https://eval.test/openai/responses", {
        method: "POST",
        body: JSON.stringify({ model: "gpt-6-sol", input, tools: [] }),
      }),
      env,
      ctx,
    );
  expect((await send("x".repeat(2_000))).status).toBe(429);
  expect(upstream).not.toHaveBeenCalled();
  expect((await send("bounded source investigation")).status).toBe(200);
  expect((await send("another turn")).status).toBe(429);
  expect(upstream).toHaveBeenCalledTimes(1);
  expect(
    JSON.parse(String(upstream.mock.lastCall?.[1]?.body)).max_output_tokens,
  ).toBe(100);
});

it("refuses an expired investigation before billing", async () => {
  vi.stubGlobal("fetch", upstream);
  upstream.mockResolvedValue(new Response("ok"));
  const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
  await researchEvalPeer.fetch(
    new Request("https://eval.test/configure", {
      method: "POST",
      body: JSON.stringify({
        model: "gpt-6-sol",
        effort: "high",
        limits: {
          requests: 2,
          tokens: 4_000,
          outputTokens: 100,
          wallMs: 1_000,
        },
        sources: [],
      }),
    }),
    env,
    ctx,
  );
  clock.mockReturnValue(2_001);
  const response = await researchEvalPeer.fetch(
    new Request("https://eval.test/openai/responses", {
      method: "POST",
      body: JSON.stringify({ input: "bounded investigation", tools: [] }),
    }),
    env,
    ctx,
  );
  expect(response.status).toBe(429);
  expect(upstream).not.toHaveBeenCalled();
});

it("carries cancellation to the billed upstream request", async () => {
  vi.stubGlobal("fetch", upstream);
  upstream.mockResolvedValue(new Response("ok"));
  await researchEvalPeer.fetch(
    new Request("https://eval.test/configure", {
      method: "POST",
      body: JSON.stringify({
        model: "gpt-6-sol",
        effort: "high",
        limits: {
          requests: 2,
          tokens: 4_000,
          outputTokens: 100,
          wallMs: 1_000,
        },
        sources: [],
      }),
    }),
    env,
    ctx,
  );
  const controller = new AbortController();
  await researchEvalPeer.fetch(
    new Request("https://eval.test/openai/responses", {
      method: "POST",
      body: JSON.stringify({ input: "bounded investigation", tools: [] }),
      signal: controller.signal,
    }),
    env,
    ctx,
  );
  const signal = upstream.mock.lastCall?.[1]?.signal;
  expect(signal).toBeInstanceOf(AbortSignal);
  controller.abort();
  expect(signal?.aborted).toBe(true);
});
