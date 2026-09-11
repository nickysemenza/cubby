import { fromPartial } from "@total-typescript/shoehorn";
import { afterEach, describe, expect, it, vi } from "vitest";

import { type getAiGateway, setCfEnv } from "~/server/cf-env";

import { gatewayBaseURL, gatewayFetch } from "./ai-gateway";

type AiGatewayBinding = NonNullable<ReturnType<typeof getAiGateway>>;
type GatewayRun = Parameters<AiGatewayBinding["run"]>;

afterEach(() => {
  setCfEnv(undefined);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

/**
 * `~/env` snapshots `process.env` at module load, so the REST branch needs a
 * fresh module graph after stubbing. The reimported `ai-gateway` also gets a
 * fresh `cf-env` with no binding — exactly the dev Node server's shape.
 */
async function devGatewayFetch(token: string) {
  vi.stubEnv("AI_GATEWAY_API_KEY", token);
  vi.resetModules();
  return (await import("./ai-gateway")).gatewayFetch;
}

/** Stand in for `env.AI.gateway("cubby")`, keeping what `run()` was handed. */
function fakeBinding(response: Response) {
  const calls: GatewayRun[] = [];
  setCfEnv(
    fromPartial<Env>({
      AI: {
        gateway: () =>
          fromPartial<AiGatewayBinding>({
            run: (...args: GatewayRun) => {
              calls.push(args);
              return Promise.resolve(response);
            },
          }),
      },
    }),
  );
  return calls;
}

const metadata = { feature: "recipe-flow", operation: "generate" };

describe("gatewayFetch on the Worker binding", () => {
  it("addresses the gateway by provider and endpoint, without the SDK's credentials", async () => {
    const calls = fakeBinding(new Response("{}"));
    const send = gatewayFetch("anthropic", { metadata, skipCache: true });
    const controller = new AbortController();

    await send(`${gatewayBaseURL("anthropic")}/v1/messages?beta=true`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        "x-api-key": "placeholder",
        authorization: "Bearer placeholder",
        "content-length": "17",
      },
      body: JSON.stringify({ model: "claude-sonnet-5" }),
      signal: controller.signal,
    });

    const [data, options] = calls[0] ?? [];
    expect(data).toEqual({
      provider: "anthropic",
      endpoint: "v1/messages?beta=true",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
      },
      query: { model: "claude-sonnet-5" },
    });
    expect(options?.gateway).toEqual({
      skipCache: true,
      metadata,
      requestTimeoutMs: undefined,
    });
    expect(options?.signal).toBe(controller.signal);
  });

  it("passes cacheTtlSeconds through as the binding's cacheTtl", async () => {
    const calls = fakeBinding(new Response("{}"));

    await gatewayFetch("anthropic", { metadata, cacheTtlSeconds: 604_800 })(
      `${gatewayBaseURL("anthropic")}/v1/messages`,
      { method: "POST", body: "{}" },
    );

    const [, options] = calls[0] ?? [];
    expect(options?.gateway).toMatchObject({ cacheTtl: 604_800 });
  });

  it("rejects a cacheTtlSeconds outside the gateway's 60s..30d range", async () => {
    fakeBinding(new Response("{}"));

    expect(() =>
      gatewayFetch("anthropic", { metadata, cacheTtlSeconds: 59 }),
    ).toThrow(/cacheTtlSeconds/);
    expect(() =>
      gatewayFetch("anthropic", {
        metadata,
        cacheTtlSeconds: 30 * 24 * 60 * 60 + 1,
      }),
    ).toThrow(/cacheTtlSeconds/);
    expect(() =>
      gatewayFetch("anthropic", { metadata, cacheTtlSeconds: 90.5 }),
    ).toThrow(/cacheTtlSeconds/);
  });

  it("accepts the gateway's boundary TTLs of 60s and 30 days", async () => {
    fakeBinding(new Response("{}"));

    expect(() =>
      gatewayFetch("anthropic", { metadata, cacheTtlSeconds: 60 }),
    ).not.toThrow();
    expect(() =>
      gatewayFetch("anthropic", {
        metadata,
        cacheTtlSeconds: 30 * 24 * 60 * 60,
      }),
    ).not.toThrow();
  });

  it("returns the gateway response untouched so streaming bodies pass through", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("event: delta\n"));
        controller.close();
      },
    });
    const streamed = new Response(stream, {
      headers: { "content-type": "text/event-stream" },
    });
    fakeBinding(streamed);

    const response = await gatewayFetch("openai", { metadata })(
      `${gatewayBaseURL("openai")}/responses`,
      { method: "POST", body: "{}" },
    );

    expect(response).toBe(streamed);
    expect(await response.text()).toBe("event: delta\n");
  });

  it("needs no local credential when the binding is present", async () => {
    vi.stubEnv("AI_GATEWAY_API_KEY", "");
    fakeBinding(new Response("{}"));

    await expect(
      gatewayFetch("compat", { metadata })(
        `${gatewayBaseURL("compat")}/chat/completions`,
        { method: "POST", body: "{}" },
      ),
    ).resolves.toBeInstanceOf(Response);
  });
});

describe("gatewayFetch on the dev REST fallback", () => {
  it("builds the provider route and signs it with the gateway token", async () => {
    const devFetch = await devGatewayFetch("dev-token");
    const sent: { url: string; init: RequestInit | undefined }[] = [];
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
      sent.push({ url: String(url), init });
      return Promise.resolve(new Response("{}"));
    });

    await devFetch("compat", {
      metadata,
      skipCache: true,
      requestTimeoutMs: 30_000,
    })(`${gatewayBaseURL("compat")}/chat/completions`, {
      method: "POST",
      headers: { authorization: "Bearer placeholder" },
      body: "{}",
    });

    const [call] = sent;
    expect(call?.url).toBe(
      "https://gateway.ai.cloudflare.com/v1/9f10f078d35d86c78dedece2300a6b88/cubby/compat/chat/completions",
    );
    const headers = new Headers(call?.init?.headers);
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("cf-aig-authorization")).toBe("Bearer dev-token");
    expect(headers.get("cf-aig-skip-cache")).toBe("true");
    expect(headers.get("cf-aig-request-timeout")).toBe("30000");
    expect(JSON.parse(headers.get("cf-aig-metadata") ?? "{}")).toEqual(
      metadata,
    );
  });

  it("sets cf-aig-cache-ttl from cacheTtlSeconds", async () => {
    const devFetch = await devGatewayFetch("dev-token");
    const sent: { init: RequestInit | undefined }[] = [];
    vi.stubGlobal("fetch", (_url: string, init?: RequestInit) => {
      sent.push({ init });
      return Promise.resolve(new Response("{}"));
    });

    await devFetch("compat", { metadata, cacheTtlSeconds: 604_800 })(
      `${gatewayBaseURL("compat")}/chat/completions`,
      { method: "POST", body: "{}" },
    );

    const headers = new Headers(sent[0]?.init?.headers);
    expect(headers.get("cf-aig-cache-ttl")).toBe("604800");
    expect(headers.has("cf-aig-skip-cache")).toBe(false);
  });

  it("reports the missing local credential instead of calling unauthenticated", async () => {
    const devFetch = await devGatewayFetch("");
    await expect(
      devFetch("anthropic", { metadata })(
        `${gatewayBaseURL("anthropic")}/v1/messages`,
        { method: "POST", body: "{}" },
      ),
    ).rejects.toThrow("AI_GATEWAY_API_KEY is not configured");
  });
});
