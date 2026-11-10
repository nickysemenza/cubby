import { gatewayBaseURL } from "@cubby/shared/ai/gateway-request";
import { fromPartial } from "@total-typescript/shoehorn";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { getAiGateway } from "~/server/cf-env";
import { gatewayEgressEnv } from "~/server/testing/ai-gateway-egress";

let gatewayFetch: typeof import("./gateway").gatewayFetch;
let setCfEnv: typeof import("~/server/cf-env").setCfEnv;

type AiGatewayBinding = NonNullable<ReturnType<typeof getAiGateway>>;

// Vitest runs with NODE_ENV=test; a CI runner's own `CI` would otherwise
// change the expected `environment` between a laptop and GitHub.
beforeEach(async () => {
  // Shared unit workers may have loaded the environment before these stubs.
  vi.resetModules();
  vi.stubEnv("CI", "");
  ({ setCfEnv } = await import("~/server/cf-env"));
  ({ gatewayFetch } = await import("./gateway"));
});

afterEach(() => {
  setCfEnv(undefined);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

/** The physical provider request is the external seam. */
function physicalRequests(response: Response) {
  const calls: Request[] = [];
  setCfEnv(fromPartial<Env>(gatewayEgressEnv()));
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
      body: JSON.stringify({ model: "claude-sonnet-5-5" }),
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
    expect(sent?.headers.get("cf-aig-gateway-id")).toBe("cubby-testing");
    expect(sent?.headers.get("cf-aig-skip-cache")).toBe("true");
    expect(JSON.parse(sent?.headers.get("cf-aig-metadata") ?? "{}")).toEqual(
      outbound,
    );
    expect(await sent?.json()).toEqual({
      model: "anthropic/claude-sonnet-5.5",
    });
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
      { method: "POST", body: JSON.stringify({ model: "gpt-6.1-sol" }) },
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
      body: JSON.stringify({ model: "gpt-6.1-sol" }),
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
        {
          method: "POST",
          body: JSON.stringify({ model: "claude-sonnet-5-5" }),
        },
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
        body: JSON.stringify({ model: "gpt-6.1-sol", input: [] }),
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
        ...gatewayEgressEnv(),
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
        body: JSON.stringify({ model: "gpt-6.1-sol", input: [] }),
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
      body: JSON.stringify({ model: "gpt-6.1-sol", input: [] }),
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
    // The reimported module graph has its own runtime environment.
    (await import("~/server/cf-env")).setCfEnv(
      fromPartial<Env>(gatewayEgressEnv()),
    );
    await send("openai", { metadata })(
      `${gatewayBaseURL("openai")}/responses`,
      {
        method: "POST",
        body: JSON.stringify({ model: "gpt-6.1-sol" }),
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
      body: JSON.stringify({ model: "gpt-6.1-sol" }),
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
      body: JSON.stringify({ model: "claude-sonnet-5-5" }),
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
      body: JSON.stringify({ model: "gpt-6.1-sol" }),
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
      body: JSON.stringify({ model: "gpt-6.1-sol" }),
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
      body: JSON.stringify({ model: "claude-sonnet-5-5" }),
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
