import { afterEach, expect, it, vi } from "vitest";
import liveGateway from "./live-gateway";

// Failure modes: the agent keeps its pinned model; the swap drops other
// request or reasoning settings; the web peer (no swap configured) or a
// non-Responses route is rewritten; the run bundle cannot show which wire
// model actually answered.
const env = {
  GATEWAY_BASE_URL: "https://gateway.test/v1/account/gateway",
  GATEWAY_TOKEN: "synthetic-token",
  RUN_REVISION: "local",
};
const agentEnv = {
  ...env,
  RESPONSES_MODEL: "gpt-6-luna",
  RESPONSES_EFFORT: "high",
};
const responsesBody = {
  model: "gpt-6-sol",
  input: [{ role: "user", content: "synthetic" }],
  reasoning: { effort: "medium", summary: "auto" },
  stream: true,
};

const upstream = vi.fn<typeof fetch>();
afterEach(() => {
  upstream.mockReset();
  vi.unstubAllGlobals();
});

async function send(
  gatewayEnv: typeof env,
  pathname: string,
  body: string,
  contentType = "application/json",
): Promise<{ url: string; body: string }> {
  vi.stubGlobal("fetch", upstream);
  upstream.mockResolvedValue(new Response("ok"));
  await liveGateway.fetch(
    new Request("https://live-gateway.test/reset"),
    gatewayEnv,
  );
  await liveGateway.fetch(
    new Request(`https://ai-gateway.invalid${pathname}`, {
      method: "POST",
      headers: { "content-type": contentType },
      body,
    }),
    gatewayEnv,
  );
  const [url, init] = upstream.mock.lastCall ?? [];
  return { url: String(url), body: await new Response(init?.body).text() };
}

async function usage(gatewayEnv: typeof env) {
  return (
    await liveGateway.fetch(
      new Request("https://live-gateway.test/usage"),
      gatewayEnv,
    )
  ).json();
}

it("swaps the configured model and effort into Responses calls", async () => {
  const swapped = {
    ...responsesBody,
    model: "gpt-6-luna",
    reasoning: { effort: "high", summary: "auto" },
  };
  const sent = await send(
    agentEnv,
    "/openai/responses",
    JSON.stringify(responsesBody),
  );
  expect(sent.url).toBe(`${env.GATEWAY_BASE_URL}/openai/responses`);
  expect(JSON.parse(sent.body)).toEqual(swapped);
  expect(await usage(agentEnv)).toMatchObject({
    openai: { requests: 1, models: { "gpt-6-luna": 1 } },
  });
  // Media types are case-insensitive; the swap must not depend on them.
  const mixedCase = await send(
    agentEnv,
    "/openai/responses",
    JSON.stringify(responsesBody),
    "Application/JSON; charset=utf-8",
  );
  expect(JSON.parse(mixedCase.body)).toEqual(swapped);
});

it("forwards unconfigured peers and other routes unchanged", async () => {
  const unchanged = JSON.stringify(responsesBody);
  expect((await send(env, "/openai/responses", unchanged)).body).toBe(
    unchanged,
  );
  expect(await usage(env)).toMatchObject({
    openai: { models: { "gpt-6-sol": 1 } },
  });
  const messages = JSON.stringify({
    model: "synthetic-messages-model",
    max_tokens: 16,
  });
  expect((await send(agentEnv, "/anthropic/v1/messages", messages)).body).toBe(
    messages,
  );
  // Model counting is telemetry: a body it cannot read is still forwarded.
  expect((await send(env, "/workers-ai/run", "{not json")).body).toBe(
    "{not json",
  );
  expect(await usage(env)).toMatchObject({
    "workers-ai": { requests: 1, models: {} },
  });
});
