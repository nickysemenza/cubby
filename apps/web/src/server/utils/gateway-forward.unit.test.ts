import { describe, expect, it, vi } from "vitest";

vi.mock("~/server/clients/gateway-config", () => ({
  gatewayAdapterConfig: () => ({
    accountId: "acct",
    gatewayId: "gw",
    cfApiKey: "secret-token",
  }),
}));

const gatewayCallUsage = vi.fn();
vi.mock("~/lib/wasm", () => ({
  wasm: {
    gateway_call_usage: (model: string, body: string) =>
      gatewayCallUsage(model, body),
  },
}));

const recordAiUsage = vi.fn((_db: unknown, _input: unknown) =>
  Promise.resolve(),
);
vi.mock("~/server/ai-usage", () => ({
  recordAiUsage: (db: unknown, input: unknown) => recordAiUsage(db, input),
}));

import type { Database } from "~/server/db";

import { forwardGatewayRequest } from "./gateway-forward";

const request = {
  path: "/anthropic/v1/messages",
  headers: [
    ["content-type", "application/json"],
    ["anthropic-version", "2023-06-01"],
    ["cf-aig-authorization", "Bearer attacker"],
    ["authorization", "Bearer attacker"],
    [
      "cf-aig-metadata",
      JSON.stringify({
        cookbook: "Zuni",
        model: "claude-haiku-4-5",
        chunk: "k004",
        contract: "cookbook-indexed-v1",
        purpose: "extract",
        feature: "spoofed",
      }),
    ],
  ] as [string, string][],
  body: { model: "claude-haiku-4-5", messages: [] },
};

describe("forwardGatewayRequest", () => {
  it("forwards the built request with the server's token and feature, and records priced usage", async () => {
    const fetchMock = vi.fn(
      (): Promise<Response> =>
        Promise.resolve(
          new Response('{"usage":{"input_tokens":10,"output_tokens":5}}', {
            status: 200,
            headers: { "cf-aig-log-id": "log-1", "x-secret": "hidden" },
          }),
        ),
    );
    gatewayCallUsage.mockReturnValue({
      provider: "anthropic",
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
      cost_usd: 0.000035,
    });
    const out = await forwardGatewayRequest(
      request,
      { db: {} as Database, feature: "cookbook-epub-parsing" },
      { fetch: fetchMock },
    );
    expect(out.status).toBe(200);
    expect(out.headers).toContainEqual(["cf-aig-log-id", "log-1"]);
    expect(out.headers.map(([name]) => name)).not.toContain("x-secret");
    expect(out.body).toContain('"input_tokens":10');

    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(
      "https://gateway.ai.cloudflare.com/v1/acct/gw/anthropic/v1/messages",
    );
    const headers = init.headers as Headers;
    expect(headers.get("cf-aig-authorization")).toBe("Bearer secret-token");
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("anthropic-version")).toBe("2023-06-01");
    expect(JSON.parse(headers.get("cf-aig-metadata") ?? "{}")).toEqual({
      cookbook: "Zuni",
      model: "claude-haiku-4-5",
      chunk: "k004",
      contract: "cookbook-indexed-v1",
      feature: "cookbook-epub-parsing",
    });
    expect(init.body).toBe(JSON.stringify(request.body));

    expect(recordAiUsage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        feature: "cookbook-epub-parsing",
        provider: "anthropic",
        model: "claude-haiku-4-5",
        operation: "cookbook.extract",
        inputTokens: 10,
        outputTokens: 5,
        estimatedCost: 0.000035,
        cacheStatus: "none",
      }),
    );
  });

  it("returns provider errors as-is without recording usage", async () => {
    recordAiUsage.mockClear();
    const fetchMock = vi.fn(
      (): Promise<Response> =>
        Promise.resolve(
          new Response('{"error":{"code":2018,"message":"Wholesale Rate limited"}}', {
            status: 429,
            headers: { "retry-after": "7" },
          }),
        ),
    );
    const out = await forwardGatewayRequest(
      request,
      { db: {} as Database, feature: "cookbook-epub-parsing" },
      { fetch: fetchMock },
    );
    expect(out.status).toBe(429);
    expect(out.headers).toContainEqual(["retry-after", "7"]);
    expect(out.body).toContain("Wholesale");
    expect(recordAiUsage).not.toHaveBeenCalled();
  });

  it("turns a network failure into a thrown error", async () => {
    const fetchMock = vi.fn((): Promise<Response> =>
      Promise.reject(new Error("socket hang up")),
    );
    await expect(
      forwardGatewayRequest(
        request,
        { feature: "cookbook-epub-parsing" },
        { fetch: fetchMock },
      ),
    ).rejects.toThrow(/socket hang up/);
  });
});
