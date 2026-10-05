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
  body: { model: string },
): Promise<{ url: string; body: unknown }> {
  vi.stubGlobal("fetch", upstream);
  upstream.mockResolvedValue(new Response("ok"));
  await liveGateway.fetch(
    new Request("https://live-gateway.test/reset"),
    gatewayEnv,
  );
  await liveGateway.fetch(
    new Request(`https://ai-gateway.invalid${pathname}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    gatewayEnv,
  );
  const [url, init] = upstream.mock.lastCall ?? [];
  return { url: String(url), body: await new Response(init?.body).json() };
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
  const sent = await send(agentEnv, "/openai/responses", responsesBody);
  expect(sent).toEqual({
    url: `${env.GATEWAY_BASE_URL}/openai/responses`,
    body: {
      ...responsesBody,
      model: "gpt-6-luna",
      reasoning: { effort: "high", summary: "auto" },
    },
  });
  expect(await usage(agentEnv)).toMatchObject({
    openai: { requests: 1, models: { "gpt-6-luna": 1 } },
  });
});

it("forwards unconfigured peers and other routes unchanged", async () => {
  expect((await send(env, "/openai/responses", responsesBody)).body).toEqual(
    responsesBody,
  );
  expect(await usage(env)).toMatchObject({
    openai: { models: { "gpt-6-sol": 1 } },
  });
  const messages = { model: "synthetic-messages-model", max_tokens: 16 };
  expect(
    (await send(agentEnv, "/anthropic/v1/messages", messages)).body,
  ).toEqual(messages);
});
