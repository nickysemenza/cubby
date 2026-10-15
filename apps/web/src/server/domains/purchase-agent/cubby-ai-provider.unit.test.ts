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

const completedResponse = (headers: Record<string, string> = {}) =>
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
    { headers: { "content-type": "text/event-stream", ...headers } },
  );

describe("createCubbyGatewayFetch", () => {
  // The agent adapter must forward both opt-in and admission; otherwise a
  // disconnected research Run waits despite its existing paid allowance.
  it("forwards durable admission for budgeted disconnected research", async () => {
    const events: string[] = [];
    const send = createCubbyGatewayFetch("openai", {
      gateway: () =>
        gateway(async () => {
          events.push("transmit");
          return completedResponse();
        }),
      subscriptionRequired: true,
      subscriptionFallback: "budgeted",
      subscription: async () => null,
      beforePaidRequest: async (request) => {
        expect(await request.query()).toEqual({
          model: "gpt-6-sol",
          input: [],
        });
        events.push("admitted");
      },
      onTransport: (transport) => events.push(transport),
    });
    expect(
      (
        await send("https://ai-gateway.invalid/openai/responses", {
          method: "POST",
          body: JSON.stringify({ model: "gpt-6-sol", input: [] }),
        })
      ).ok,
    ).toBe(true);
    expect(events).toEqual(["admitted", "gateway", "transmit"]);
  });

  it("stops subscription-required research when the plan is disconnected", async () => {
    const run = vi.fn(async () => completedResponse());
    const options = {
      gateway: () => gateway(run),
      subscription: async () => null,
      subscriptionRequired: true,
    };
    await expect(
      createCubbyGatewayFetch("openai", options)(
        "https://api.openai.com/v1/responses",
        {
          method: "POST",
          body: JSON.stringify({ model: "gpt-6-sol", input: [] }),
        },
      ),
    ).rejects.toThrow(/Required ChatGPT subscription/);
    expect(run).not.toHaveBeenCalled();
  });

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

  // Selecting the plan precedes quota refusal. Marking pi unbilled at that
  // selection would incorrectly erase the final paid fallback's catalog cost.
  it.each(["http429", "pre-output-stream"] as const)(
    "keeps paid fallback costs after a selected subscription refuses quota through %s",
    async (protocol) => {
      const transports: string[] = [];
      const admitted = vi.fn(async () => {});
      const run = vi.fn(async () =>
        completedResponse({ "cf-aig-log-id": "synthetic-paid-log" }),
      );
      const models = createModels();
      for (const provider of cubbyAgentProviders({
        gateway: () => gateway(run),
        recorder: createContextRecorder(),
        subscriptionRequired: true,
        subscriptionFallback: "budgeted",
        beforePaidRequest: admitted,
        subscription: async (_body, options) => {
          options?.onSelected?.();
          if (protocol === "pre-output-stream") {
            const events = [
              {
                type: "response.created",
                response: { status: "in_progress", output: [] },
              },
              {
                type: "response.in_progress",
                response: { status: "in_progress", output: [] },
              },
              {
                type: "invalid_request_error",
                code: "subscription_sharing_usage_limit_exceeded",
                message: "Synthetic plan allowance exhausted",
                param: null,
              },
            ];
            return new Response(
              new TextEncoder().encode(
                events
                  .map(
                    (event) =>
                      `event: ${event.type === "invalid_request_error" ? "error" : event.type}\ndata: ${JSON.stringify(event)}\n\n`,
                  )
                  .join(""),
              ),
            );
          }
          return new Response(
            JSON.stringify({
              error: {
                code: "subscription_sharing_usage_limit_exceeded",
                message: "Synthetic plan allowance exhausted",
              },
            }),
            { status: 429 },
          );
        },
        onTransport: (transport) => transports.push(transport),
      }))
        models.setProvider(provider);
      const model = models.getModel("openai", "gpt-6-sol");
      if (!model) throw new Error("Missing test model");
      const stream = models.stream(model, { messages: [] });
      let terminalCost: number | undefined;
      for await (const event of stream)
        if (event.type === "done")
          terminalCost = event.message.usage.cost.total;
      expect(terminalCost).toBeGreaterThan(0);
      expect((await stream.result()).usage.cost.total).toBeGreaterThan(0);
      expect(transports).toEqual(["chatgpt", "gateway"]);
      expect(admitted).toHaveBeenCalledOnce();
      expect(run).toHaveBeenCalledOnce();
    },
  );
  // A gateway cache HIT is not billed, but it still rode the gateway and its
  // log id is the usage row's correlation handle.
  it("zeroes a cached generation's cost, keeps gateway transport, and reports the log id", async () => {
    const transports: string[] = [];
    const observed: unknown[] = [];
    const models = createModels();
    for (const provider of cubbyAgentProviders({
      gateway: () =>
        gateway(async () =>
          completedResponse({
            "cf-aig-log-id": "example-log",
            "cf-aig-cache-status": "HIT",
          }),
        ),
      recorder: createContextRecorder(),
      onTransport: (transport) => transports.push(transport),
      onResponse: (info) => observed.push(info),
    }))
      models.setProvider(provider);
    const model = models.getModel("openai", "gpt-6-sol");
    if (!model) throw new Error("Missing test model");
    const message = await models.complete(model, { messages: [] });
    expect(message.usage.cost.total).toBe(0);
    expect(message.usage.input).toBe(100);
    expect(transports).toEqual(["gateway"]);
    expect(observed).toEqual([
      { gatewayLogId: "example-log", gatewayCacheStatus: "hit" },
    ]);
  });

  it("keeps a connected plan's failure on chatgpt without a gateway retry", async () => {
    const run = vi.fn(async () => new Response("stream"));
    const transports: string[] = [];
    const gatewayFetch = createCubbyGatewayFetch("openai", {
      gateway: () => gateway(run),
      subscription: async (_body, options) => {
        options?.onSelected?.();
        throw new Error("ChatGPT plan connection reset");
      },
      onTransport: (transport) => transports.push(transport),
    });
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
    const gatewayFetch = createCubbyGatewayFetch("openai", {
      gateway: () => gateway(run),
      subscription: async () => null,
      onTransport: (transport) => transports.push(transport),
    });
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
    const gatewayFetch = createCubbyGatewayFetch(test.route, {
      gateway: () => gateway(run),
    });

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
          skipCache: true,
          collectPayload: false,
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
