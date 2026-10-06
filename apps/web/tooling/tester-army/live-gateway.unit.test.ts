import { afterEach, expect, it, vi } from "vitest";
import liveGateway from "./live-gateway";

// Failure modes: the agent keeps its pinned model; the swap drops other
// request or reasoning settings; the web peer (no swap configured) or a
// non-Responses route is rewritten; the run bundle cannot show which wire
// model actually answered; the caller's feature and operation are replaced,
// or its diagnostics or claimed environment reach the gateway; a Workers AI
// call takes the provider route that duplicates it into `default`.
const env = {
  ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
  GATEWAY_TOKEN: "synthetic-token",
  GATEWAY_ENVIRONMENT: "ci" as const,
};
const GATEWAY_BASE_URL = `https://gateway.ai.cloudflare.com/v1/${env.ACCOUNT_ID}/cubby`;
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
  metadata?: string,
): Promise<{ url: string; body: string; headers: Headers }> {
  vi.stubGlobal("fetch", upstream);
  upstream.mockResolvedValue(new Response("ok"));
  await liveGateway.fetch(
    new Request("https://live-gateway.test/reset"),
    gatewayEnv,
  );
  await liveGateway.fetch(
    new Request(`https://ai-gateway.invalid${pathname}`, {
      method: "POST",
      headers: {
        "content-type": contentType,
        ...(metadata && { "cf-aig-metadata": metadata }),
      },
      body,
    }),
    gatewayEnv,
  );
  const [url, init] = upstream.mock.lastCall ?? [];
  return {
    url: String(url),
    body: await new Response(init?.body).text(),
    headers: new Headers(init?.headers),
  };
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
  expect(sent.url).toBe(`${GATEWAY_BASE_URL}/openai/responses`);
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

it("refuses a swap the Responses protocol cannot carry", async () => {
  // The peer rewrites only OpenAI Responses bodies; an Anthropic model there
  // would be sent upstream on the wrong protocol.
  await expect(
    send(
      { ...agentEnv, RESPONSES_MODEL: "claude-haiku-4-5" },
      "/openai/responses",
      JSON.stringify(responsesBody),
    ),
  ).rejects.toThrow(/OpenAI Responses/u);
  expect(upstream).not.toHaveBeenCalled();
});

it("strips SDK credentials before the gateway authorizes the call", async () => {
  vi.stubGlobal("fetch", upstream);
  upstream.mockResolvedValue(new Response("ok"));
  await liveGateway.fetch(
    new Request("https://ai-gateway.invalid/openai/responses", {
      method: "POST",
      headers: {
        authorization: "Bearer sdk-placeholder",
        "x-api-key": "sdk-placeholder",
      },
      body: JSON.stringify(responsesBody),
    }),
    env,
  );
  const headers = new Headers(upstream.mock.lastCall?.[1]?.headers);
  expect(headers.get("authorization")).toBeNull();
  expect(headers.get("x-api-key")).toBeNull();
  expect(headers.get("cf-aig-authorization")).toBe("Bearer synthetic-token");
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
  expect((await send(env, "/openai/responses", "{not json")).body).toBe(
    "{not json",
  );
  expect(await usage(env)).toMatchObject({
    openai: { requests: 1, models: {} },
  });
});

it("keeps the caller's labels under the launcher's environment", async () => {
  const sent = await send(
    env,
    "/anthropic/v1/messages",
    "{}",
    "application/json",
    JSON.stringify({
      environment: "production",
      feature: "field-suggestion",
      operation: "suggest",
      entityKind: "product",
      entityId: "synthetic-entity",
      runId: "synthetic-run",
    }),
  );
  expect(JSON.parse(sent.headers.get("cf-aig-metadata") ?? "{}")).toEqual({
    environment: "ci",
    feature: "field-suggestion",
    operation: "suggest",
    entityKind: "product",
  });
  const unlabelled = await send(env, "/anthropic/v1/messages", "{}");
  expect(JSON.parse(unlabelled.headers.get("cf-aig-metadata") ?? "{}")).toEqual(
    { environment: "ci", feature: "tester-army", operation: "coupled.proxy" },
  );
});

it("runs Workers AI through the account run route, scoped to cubby", async () => {
  const input = { state: "synthetic", questions: {} };
  const sent = await send(
    env,
    "/workers-ai/run/typesafe/jev",
    JSON.stringify(input),
    "application/json",
    JSON.stringify({ feature: "field-suggestion", operation: "decide" }),
  );
  expect(sent.url).toBe(
    `https://api.cloudflare.com/client/v4/accounts/${env.ACCOUNT_ID}/ai/run`,
  );
  expect(sent.headers.get("authorization")).toBe("Bearer synthetic-token");
  expect(sent.headers.get("cf-aig-gateway-id")).toBe("cubby");
  expect(sent.headers.get("cf-aig-skip-cache")).toBe("true");
  expect(JSON.parse(sent.headers.get("cf-aig-metadata") ?? "{}")).toEqual({
    environment: "ci",
    feature: "field-suggestion",
    operation: "decide",
  });
  expect(JSON.parse(sent.body)).toEqual({
    model: "typesafe/jev",
    input,
  });

  upstream.mockClear();
  const response = await liveGateway.fetch(
    new Request("https://ai-gateway.invalid/workers-ai/run/typesafe/jev", {
      method: "POST",
      body: "{not json",
    }),
    env,
  );
  expect(response.status).toBe(400);
  expect(upstream).not.toHaveBeenCalled();
});
