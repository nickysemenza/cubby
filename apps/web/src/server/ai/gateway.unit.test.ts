import { gatewayBaseURL } from "@cubby/shared/ai/gateway-request";
import { fromPartial } from "@total-typescript/shoehorn";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { getAiGateway } from "~/server/cf-env";

let gatewayFetch: typeof import("./gateway").gatewayFetch;
let setCfEnv: typeof import("~/server/cf-env").setCfEnv;

type AiGatewayBinding = NonNullable<ReturnType<typeof getAiGateway>>;

// Vitest runs with NODE_ENV=test; a CI runner's own `CI` would otherwise
// change the expected `environment` between a laptop and GitHub.
beforeEach(async () => {
  vi.stubEnv("CI", "");
  vi.stubEnv("AI_GATEWAY_API_KEY", "synthetic-gateway-token");
  // Setup may have loaded the environment before this file supplied its token.
  vi.resetModules();
  ({ setCfEnv } = await import("~/server/cf-env"));
  ({ gatewayFetch } = await import("./gateway"));
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
  return (await import("./gateway")).gatewayFetch;
}

/** The physical provider request is the external seam in either runtime. */
function physicalRequests(response: Response) {
  const calls: Request[] = [];
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(new Request(input, init));
    return Promise.resolve(response);
  });
  return calls;
}

const metadata = { feature: "recipe-flow", operation: "generate" };
/** What leaves the Worker: the caller's labels plus the derived environment. */
const outbound = { ...metadata, environment: "development" };

describe("gatewayFetch provider transport", () => {
  it("addresses the gateway by provider and endpoint, without the SDK's credentials", async () => {
    const calls = physicalRequests(new Response("{}"));
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

    const sent = calls[0];
    expect(sent?.url).toMatch(/\/ai\/v1\/messages\?beta=true$/);
    expect(sent?.headers.get("anthropic-version")).toBe("2023-06-01");
    for (const name of ["cf-aig-authorization", "x-api-key", "content-length"])
      expect(sent?.headers.has(name)).toBe(false);
    expect(sent?.headers.get("authorization")).toBe(
      "Bearer synthetic-gateway-token",
    );
    expect(sent?.headers.get("cf-aig-gateway-id")).toBe("cubby");
    expect(sent?.headers.get("cf-aig-skip-cache")).toBe("true");
    expect(JSON.parse(sent?.headers.get("cf-aig-metadata") ?? "{}")).toEqual(
      outbound,
    );
    expect(await sent?.json()).toEqual({ model: "anthropic/claude-sonnet-5" });
    controller.abort();
    expect(sent?.signal.aborted).toBe(true);
  });

  it("rejects a cacheTtlSeconds outside the gateway's 60s..30d range", async () => {
    physicalRequests(new Response("{}"));

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
    physicalRequests(new Response("{}"));

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
    physicalRequests(streamed);

    const response = await gatewayFetch("openai", { metadata })(
      `${gatewayBaseURL("openai")}/responses`,
      { method: "POST", body: JSON.stringify({ model: "gpt-6-sol" }) },
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
    physicalRequests(failure);
    const observed: unknown[] = [];
    const response = await gatewayFetch("openai", {
      metadata,
      onErrorResponse: (details) => observed.push(details),
    })(`${gatewayBaseURL("openai")}/responses`, {
      method: "POST",
      body: JSON.stringify({ model: "gpt-6-sol" }),
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

  it("requires native authentication even when a Universal binding is present", async () => {
    const send = await devGatewayFetch("");
    const current = await import("~/server/cf-env");
    const universal = vi.fn();
    current.setCfEnv(
      fromPartial<Env>({
        AI: {
          gateway: () => fromPartial<AiGatewayBinding>({ run: universal }),
        },
      }),
    );

    await expect(
      send("compat", { metadata })(
        `${gatewayBaseURL("compat")}/chat/completions`,
        { method: "POST", body: "{}" },
      ),
    ).rejects.toThrow("AI_GATEWAY_API_KEY is not configured");
    expect(universal).not.toHaveBeenCalled();
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
        { method: "POST", body: JSON.stringify({ model: "claude-sonnet-5" }) },
      ),
    ).rejects.toThrow("AI_GATEWAY_API_KEY is not configured");
  });
});

describe("gatewayFetch transport selection", () => {
  // Disconnected subscription research must stop before API billing, and a
  // refused metered reservation must stop the physical gateway request.
  it("refuses paid transmission before invoking the native gateway", async () => {
    const runs = physicalRequests(new Response("{}"));
    const beforePaidRequest = vi.fn(async () => {
      throw new Error("Metered research allowance exhausted");
    });
    const options = { metadata, beforePaidRequest };

    await expect(
      gatewayFetch("anthropic", options)(
        `${gatewayBaseURL("anthropic")}/v1/messages`,
        { method: "POST", body: JSON.stringify({ model: "claude-sonnet-5" }) },
      ),
    ).rejects.toThrow(/allowance exhausted/);

    expect(beforePaidRequest).toHaveBeenCalledOnce();
    expect(runs).toHaveLength(0);
  });

  it("requires the connected subscription instead of falling back to paid API", async () => {
    const { runs, infer } = bindingWithPlan(false);
    const options = { metadata, subscriptionRequired: true };

    await expect(
      gatewayFetch("openai", options)(`${gatewayBaseURL("openai")}/responses`, {
        method: "POST",
        body: JSON.stringify({ model: "gpt-6-sol", input: [] }),
      }),
    ).rejects.toThrow(/Required ChatGPT subscription/);

    expect(infer).not.toHaveBeenCalled();
    expect(runs).toHaveLength(0);
  });

  /** A native gateway plus a household ChatGPT plan whose inference fails. */
  function bindingWithPlan(connected: boolean) {
    const runs = physicalRequests(new Response("{}"));
    const infer = vi.fn(async () => {
      throw new Error("ChatGPT plan connection reset");
    });
    setCfEnv(
      fromPartial<Env>({
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
  async function freshGateway(vars: Record<string, string>) {
    for (const [key, value] of Object.entries(vars)) vi.stubEnv(key, value);
    vi.resetModules();
    const calls = physicalRequests(new Response("{}"));
    const { gatewayFetch: send } = await import("./gateway");
    await send("openai", { metadata })(
      `${gatewayBaseURL("openai")}/responses`,
      {
        method: "POST",
        body: JSON.stringify({ model: "gpt-6-sol" }),
      },
    );
    return JSON.parse(calls[0]?.headers.get("cf-aig-metadata") ?? "{}");
  }

  it("labels the deployed Worker production even when its build ran in CI", async () => {
    expect(
      await freshGateway({
        NODE_ENV: "production",
        E2E_AUTH_TEST_MODE: "false",
        CI: "true",
      }),
    ).toEqual({ ...metadata, environment: "production" });
  });

  it("labels harness and test traffic ci on a CI runner and development elsewhere", async () => {
    expect(await freshGateway({ NODE_ENV: "test", CI: "true" })).toMatchObject({
      environment: "ci",
    });
    expect(
      await freshGateway({
        NODE_ENV: "production",
        E2E_AUTH_TEST_MODE: "true",
        CI: "",
      }),
    ).toMatchObject({ environment: "development" });
    expect(await freshGateway({ NODE_ENV: "development" })).toMatchObject({
      environment: "development",
    });
  });

  it("rejects diagnostic metadata instead of truncating or forwarding it", () => {
    physicalRequests(new Response("{}"));
    for (const extra of [
      { entityId: "synthetic-entity" },
      { runId: "synthetic-run" },
      { chunk: "k001", batchId: "synthetic-batch" },
      { environment: "production" },
    ])
      expect(() =>
        gatewayFetch("openai", {
          metadata: { ...metadata, ...extra } as typeof metadata,
        }),
      ).toThrow(/Unrecognized key/);
  });

  it("keeps an optional entityKind", async () => {
    const calls = physicalRequests(new Response("{}"));
    await gatewayFetch("openai", {
      metadata: { ...metadata, entityKind: "location" },
    })(`${gatewayBaseURL("openai")}/responses`, {
      method: "POST",
      body: JSON.stringify({ model: "gpt-6-sol" }),
    });
    expect(
      JSON.parse(calls[0]?.headers.get("cf-aig-metadata") ?? "{}"),
    ).toEqual({
      ...outbound,
      entityKind: "location",
    });
  });
});

// Regression: Universal `gateway.run({provider: "workers-ai"})` forwarded the
// model call unscoped, so the account's `default` gateway logged (and
// recreated itself for) every decision decision a second time with no metadata.
// `AI.run` with `gateway.id` posts to the binding's `/ai-gateway/run`
// (workerd `ai-api.ts`), and REST names the gateway in `cf-aig-gateway-id`
// (https://developers.cloudflare.com/ai-gateway/usage/rest-api/).
describe("gatewayFetch Workers AI", () => {
  const decisionInput = { choices: ["red", "blue"], prompt: "synthetic" };

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
    })(`${gatewayBaseURL("workers-ai")}/run/@cf/cloudflare/clef`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(decisionInput),
      signal: controller.signal,
    });

    expect(response).toBe(answer);
    expect(universal).not.toHaveBeenCalled();
    expect(runs).toEqual([
      [
        "@cf/cloudflare/clef",
        decisionInput,
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

  it("sends REST gateway routing and controls as headers", async () => {
    const devFetch = await devGatewayFetch("dev-token");
    const sent: { url: string; init: RequestInit | undefined }[] = [];
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
      sent.push({ url: String(url), init });
      return Promise.resolve(new Response("{}"));
    });

    await devFetch("workers-ai", {
      metadata,
      skipCache: true,
      cacheTtlSeconds: 600,
      requestTimeoutMs: 30000,
    })(`${gatewayBaseURL("workers-ai")}/run/@cf/cloudflare/clef`, {
      method: "POST",
      body: JSON.stringify(decisionInput),
    });

    const [call] = sent;
    expect(call?.url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/9f10f078d35d86c78dedece2300a6b88/ai/run",
    );
    const headers = new Headers(call?.init?.headers);
    expect(headers.get("authorization")).toBe("Bearer dev-token");
    expect(headers.get("cf-aig-gateway-id")).toBe("cubby");
    expect(JSON.parse(headers.get("cf-aig-metadata") ?? "{}")).toEqual(
      outbound,
    );
    expect(headers.get("cf-aig-skip-cache")).toBe("true");
    expect(headers.get("cf-aig-cache-ttl")).toBe("600");
    expect(headers.get("cf-aig-request-timeout")).toBe("30000");
    expect(JSON.parse(String(call?.init?.body))).toEqual({
      model: "@cf/cloudflare/clef",
      input: decisionInput,
    });
  });
});

// Accounting reads the gateway's log id and cache verdict from every response
// a transport received, without taking the body the provider SDK parses.
describe("gatewayFetch response observation", () => {
  const cachedAnswer = () =>
    new Response("synthetic answer", {
      headers: { "cf-aig-log-id": "example-log", "cf-aig-cache-status": "HIT" },
    });

  it("reports the native response's log id and cache verdict", async () => {
    physicalRequests(cachedAnswer());
    const observed: unknown[] = [];
    const response = await gatewayFetch("anthropic", {
      metadata,
      onResponse: (info) => observed.push(info),
    })(`${gatewayBaseURL("anthropic")}/v1/messages`, {
      method: "POST",
      body: JSON.stringify({ model: "claude-sonnet-5" }),
    });

    expect(observed).toEqual([
      { gatewayLogId: "example-log", gatewayCacheStatus: "hit" },
    ]);
    expect(await response.text()).toBe("synthetic answer");
  });

  it("reports the test peer's response first, before any binding", async () => {
    const universal = vi.fn();
    const native = physicalRequests(new Response("unexpected native request"));
    setCfEnv(
      fromPartial<Env & { CUBBY_TEST_AI_GATEWAY: { fetch: typeof fetch } }>({
        AI: {
          gateway: () => fromPartial<AiGatewayBinding>({ run: universal }),
        },
        CUBBY_TEST_AI_GATEWAY: { fetch: async () => cachedAnswer() },
      }),
    );
    const observed: unknown[] = [];
    const failures: unknown[] = [];
    await gatewayFetch("openai", {
      metadata,
      onResponse: (info) => observed.push(info),
      onErrorResponse: (failure) => failures.push(failure),
    })(`${gatewayBaseURL("openai")}/responses`, {
      method: "POST",
      body: JSON.stringify({ model: "gpt-6-sol" }),
    });

    expect(universal).not.toHaveBeenCalled();
    expect(native).toHaveLength(0);
    expect(observed).toEqual([
      { gatewayLogId: "example-log", gatewayCacheStatus: "hit" },
    ]);
    expect(failures).toEqual([]);
  });

  it("reports a failed response to both observers", async () => {
    physicalRequests(
      new Response("synthetic failure", {
        status: 500,
        headers: { "cf-aig-log-id": "example-log" },
      }),
    );
    const observed: unknown[] = [];
    const failures: unknown[] = [];
    await gatewayFetch("openai", {
      metadata,
      onResponse: (info) => observed.push(info),
      onErrorResponse: (failure) => failures.push(failure),
    })(`${gatewayBaseURL("openai")}/responses`, {
      method: "POST",
      body: JSON.stringify({ model: "gpt-6-sol" }),
    });

    expect(observed).toEqual([
      { gatewayLogId: "example-log", gatewayCacheStatus: null },
    ]);
    expect(failures).toEqual([
      expect.objectContaining({ status: 500, body: "synthetic failure" }),
    ]);
  });
});

it("preserves sanitized provider headers through shared Gateway coordination", async () => {
  const requests: unknown[] = [];
  setCfEnv(
    fromPartial<Env>({
      AI_GATEWAY_EGRESS: {
        getByName: () =>
          fromPartial<ReturnType<Env["AI_GATEWAY_EGRESS"]["getByName"]>>({
            fetch: async (request: Request) => {
              requests.push(await request.json());
              return new Response("synthetic stream");
            },
          }),
      },
    }),
  );
  const response = await gatewayFetch("anthropic", { metadata })(
    `${gatewayBaseURL("anthropic")}/v1/messages`,
    {
      method: "POST",
      headers: {
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "synthetic-beta",
        "x-api-key": "synthetic-secret",
      },
      body: JSON.stringify({ model: "claude-sonnet-5" }),
    },
  );
  expect(await response.text()).toBe("synthetic stream");
  expect(requests[0]).toMatchObject({
    provider: "anthropic",
    headers: {
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "synthetic-beta",
    },
  });
  expect(JSON.stringify(requests[0])).not.toContain("synthetic-secret");
});
