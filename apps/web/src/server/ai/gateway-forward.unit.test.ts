import { runEntityId } from "@cubby/schemas/identifiers";
import type { GatewayProvider } from "@cubby/shared/ai/models";
import { describe, expect, it } from "vitest";

import type { GatewayCallOptions } from "~/server/ai/gateway";
import { type AiUsagePort, recordAiUsage } from "~/server/ai/usage";
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
// transport shim was asked for and the event the real usage writer emitted,
// so the writer's accounting rules apply and the test reads them back typed.
function fakePort(
  respond: () => Response,
  selected: "gateway" | "chatgpt" = "gateway",
  promptCache = { read: 0, write: 0 },
) {
  const sent: {
    provider: GatewayProvider;
    opts: GatewayCallOptions;
    url: string;
    init: RequestInit;
  }[] = [];
  const recorded: Parameters<AiUsagePort["emit"]>[1][] = [];
  const port: GatewayForwardPort = {
    transport: (provider, opts) => (input, init) => {
      opts.onTransport?.(selected);
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
              cache_read_input_tokens: promptCache.read,
              cache_creation_input_tokens: promptCache.write,
            },
          }
        : null,
    recordUsage: (database, input) =>
      recordAiUsage(database, input, {
        emit: (_db, event) => {
          recorded.push(event);
          return Promise.resolve();
        },
      }),
  };
  return { port, sent, recorded };
}

// The unit under test never touches the database; the port receives it.
// SAFETY: the unit under test never dereferences the database; it only hands
// it to the injected `recordUsage` port, which ignores it.
const db = {} as Database;
const runId = runEntityId.parse("00000000-0000-4000-8000-000000000001");

describe("forwardGatewayRequest", () => {
  it("forwards the built request with the server's token and feature, and leaves pricing to the catalog consumer", async () => {
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
    // Regression: the crate's cookbook, chunk, contract, and model tags once
    // went to the gateway verbatim (a log filter and spend bucket per chunk);
    // `model` and `purpose` are still read below for the usage row.
    expect(call?.opts.metadata).toEqual({
      feature: "cookbook-epub-parsing",
      operation: "cookbook.extract",
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
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        estimatedCost: null,
        cacheStatus: "none",
        gatewayLogId: "log-1",
        transport: "gateway",
      }),
    ]);
  });

  // Prompt-cache traffic is token evidence, not the caller's cache state:
  // `cacheStatus` once read "hit" for any cache-read token.
  it("records prompt-cache tokens without reporting a caller cache hit", async () => {
    const { port, recorded } = fakePort(
      () =>
        new Response('{"usage":{"input_tokens":10,"output_tokens":5}}', {
          status: 200,
        }),
      "gateway",
      { read: 40, write: 7 },
    );
    await forwardGatewayRequest(
      request,
      { db, runId, feature: "cookbook-epub-parsing" },
      port,
    );
    expect(recorded).toEqual([
      expect.objectContaining({
        cacheReadTokens: 40,
        cacheWriteTokens: 7,
        cacheStatus: "none",
        estimatedCost: null,
      }),
    ]);
  });

  // The crate's OpenAI Responses calls ride the household's ChatGPT plan when
  // it is connected; that answer is plan usage, not an API-priced call.
  it("attributes a ChatGPT plan answer to chatgpt at no API cost", async () => {
    const { port, recorded } = fakePort(
      () =>
        new Response('{"usage":{"input_tokens":10,"output_tokens":5}}', {
          status: 200,
        }),
      "chatgpt",
    );
    await forwardGatewayRequest(
      { ...request, path: "/openai/responses" },
      { db, runId, feature: "cookbook-epub-parsing" },
      port,
    );
    expect(recorded).toEqual([
      expect.objectContaining({
        inputTokens: 10,
        outputTokens: 5,
        estimatedCost: 0,
        transport: "chatgpt",
      }),
    ]);
  });

  it("books an answer the gateway served from its cache as free, and passes the verdict on", async () => {
    const { port, recorded } = fakePort(
      () =>
        new Response('{"usage":{"input_tokens":10,"output_tokens":5}}', {
          status: 200,
          headers: {
            "cf-aig-cache-status": "HIT",
            "cf-aig-log-id": "log-hit",
          },
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
        // The gateway's verdict never overwrites the caller's cache state.
        cacheStatus: "none",
        gatewayLogId: "log-hit",
        // A Gateway response-cache hit still went through the Gateway;
        // `cache` is only an app-side replay with no upstream call.
        transport: "gateway",
      }),
    ]);
  });
  it("returns provider errors as-is and records the failed attempt", async () => {
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
    expect(recorded).toEqual([
      expect.objectContaining({
        feature: "cookbook-epub-parsing",
        model: "claude-haiku-4-5",
        status: "failed",
        transport: "gateway",
      }),
    ]);
  });

  // A connected ChatGPT plan that throws before any response is still a
  // failed ChatGPT call: recorded as such, at no API cost, error unchanged.
  it("records a thrown ChatGPT plan failure as a failed chatgpt call", async () => {
    const { port, recorded } = fakePort(() => {
      throw new Error("ChatGPT plan connection reset");
    }, "chatgpt");
    await expect(
      forwardGatewayRequest(
        { ...request, path: "/openai/responses" },
        { db, runId, feature: "cookbook-epub-parsing" },
        port,
      ),
    ).rejects.toThrow("Gateway request failed: ChatGPT plan connection reset");
    expect(recorded).toEqual([
      expect.objectContaining({
        status: "failed",
        transport: "chatgpt",
        estimatedCost: 0,
      }),
    ]);
  });

  it.each([200, 429])(
    "records exactly one failed call when a %s response stream disconnects",
    async (status) => {
      const { port, recorded } = fakePort(
        () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.error(new Error("synthetic stream reset"));
              },
            }),
            { status },
          ),
        "chatgpt",
      );
      await expect(
        forwardGatewayRequest(
          { ...request, path: "/openai/responses" },
          { db, runId, feature: "cookbook-epub-parsing" },
          port,
        ),
      ).rejects.toThrow("synthetic stream reset");
      expect(recorded).toEqual([
        expect.objectContaining({
          status: "failed",
          transport: "chatgpt",
          estimatedCost: 0,
        }),
      ]);
    },
  );

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
