import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { liveReplayBudget } from "./live-replay-budget";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import liveGateway from "./live-gateway";

// Failure modes: the agent keeps its pinned model; the swap drops other
// request or reasoning settings; the web peer (no swap configured) or a
// non-Responses route is rewritten; the usage report cannot show which wire
// model actually answered; the caller's feature and operation are replaced,
// or its diagnostics or claimed environment reach the gateway; a Workers AI
// call takes the provider route that duplicates it into `default`.
const env = {
  ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
  GATEWAY_TOKEN: "synthetic-token",
  GATEWAY_ENVIRONMENT: "ci" as const,
};
const GATEWAY_BASE_URL = `https://gateway.ai.cloudflare.com/v1/${env.ACCOUNT_ID}/cubby`;
const agentEnv = {
  ...env,
  RESPONSES_MODEL: "gpt-6-luna",
  RESPONSES_EFFORT: "high",
};
const responsesBody = {
  model: "gpt-6-sol",
  input: [{ role: "user", content: "synthetic" }],
  reasoning: { effort: "medium", summary: "auto" },
  stream: true,
};

const upstream = vi.fn<typeof fetch>();
beforeEach(async () => {
  await liveGateway.fetch(new Request("https://model.test/reset"), env);
});

const actualFetch = globalThis.fetch;
const books: {
  book: Awaited<ReturnType<typeof liveReplayBudget>>;
  directory: string;
}[] = [];
type Receipt = {
  gatewayLogId: string;
  model: string;
  status: string;
  standardCost: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
};
async function guardedPeer() {
  const directory = await mkdtemp(join(tmpdir(), "synthetic-replay-"));
  const ledger = join(directory, "ledger.json");
  const catalog = join(directory, "catalog.json");
  // Synthetic prices yield a $0.60 full-window reservation, not live rates.
  await writeFile(
    catalog,
    JSON.stringify({
      openai: {
        id: "openai",
        env: [],
        npm: "",
        name: "Synthetic OpenAI",
        doc: "",
        models: {
          "gpt-6-luna": {
            id: "gpt-6-luna",
            name: "Synthetic Luna",
            description: "",
            attachment: false,
            reasoning: false,
            tool_call: true,
            release_date: "2026-01",
            last_updated: "2026-01",
            modalities: { input: ["text"], output: ["text"] },
            open_weights: false,
            limit: { context: 1_000_000, output: 100_000 },
            cost: { input: 0.5, output: 1, cache_read: 0.05, cache_write: 0.5 },
          },
        },
      },
    }),
  );
  await writeFile(
    ledger,
    JSON.stringify({
      limitUsd: 1,
      accountedUsd: 0,
      outstandingUsd: 0,
      stopped: false,
    }),
  );
  vi.stubEnv("MAIL_REPLAY_BUDGET_FILE", ledger);
  vi.stubEnv("MAIL_REPLAY_PRICING_FILE", catalog);
  const book = await liveReplayBudget({ receiptWaitMs: 20 });
  books.push({ book, directory });
  let rows: Receipt[] = [];
  let afterRead: (() => void) | undefined;
  const read = async () => {
    const snapshot = [...rows];
    const effect = afterRead;
    afterRead = undefined;
    effect?.();
    return snapshot;
  };
  const vars = book.begin(read);
  vi.stubGlobal("fetch", upstream);
  upstream.mockImplementation(async (url, init) =>
    String(url).startsWith("http://127.0.0.1:")
      ? actualFetch(url, init)
      : new Response("synthetic stream"),
  );
  const gatewayEnv = { ...env, ...vars.agent };
  const send = () =>
    liveGateway.fetch(
      new Request("https://model.test/openai/responses", {
        method: "POST",
        headers: {
          "cf-aig-byok-alias": "subscriber-credit",
          "cf-aig-no-wholesale": "true",
        },
        body: JSON.stringify({ model: "gpt-6-luna" }),
      }),
      gatewayEnv,
    );
  const record = (
    response: Response,
    status = "succeeded",
    override: Partial<Receipt> = {},
  ) => {
    const id = response.headers.get("cf-aig-log-id");
    if (!id) throw new Error("Synthetic physical receipt missing");
    rows.push({
      gatewayLogId: id,
      model: "gpt-6-luna",
      status,
      standardCost: status === "succeeded" ? 0.01 : null,
      inputTokens: status === "succeeded" ? 1 : null,
      outputTokens: status === "succeeded" ? 1 : null,
      cacheReadTokens: status === "succeeded" ? 0 : null,
      cacheWriteTokens: status === "succeeded" ? 0 : null,
      ...override,
    });
  };
  return {
    book,
    gatewayEnv,
    send,
    record,
    recordOnNextRead: (response: Response, status: string) => {
      afterRead = () => record(response, status);
    },
    ledger: async () => JSON.parse(await readFile(ledger, "utf8")),
    nextCase: () => {
      rows = [];
      return book.begin(read);
    },
  };
}

// The actual host admission server owns concurrency, receipt reconciliation
// and cumulative accounting; only the external provider is replaced here.
it("shares reservations across peers and cases and releases only matched stored receipts", async () => {
  const peer = await guardedPeer();
  const responses = await Promise.all([peer.send(), peer.send()]);
  expect(responses.map((response) => response.status).sort()).toEqual([
    200, 429,
  ]);
  const first = responses.find((response) => response.status === 200);
  if (!first) throw new Error("First physical call was not admitted");
  peer.record(first);
  const second = await peer.send();
  expect(second.status).toBe(200);
  peer.recordOnNextRead(second, "succeeded");
  await peer.book.finish();
  expect(await peer.ledger()).toMatchObject({
    accountedUsd: 0.02,
    outstandingUsd: 0,
    stopped: false,
    reservations: [],
  });
  // Finalization closes physical admission until the next case is bound.
  expect((await peer.send()).status).toBe(403);
  peer.nextCase();
  const third = await peer.send();
  peer.record(third);
  await peer.book.finish();
  expect(await peer.ledger()).toMatchObject({
    accountedUsd: 0.03,
    outstandingUsd: 0,
  });
  expect(
    (
      await liveGateway.fetch(
        new Request("https://model.test/reset"),
        peer.gatewayEnv,
      )
    ).status,
  ).toBe(409);
});

it("never transmits paid frontier calls under the replay guard", async () => {
  vi.stubGlobal("fetch", upstream);
  const response = await liveGateway.fetch(
    new Request("https://model.test/openai/responses", {
      method: "POST",
      headers: { "x-cubby-inference-funding": "paid" },
      body: JSON.stringify({ model: "gpt-6-luna" }),
    }),
    { ...env, EVAL_BUDGET_URL: "http://127.0.0.1:9/synthetic" },
  );
  expect(response.status).toBe(403);
  expect(upstream).not.toHaveBeenCalled();
});

it("releases a fully read credit refusal only after its exact failed no-usage receipt", async () => {
  const peer = await guardedPeer();
  let refused = true;
  upstream.mockImplementation(async (url, init) =>
    String(url).startsWith("http://127.0.0.1:")
      ? actualFetch(url, init)
      : refused
        ? Response.json(
            { error: { code: "insufficient_quota" } },
            { status: 400 },
          )
        : new Response("synthetic stream"),
  );
  const response = await peer.send();
  expect(response.status).toBe(400);
  expect(await peer.ledger()).toMatchObject({
    outstandingUsd: 0.6,
    stopped: false,
    reservations: [
      {
        id: response.headers.get("cf-aig-log-id"),
        model: "gpt-6-luna",
        maxCostUsd: 0.6,
        refused: true,
      },
    ],
  });
  // The funding fallback arrives before asynchronous telemetry is visible.
  peer.recordOnNextRead(response, "failed");
  refused = false;
  const recovered = await peer.send();
  expect(recovered.status).toBe(200);
  peer.record(recovered);
  await peer.book.finish();
  expect(await peer.ledger()).toMatchObject({
    accountedUsd: 0.01,
    outstandingUsd: 0,
    stopped: false,
  });
});

it.each([null, Number.NaN])(
  "stops on an unpriced physical receipt (%s)",
  async (standardCost) => {
    const peer = await guardedPeer();
    const response = await peer.send();
    peer.record(response, "succeeded", { standardCost });
    expect((await peer.send()).status).toBe(403);
    expect(await peer.ledger()).toMatchObject({
      accountedUsd: 0,
      outstandingUsd: 0.6,
      stopped: true,
    });
    await expect(peer.book.finish()).rejects.toThrow("Unpriced or ambiguous");
  },
);

it("does not release a physical reservation for an unrelated application-cache row", async () => {
  const peer = await guardedPeer();
  const response = await peer.send();
  peer.record(response, "succeeded", {
    gatewayLogId: "synthetic-cached-result",
    standardCost: 0,
  });
  expect((await peer.send()).status).toBe(429);
  await expect(peer.book.finish()).rejects.toThrow(
    "Missing physical-call receipts",
  );
  expect(await peer.ledger()).toMatchObject({
    accountedUsd: 0,
    outstandingUsd: 0.6,
    stopped: true,
  });
});

it.each(["transport", "http500"])(
  "retains unknown %s reservations and refuses another transmission",
  async (failure) => {
    const peer = await guardedPeer();
    upstream.mockImplementation(async (url, init) => {
      if (String(url).startsWith("http://127.0.0.1:"))
        return actualFetch(url, init);
      if (failure === "http500")
        return new Response("synthetic upstream error", { status: 500 });
      throw new Error("synthetic disconnected stream");
    });
    const result = await peer.send().then(
      (response) => response.status,
      (error: unknown) =>
        error instanceof Error ? error.message : "unknown failure",
    );
    expect(result).toBe(
      failure === "transport" ? "synthetic disconnected stream" : 500,
    );
    expect((await peer.send()).status).toBe(403);
    expect(() => peer.book.assertActive()).toThrow("Replay allowance stopped");
    expect(await peer.ledger()).toMatchObject({
      accountedUsd: 0,
      outstandingUsd: 0.6,
      stopped: true,
    });
    await expect(peer.book.finish()).rejects.toThrow(
      "Missing physical-call receipts",
    );
  },
);

// The live peer has no connected ChatGPT session; a subscription-only attempt
// must refuse explicitly rather than silently purchase OpenAI inference.
it("refuses unavailable subscription attempts without a paid transmission", async () => {
  vi.stubGlobal("fetch", upstream);
  const response = await liveGateway.fetch(
    new Request("https://ai-gateway.invalid/openai/responses", {
      method: "POST",
      headers: {
        "x-cubby-inference-funding": "subscription",
        "content-type": "application/json",
      },
      body: JSON.stringify(responsesBody),
    }),
    env,
  );
  expect(response.status).toBe(429);
  expect(await response.json()).toMatchObject({
    error: { code: "subscription_unavailable" },
  });
  expect(upstream).not.toHaveBeenCalled();
});
afterEach(async () => {
  for (const { book, directory } of books.splice(0)) {
    await book.close();
    await rm(directory, { recursive: true, force: true });
  }
  vi.unstubAllEnvs();
  upstream.mockReset();
  vi.unstubAllGlobals();
});

// Hosted Worker catalog reads timed out before paid admission. Preserve the
// fresh host-fetched response, including billing bounds, without a second read.
it("serves the live catalog snapshot without outbound inference or another catalog read", async () => {
  const catalog = JSON.stringify({
    openai: {
      models: {
        "gpt-6-luna": {
          cost: { input: 1, output: 2 },
          limit: { context: 10_000, input: 9_000, output: 1_000 },
        },
      },
    },
  });
  const gatewayEnv = { ...env, PRICING_CATALOG: catalog };
  vi.stubGlobal("fetch", upstream);
  upstream.mockRejectedValue(new Error("Worker catalog transport timed out"));
  const response = await liveGateway.fetch(
    new Request("https://models.dev/api.json?type=all"),
    gatewayEnv,
  );
  expect(response.status).toBe(200);
  expect(await response.text()).toBe(catalog);
  expect(upstream).not.toHaveBeenCalled();
});

async function send(
  gatewayEnv: Parameters<typeof liveGateway.fetch>[1],
  pathname: string,
  body: string,
  contentType = "application/json",
  metadata?: string,
): Promise<{ url: string; body: string; headers: Headers }> {
  vi.stubGlobal("fetch", upstream);
  upstream.mockResolvedValue(new Response("ok"));
  await liveGateway.fetch(
    new Request("https://live-gateway.test/reset"),
    gatewayEnv,
  );
  await liveGateway.fetch(
    new Request(`https://ai-gateway.invalid${pathname}`, {
      method: "POST",
      headers: {
        "content-type": contentType,
        ...(metadata && { "cf-aig-metadata": metadata }),
      },
      body,
    }),
    gatewayEnv,
  );
  const [url, init] = upstream.mock.lastCall ?? [];
  return {
    url: String(url),
    body: await new Response(init?.body).text(),
    headers: new Headers(init?.headers),
  };
}

async function usage(gatewayEnv: Parameters<typeof liveGateway.fetch>[1]) {
  return (
    await liveGateway.fetch(
      new Request("https://live-gateway.test/usage"),
      gatewayEnv,
    )
  ).json();
}

it("swaps the configured model and effort into Responses calls", async () => {
  const swapped = {
    ...responsesBody,
    model: "gpt-6-luna",
    reasoning: { effort: "high", summary: "auto" },
  };
  const sent = await send(
    agentEnv,
    "/openai/responses",
    JSON.stringify(responsesBody),
  );
  expect(sent.url).toBe(`${GATEWAY_BASE_URL}/openai/responses`);
  expect(JSON.parse(sent.body)).toEqual(swapped);
  expect(await usage(agentEnv)).toMatchObject({
    openai: { requests: 1, models: { "gpt-6-luna": 1 } },
  });
  // Media types are case-insensitive; the swap must not depend on them.
  const mixedCase = await send(
    agentEnv,
    "/openai/responses",
    JSON.stringify(responsesBody),
    "Application/JSON; charset=utf-8",
  );
  expect(JSON.parse(mixedCase.body)).toEqual(swapped);
});

it("refuses a swap the Responses protocol cannot carry", async () => {
  // The peer rewrites only OpenAI Responses bodies; an Anthropic model there
  // would be sent upstream on the wrong protocol.
  await expect(
    send(
      { ...agentEnv, RESPONSES_MODEL: "claude-haiku-4-5" },
      "/openai/responses",
      JSON.stringify(responsesBody),
    ),
  ).rejects.toThrow(/OpenAI Responses/u);
  expect(upstream).not.toHaveBeenCalled();
});

it("strips SDK credentials before the gateway authorizes the call", async () => {
  vi.stubGlobal("fetch", upstream);
  upstream.mockResolvedValue(new Response("ok"));
  await liveGateway.fetch(
    new Request("https://ai-gateway.invalid/openai/responses", {
      method: "POST",
      headers: {
        authorization: "Bearer sdk-placeholder",
        "x-api-key": "sdk-placeholder",
      },
      body: JSON.stringify(responsesBody),
    }),
    env,
  );
  const headers = new Headers(upstream.mock.lastCall?.[1]?.headers);
  expect(headers.get("authorization")).toBeNull();
  expect(headers.get("x-api-key")).toBeNull();
  expect(headers.get("cf-aig-authorization")).toBe("Bearer synthetic-token");
});

it("forwards unconfigured peers and other routes unchanged", async () => {
  const unchanged = JSON.stringify(responsesBody);
  expect((await send(env, "/openai/responses", unchanged)).body).toBe(
    unchanged,
  );
  expect(await usage(env)).toMatchObject({
    openai: { models: { "gpt-6-sol": 1 } },
  });
  const messages = JSON.stringify({
    model: "synthetic-messages-model",
    max_tokens: 16,
  });
  expect((await send(agentEnv, "/anthropic/v1/messages", messages)).body).toBe(
    messages,
  );
  // Model counting is telemetry: a body it cannot read is still forwarded.
  expect((await send(env, "/openai/responses", "{not json")).body).toBe(
    "{not json",
  );
  expect(await usage(env)).toMatchObject({
    openai: { requests: 1, models: {} },
  });
});

it("keeps the caller's labels under the launcher's environment", async () => {
  const sent = await send(
    env,
    "/anthropic/v1/messages",
    "{}",
    "application/json",
    JSON.stringify({
      environment: "production",
      feature: "field-suggestion",
      operation: "suggest",
      entityKind: "product",
      entityId: "synthetic-entity",
      runId: "synthetic-run",
    }),
  );
  expect(JSON.parse(sent.headers.get("cf-aig-metadata") ?? "{}")).toEqual({
    environment: "ci",
    feature: "field-suggestion",
    operation: "suggest",
    entityKind: "product",
  });
  const unlabelled = await send(env, "/anthropic/v1/messages", "{}");
  expect(JSON.parse(unlabelled.headers.get("cf-aig-metadata") ?? "{}")).toEqual(
    { environment: "ci", feature: "live-evaluation", operation: "proxy" },
  );
});

it("runs Workers AI through the account run route, scoped to evaluation", async () => {
  const input = { state: "synthetic", questions: {} };
  const sent = await send(
    env,
    "/workers-ai/run/typesafe/jev",
    JSON.stringify(input),
    "application/json",
    JSON.stringify({ feature: "field-suggestion", operation: "decide" }),
  );
  expect(sent.url).toBe(
    `https://api.cloudflare.com/client/v4/accounts/${env.ACCOUNT_ID}/ai/run`,
  );
  expect(sent.headers.get("authorization")).toBe("Bearer synthetic-token");
  expect(sent.headers.get("cf-aig-gateway-id")).toBe("cubby");
  expect(sent.headers.get("cf-aig-skip-cache")).toBe("true");
  expect(JSON.parse(sent.headers.get("cf-aig-metadata") ?? "{}")).toEqual({
    environment: "ci",
    feature: "field-suggestion",
    operation: "decide",
  });
  expect(JSON.parse(sent.body)).toEqual({
    model: "typesafe/jev",
    input,
  });

  upstream.mockClear();
  const response = await liveGateway.fetch(
    new Request("https://ai-gateway.invalid/workers-ai/run/typesafe/jev", {
      method: "POST",
      body: "{not json",
    }),
    env,
  );
  expect(response.status).toBe(400);
  expect(upstream).not.toHaveBeenCalled();
});
