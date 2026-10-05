import { createModels } from "@earendil-works/pi-ai/models";
import { describe, expect, it, vi } from "vitest";

import { createContextRecorder } from "./context-breakdown";
import {
  createCubbyGatewayFetch,
  cubbyAgentProviders,
  withSequentialToolCalls,
} from "./cubby-ai-provider";
import type { AgentGateway } from "./environment";

const gateway = (run: AgentGateway["run"]): AgentGateway => ({
  id: "cubby",
  environment: "production",
  run,
});

describe("createCubbyGatewayFetch", () => {
  // Subscription responses must not acquire API prices in the persisted pi
  // transcript, and a subsequent paid response must retain its API price.
  it("normalizes subscription costs before forwarding terminal events", async () => {
    const response = () =>
      new Response(
        `data: ${JSON.stringify({
          type: "response.completed",
          response: {
            id: "example-response",
            status: "completed",
            output: [],
            usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
          },
        })}\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    let subscribed = true;
    const models = createModels();
    for (const provider of cubbyAgentProviders({
      gateway: () => gateway(async () => response()),
      recorder: createContextRecorder(),
      subscription: async (_body, options) => {
        if (!subscribed) return null;
        options?.onSelected?.();
        return response();
      },
    }))
      models.setProvider(provider);
    const model = models.getModel("openai", "gpt-6-sol");
    if (!model) throw new Error("Missing test model");
    const stream = models.stream(model, { messages: [] });
    let terminalCost: number | undefined;
    for await (const event of stream) {
      if (event.type === "done") terminalCost = event.message.usage.cost.total;
    }
    expect(terminalCost).toBe(0);
    expect((await stream.result()).usage.cost.total).toBe(0);
    subscribed = false;
    const paid = await models.complete(model, { messages: [] });
    expect(paid.usage.cost.total).toBeGreaterThan(0);
  });
  it("keeps a connected plan's failure on chatgpt without a gateway retry", async () => {
    const run = vi.fn(async () => new Response("stream"));
    const transports: string[] = [];
    const gatewayFetch = createCubbyGatewayFetch(
      "openai",
      () => gateway(run),
      async (_body, options) => {
        options?.onSelected?.();
        throw new Error("ChatGPT plan connection reset");
      },
      (transport) => transports.push(transport),
    );
    await expect(
      gatewayFetch("https://ai-gateway.invalid/openai/responses", {
        method: "POST",
        body: JSON.stringify({ model: "gpt-6-sol" }),
      }),
    ).rejects.toThrow(/connection reset/);
    expect(transports).toEqual(["chatgpt"]);
    expect(run).not.toHaveBeenCalled();
  });

  it("reports gateway when the household has no plan connection", async () => {
    const run = vi.fn(async () => new Response("stream"));
    const transports: string[] = [];
    const gatewayFetch = createCubbyGatewayFetch(
      "openai",
      () => gateway(run),
      async () => null,
      (transport) => transports.push(transport),
    );
    await gatewayFetch("https://ai-gateway.invalid/openai/responses", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-6-sol" }),
    });
    expect(transports).toEqual(["gateway"]);
    expect(run).toHaveBeenCalledOnce();
  });

  it.each([
    {
      route: "openai" as const,
      url: "https://ai-gateway.invalid/openai/responses?beta=true",
      model: "gpt-6-sol",
      endpoint: "responses?beta=true",
    },
    {
      route: "anthropic" as const,
      url: "https://ai-gateway.invalid/anthropic/v1/messages",
      model: "claude-sonnet-5",
      endpoint: "v1/messages",
    },
  ])("routes $route through the Cubby Universal Gateway", async (test) => {
    const expected = new Response("stream", { status: 200 });
    const run = vi.fn(async () => expected);
    const gatewayFetch = createCubbyGatewayFetch(test.route, () =>
      gateway(run),
    );

    const response = await gatewayFetch(test.url, {
      method: "POST",
      headers: {
        authorization: "Bearer placeholder",
        "content-length": "42",
        "content-type": "application/json",
        "x-api-key": "placeholder",
      },
      body: JSON.stringify({ model: test.model, stream: true }),
    });

    expect(response).toBe(expected);
    expect(run).toHaveBeenCalledWith(
      {
        provider: test.route,
        endpoint: test.endpoint,
        headers: { "content-type": "application/json" },
        query: { model: test.model, stream: true },
      },
      {
        gateway: {
          id: "cubby",
          // Regression: the run id and a jobKind duplicating the feature
          // once rode here; the Run's usage rows keep its attribution.
          metadata: {
            environment: "production",
            feature: "purchase_import_agent",
            operation: "agent.generation",
          },
        },
        signal: undefined,
      },
    );
  });
});

// pi ends a run on a terminating tool only when it is the round's sole call;
// a batched pending browser command would otherwise keep the run going.
describe("withSequentialToolCalls", () => {
  const tools = [{ type: "function", name: "issue_browser_command" }];

  it("disables parallel calls on Responses and Messages requests with tools", () => {
    expect(withSequentialToolCalls("openai", { tools })).toEqual({
      tools,
      parallel_tool_calls: false,
    });
    expect(
      withSequentialToolCalls("anthropic", {
        tools,
        tool_choice: { type: "any" },
      }),
    ).toEqual({
      tools,
      tool_choice: { type: "any", disable_parallel_tool_use: true },
    });
  });

  it("leaves tool-less requests such as compaction summaries unchanged", () => {
    const body = { input: [] };
    expect(withSequentialToolCalls("openai", body)).toBe(body);
  });
});
