import { importRunId } from "@cubby/schemas/identifiers";
import { describe, expect, it } from "vitest";

import type {
  GatewayCallOptions,
  GatewayProvider,
} from "~/server/clients/ai-gateway";
import type { Database } from "~/server/db";

import {
  forwardGatewayRequest,
  type GatewayForwardPort,
} from "./gateway-forward";

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
  ] satisfies [string, string][],
  body: { model: "claude-haiku-4-5", messages: [] },
};

// A faithful stand-in for the forwarder's surroundings: it keeps what the
// transport shim was asked for and what was recorded, so the test reads them
// back typed.
function fakePort(respond: () => Response) {
  const sent: {
    provider: GatewayProvider;
    opts: GatewayCallOptions;
    url: string;
    init: RequestInit;
  }[] = [];
  const recorded: Parameters<GatewayForwardPort["recordUsage"]>[1][] = [];
  const port: GatewayForwardPort = {
    transport: (provider, opts) => (input, init) => {
      sent.push({ provider, opts, url: String(input), init: init ?? {} });
      return Promise.resolve(respond());
    },
    callUsage: (_model, body) =>
      body.includes('"usage"')
        ? {
            provider: "anthropic",
            usage: {
              input_tokens: 10,
              output_tokens: 5,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0,
            },
            cost_usd: 0.000035,
          }
        : null,
    recordUsage: (_db, input) => {
      recorded.push(input);
      return Promise.resolve();
    },
  };
  return { port, sent, recorded };
}

// The unit under test never touches the database; the port receives it.
// SAFETY: the unit under test never dereferences the database; it only hands
// it to the injected `recordUsage` port, which ignores it.
const db = {} as Database;
const runId = importRunId.parse("00000000-0000-4000-8000-000000000001");

describe("forwardGatewayRequest", () => {
  it("forwards the built request with the server's token and feature, and records priced usage", async () => {
    const { port, sent, recorded } = fakePort(
      () =>
        new Response('{"usage":{"input_tokens":10,"output_tokens":5}}', {
          status: 200,
          headers: { "cf-aig-log-id": "log-1", "x-secret": "hidden" },
        }),
    );
    const out = await forwardGatewayRequest(
      request,
      { db, runId, feature: "cookbook-epub-parsing" },
      port,
    );
    expect(out.status).toBe(200);
    expect(out.headers).toContainEqual(["cf-aig-log-id", "log-1"]);
    expect(out.headers.map(([name]) => name)).not.toContain("x-secret");
    expect(out.body).toContain('"input_tokens":10');

    const [call] = sent;
    expect(call?.provider).toBe("anthropic");
    expect(call?.url).toBe("https://ai-gateway.invalid/anthropic/v1/messages");
    // The crate decides its own caching; the forwarder never forces a skip.
    expect(call?.opts.skipCache).toBeUndefined();
    expect(call?.opts.metadata).toEqual({
      cookbook: "Zuni",
      model: "claude-haiku-4-5",
      chunk: "k004",
      contract: "cookbook-indexed-v1",
      feature: "cookbook-epub-parsing",
    });
    const headers = new Headers(call?.init.headers);
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("cf-aig-authorization")).toBeNull();
    expect(headers.get("cf-aig-metadata")).toBeNull();
    expect(headers.get("anthropic-version")).toBe("2023-06-01");
    expect(call?.init.body).toBe(JSON.stringify(request.body));

    expect(recorded).toEqual([
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
    ]);
  });

  it("books an answer the gateway served from its cache as free, and passes the verdict on", async () => {
    const { port, recorded } = fakePort(
      () =>
        new Response('{"usage":{"input_tokens":10,"output_tokens":5}}', {
          status: 200,
          headers: { "cf-aig-cache-status": "HIT" },
        }),
    );
    const out = await forwardGatewayRequest(
      request,
      { db, runId, feature: "cookbook-epub-parsing" },
      port,
    );
    expect(out.headers).toContainEqual(["cf-aig-cache-status", "HIT"]);
    expect(recorded).toEqual([
      expect.objectContaining({
        inputTokens: 10,
        outputTokens: 5,
        estimatedCost: 0,
        cacheStatus: "hit",
      }),
    ]);
  });
  it("returns provider errors as-is without recording usage", async () => {
    const { port, recorded } = fakePort(
      () =>
        new Response(
          '{"error":{"code":2018,"message":"Wholesale Rate limited"}}',
          { status: 429, headers: { "retry-after": "7" } },
        ),
    );
    const out = await forwardGatewayRequest(
      request,
      { db, runId, feature: "cookbook-epub-parsing" },
      port,
    );
    expect(out.status).toBe(429);
    expect(out.headers).toContainEqual(["retry-after", "7"]);
    expect(out.body).toContain("Wholesale");
    expect(recorded).toEqual([]);
  });

  it("turns a network failure into a thrown error", async () => {
    const { port } = fakePort(() => {
      throw new Error("socket hang up");
    });
    await expect(
      forwardGatewayRequest(
        request,
        { feature: "cookbook-epub-parsing" },
        port,
      ),
    ).rejects.toThrow(/socket hang up/);
  });

  it("surfaces the shim's dev-only missing-credential error", async () => {
    const { port } = fakePort(() => new Response("{}"));
    await expect(
      forwardGatewayRequest(
        request,
        { feature: "cookbook-epub-parsing" },
        {
          ...port,
          transport: () => () => {
            throw new Error("AI_GATEWAY_API_KEY is not configured.");
          },
        },
      ),
    ).rejects.toThrow(/AI_GATEWAY_API_KEY/);
  });

  it("rejects a path whose provider segment is not a gateway provider", async () => {
    const { port } = fakePort(() => new Response("{}"));
    await expect(
      forwardGatewayRequest(
        { ...request, path: "/not-a-provider/v1/messages" },
        { feature: "cookbook-epub-parsing" },
        port,
      ),
    ).rejects.toThrow(/Unsupported gateway provider route/);
  });
});
