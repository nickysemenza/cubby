import { describe, expect, it, vi } from "vitest";

import {
  createCubbyGatewayFetch,
  cubbyAiGatewayProviders,
} from "./cubby-ai-provider";

describe("createCubbyGatewayFetch", () => {
  it.each([
    {
      provider: "openai" as const,
      url: "https://ai-gateway.invalid/openai/responses?beta=true",
      model: "gpt-5.6-terra",
      endpoint: "responses?beta=true",
    },
    {
      provider: "anthropic" as const,
      url: "https://ai-gateway.invalid/anthropic/v1/messages",
      model: "claude-sonnet-5",
      endpoint: "v1/messages",
    },
  ])("routes $provider through the Cubby Universal Gateway", async (test) => {
    const expected = new Response("stream", { status: 200 });
    const run = vi.fn(async () => expected);
    const gatewayFetch = createCubbyGatewayFetch(test.provider, () => ({
      run,
    }));

    const response = await gatewayFetch(test.url, {
      method: "POST",
      headers: {
        authorization: "Bearer placeholder",
        "content-length": "42",
        "content-type": "application/json",
        "x-api-key": "placeholder",
        "x-client-request-id": "run-1",
      },
      body: JSON.stringify({ model: test.model, stream: true }),
    });

    expect(response).toBe(expected);
    expect(run).toHaveBeenCalledWith(
      {
        provider: test.provider,
        endpoint: test.endpoint,
        headers: {
          "content-type": "application/json",
          "x-client-request-id": "run-1",
        },
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

  it("registers only the approved Gateway-backed model roster", () => {
    const providers = cubbyAiGatewayProviders(() => ({
      gateway: () => ({ run: vi.fn() }),
    }));

    expect(
      providers.flatMap((provider) =>
        provider.getModels().map((model) => `${provider.id}/${model.id}`),
      ),
    ).toEqual([
      "openai/gpt-5.6-luna",
      "openai/gpt-5.6-terra",
      "openai/gpt-5.6-sol",
      "anthropic/claude-haiku-4-5",
      "anthropic/claude-sonnet-5",
    ]);
  });
});
