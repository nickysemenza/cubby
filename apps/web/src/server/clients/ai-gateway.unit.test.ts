import { fromPartial } from "@total-typescript/shoehorn";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type getAiGateway, setCfEnv } from "~/server/cf-env";

import { gatewayBaseURL, gatewayFetch } from "./ai-gateway";

type AiGatewayBinding = NonNullable<ReturnType<typeof getAiGateway>>;
type GatewayRun = Parameters<AiGatewayBinding["run"]>;

// Vitest runs with NODE_ENV=test; a CI runner's own `CI` would otherwise
// change the expected `environment` between a laptop and GitHub.
beforeEach(() => {
  vi.stubEnv("CI", "");
});

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
/** What leaves the Worker: the caller's labels plus the derived environment. */
const outbound = { ...metadata, environment: "development" };

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
      metadata: outbound,
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

  it("captures a failed response before an adapter replaces it with a generic error", async () => {
    const failure = new Response(
      '{"error":{"message":"Synthetic quota reached"}}',
      {
        status: 429,
        headers: { "retry-after": "30" },
      },
    );
    fakeBinding(failure);
    const observed: unknown[] = [];
    const response = await gatewayFetch("openai", {
      metadata,
      onErrorResponse: (details) => observed.push(details),
    })(`${gatewayBaseURL("openai")}/responses`, {
      method: "POST",
      body: "{}",
    });

    expect(response).toBe(failure);
    expect(observed).toEqual([
      expect.objectContaining({
        status: 429,
        body: '{"error":{"message":"Synthetic quota reached"}}',
        retryAfter: "30",
      }),
    ]);
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
      outbound,
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

describe("gatewayFetch transport selection", () => {
  /** The binding plus a household ChatGPT plan whose inference fails. */
  function bindingWithPlan(connected: boolean) {
    const runs: GatewayRun[] = [];
    const infer = vi.fn(async () => {
      throw new Error("ChatGPT plan connection reset");
    });
    setCfEnv(
      fromPartial<Env>({
        AI: {
          gateway: () =>
            fromPartial<AiGatewayBinding>({
              run: (...args: GatewayRun) => {
                runs.push(args);
                return Promise.resolve(new Response("{}"));
              },
            }),
        },
        CHATGPT_PLAN: {
          getByName: () => ({
            status: async () => ({ connected }),
            infer,
            cancel: async () => {},
          }),
        },
      }),
    );
    return { runs, infer };
  }

  // Selected before the request leaves, so a failure that never produces an
  // HTTP response keeps its ChatGPT attribution — and a connected plan's
  // failure is the caller's failure, never a paid API retry.
  it("reports chatgpt before a connected plan's failed inference, without falling back", async () => {
    const { runs, infer } = bindingWithPlan(true);
    const transports: string[] = [];

    await expect(
      gatewayFetch("openai", {
        metadata,
        onTransport: (transport) => transports.push(transport),
      })(`${gatewayBaseURL("openai")}/responses`, {
        method: "POST",
        body: JSON.stringify({ model: "gpt-6-sol", input: [] }),
      }),
    ).rejects.toThrow(/connection reset/);

    expect(infer).toHaveBeenCalledOnce();
    expect(transports).toEqual(["chatgpt"]);
    expect(runs).toHaveLength(0);
  });

  it("reports gateway when no plan is connected", async () => {
    const { runs, infer } = bindingWithPlan(false);
    const transports: string[] = [];

    await gatewayFetch("openai", {
      metadata,
      onTransport: (transport) => transports.push(transport),
    })(`${gatewayBaseURL("openai")}/responses`, {
      method: "POST",
      body: JSON.stringify({ model: "gpt-6-sol", input: [] }),
    });

    expect(infer).not.toHaveBeenCalled();
    expect(transports).toEqual(["gateway"]);
    expect(runs).toHaveLength(1);
  });
});

// Failure modes: production traffic labelled `ci` because the deploy build ran
// on a CI runner; harness traffic labelled `production`; a run, batch, chunk,
// or entity id reaching the gateway (a spend-limit bucket per value, and past
// five keys the gateway silently drops entries) instead of failing loudly.
describe("gatewayFetch metadata contract", () => {
  async function freshBinding(vars: Record<string, string>) {
    for (const [key, value] of Object.entries(vars)) vi.stubEnv(key, value);
    vi.resetModules();
    const cfEnv = await import("~/server/cf-env");
    const calls: GatewayRun[] = [];
    cfEnv.setCfEnv(
      fromPartial<Env>({
        AI: {
          gateway: () =>
            fromPartial<AiGatewayBinding>({
              run: (...args: GatewayRun) => {
                calls.push(args);
                return Promise.resolve(new Response("{}"));
              },
            }),
        },
      }),
    );
    const { gatewayFetch: send } = await import("./ai-gateway");
    await send("openai", { metadata })(
      `${gatewayBaseURL("openai")}/responses`,
      {
        method: "POST",
        body: "{}",
      },
    );
    return calls[0]?.[1]?.gateway?.metadata;
  }

  it("labels the deployed Worker production even when its build ran in CI", async () => {
    expect(
      await freshBinding({
        NODE_ENV: "production",
        E2E_AUTH_TEST_MODE: "false",
        CI: "true",
      }),
    ).toEqual({ ...metadata, environment: "production" });
  });

  it("labels harness and test traffic ci on a CI runner and development elsewhere", async () => {
    expect(await freshBinding({ NODE_ENV: "test", CI: "true" })).toMatchObject({
      environment: "ci",
    });
    expect(
      await freshBinding({
        NODE_ENV: "production",
        E2E_AUTH_TEST_MODE: "true",
        CI: "",
      }),
    ).toMatchObject({ environment: "development" });
    expect(await freshBinding({ NODE_ENV: "development" })).toMatchObject({
      environment: "development",
    });
  });

  it("rejects diagnostic metadata instead of truncating or forwarding it", () => {
    fakeBinding(new Response("{}"));
    for (const extra of [
      { entityId: "synthetic-entity" },
      { runId: "synthetic-run" },
      { chunk: "k001", batchId: "synthetic-batch" },
      { environment: "production" },
    ])
      expect(() =>
        gatewayFetch("openai", {
          // SAFETY: deliberately outside the declared contract.
          metadata: { ...metadata, ...extra } as typeof metadata,
        }),
      ).toThrow(/Unrecognized key/);
  });

  it("keeps an optional entityKind", async () => {
    const calls = fakeBinding(new Response("{}"));
    await gatewayFetch("openai", {
      metadata: { ...metadata, entityKind: "location" },
    })(`${gatewayBaseURL("openai")}/responses`, { method: "POST", body: "{}" });
    expect(calls[0]?.[1]?.gateway?.metadata).toEqual({
      ...outbound,
      entityKind: "location",
    });
  });
});

// Regression: Universal `gateway.run({provider: "workers-ai"})` forwarded the
// model call unscoped, so the account's `default` gateway logged (and
// recreated itself for) every Jev decision a second time with no metadata.
// `AI.run` with `gateway.id` posts to the binding's `/ai-gateway/run`
// (workerd `ai-api.ts`), and REST names the gateway in `cf-aig-gateway-id`
// (https://developers.cloudflare.com/ai-gateway/usage/rest-api/).
describe("gatewayFetch Workers AI", () => {
  const jevInput = { choices: ["red", "blue"], prompt: "synthetic" };

  it("runs the model natively on the binding, scoped to the cubby gateway", async () => {
    const universal = vi.fn();
    const runs: unknown[][] = [];
    const answer = new Response('{"result":{}}');
    setCfEnv(
      fromPartial<Env>({
        AI: {
          gateway: () => fromPartial<AiGatewayBinding>({ run: universal }),
          run: (...args: unknown[]) => {
            runs.push(args);
            return Promise.resolve(answer);
          },
        },
      }),
    );
    const controller = new AbortController();

    const response = await gatewayFetch("workers-ai", {
      metadata,
      cacheTtlSeconds: 604_800,
      requestTimeoutMs: 30_000,
    })(`${gatewayBaseURL("workers-ai")}/run/typesafe/jev`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(jevInput),
      signal: controller.signal,
    });

    expect(response).toBe(answer);
    expect(universal).not.toHaveBeenCalled();
    expect(runs).toEqual([
      [
        "typesafe/jev",
        jevInput,
        {
          gateway: {
            id: "cubby",
            metadata: outbound,
            skipCache: undefined,
            cacheTtl: 604_800,
            requestTimeoutMs: 30_000,
          },
          returnRawResponse: true,
          signal: controller.signal,
        },
      ],
    ]);
  });

  it("names the cubby gateway in the REST run body", async () => {
    const devFetch = await devGatewayFetch("dev-token");
    const sent: { url: string; init: RequestInit | undefined }[] = [];
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
      sent.push({ url: String(url), init });
      return Promise.resolve(new Response("{}"));
    });

    await devFetch("workers-ai", { metadata, skipCache: true })(
      `${gatewayBaseURL("workers-ai")}/run/typesafe/jev`,
      { method: "POST", body: JSON.stringify(jevInput) },
    );

    const [call] = sent;
    expect(call?.url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/9f10f078d35d86c78dedece2300a6b88/ai/run",
    );
    const headers = new Headers(call?.init?.headers);
    expect(headers.get("authorization")).toBe("Bearer dev-token");
    expect(JSON.parse(String(call?.init?.body))).toEqual({
      model: "typesafe/jev",
      input: jevInput,
      options: {
        gateway: { id: "cubby", metadata: outbound, skipCache: true },
      },
    });
  });
});
