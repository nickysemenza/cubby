import { describe, expect, it, vi } from "vitest";

import {
  createCubbyGatewayFetch,
  withSequentialToolCalls,
} from "./cubby-ai-provider";
import type { AgentGateway } from "./environment";

const runId = "f47ac10b-58cc-4372-a567-0e02b2c3d479";

describe("createCubbyGatewayFetch", () => {
  it("attributes a coordinator request to its import run", async () => {
    const run = vi.fn(
      async (
        _query: Parameters<AgentGateway["run"]>[0],
        _options: Parameters<AgentGateway["run"]>[1],
      ) => new Response("stream"),
    );
    const gatewayFetch = createCubbyGatewayFetch(
      "openai",
      () => ({ id: "cubby", run }),
      () => runId,
    );
    await gatewayFetch("https://ai-gateway.invalid/openai/responses", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-6-sol" }),
    });
    expect(run.mock.calls[0]?.[1]).toMatchObject({
      gateway: { metadata: { runId } },
    });
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
    const gatewayFetch = createCubbyGatewayFetch(
      test.route,
      () => ({ id: "cubby", run }),
      () => undefined,
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
          metadata: {
            feature: "purchase_import_agent",
            jobKind: "purchase_import_run",
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
