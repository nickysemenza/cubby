import { describe, expect, it, vi } from "vitest";

import {
  gatewayControlHeaders,
  gatewayProviderUrl,
  gatewayResponseInfo,
  gatewayBaseURL,
  gatewayFetchThrough,
  type GatewayFetchRoutes,
  type GatewayQuery,
} from "./gateway-request";

// Failure modes: a cached gateway answer is booked as a fresh paid call; a
// header spelling the gateway does not document becomes a verdict; reading
// the verdict consumes the body the provider SDK still has to parse.
describe("gatewayResponseInfo", () => {
  it("reads the log id and a cache verdict in any case", () => {
    expect(
      gatewayResponseInfo(
        new Response("{}", {
          headers: {
            "cf-aig-log-id": "example-log",
            "cf-aig-cache-status": "HIT",
          },
        }),
      ),
    ).toEqual({ gatewayLogId: "example-log", gatewayCacheStatus: "hit" });
    expect(
      gatewayResponseInfo(
        new Response("{}", { headers: { "cf-aig-cache-status": "miss" } }),
      ),
    ).toEqual({ gatewayLogId: null, gatewayCacheStatus: "miss" });
  });

  it("reports no verdict for a response without one or with an unknown one", () => {
    expect(gatewayResponseInfo(new Response("{}"))).toEqual({
      gatewayLogId: null,
      gatewayCacheStatus: null,
    });
    expect(
      gatewayResponseInfo(
        new Response("{}", { headers: { "cf-aig-cache-status": "BYPASS" } }),
      ).gatewayCacheStatus,
    ).toBeNull();
  });

  it("leaves the body for the provider SDK", async () => {
    const response = new Response("synthetic body", {
      headers: { "cf-aig-cache-status": "HIT" },
    });
    gatewayResponseInfo(response);
    expect(await response.text()).toBe("synthetic body");
  });
});

it("returns bounded error diagnostics without waiting for an open upstream body to end", async () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(4_096).fill(65));
    },
  });
  const observed: string[] = [];
  const response = new Response(body, { status: 502 });
  const send = gatewayFetchThrough({
    provider: "openai",
    gateway: async () => response,
    onErrorResponse: (failure) => observed.push(failure.body),
  });
  try {
    const returned = await Promise.race([
      send(`${gatewayBaseURL("openai")}/responses`, {
        method: "POST",
        body: "{}",
      }),
      new Promise<never>((_resolve, reject) =>
        setTimeout(
          () => reject(new Error("Diagnostics waited for upstream EOF")),
          250,
        ),
      ),
    ]);
    expect(returned).toBe(response);
    expect(observed).toEqual(["A".repeat(4_096)]);
  } finally {
    void response.body?.cancel();
  }
});

// A required disconnected plan must not silently spend through chat APIs;
// reservations must finish before every actual paid request, including peers
// and retries. Response/transport observers do not authorize a transmission.
describe("gateway paid-route admission", () => {
  const decisionUrl = `${gatewayBaseURL("workers-ai")}/run/typesafe/jev`;
  const decisionInit = {
    method: "POST",
    body: JSON.stringify({
      questions: [{ question: "Synthetic related mail?" }],
    }),
  };

  it.each(["gateway", "testPeer"] as const)(
    "awaits admission before transmitting the actual %s request",
    async (route) => {
      const events: string[] = [];
      let releaseAdmission: () => void = () => {};
      const admission = new Promise<void>((resolve) => {
        releaseAdmission = resolve;
      });
      const transmit = async () => {
        events.push("transmit");
        return new Response("synthetic response");
      };
      const beforePaidRequest = vi.fn(async () => {
        events.push("admission");
        await admission;
        events.push("admitted");
      });
      const send = gatewayFetchThrough({
        provider: "workers-ai",
        beforePaidRequest,
        testPeer: route === "testPeer" ? () => transmit : undefined,
        gateway: transmit,
        onTransport: () => events.push("observed transport"),
        onResponse: () => events.push("observed response"),
      });
      const pending = send(decisionUrl, decisionInit);
      try {
        await vi.waitFor(() => expect(events).toEqual(["admission"]));
      } finally {
        releaseAdmission();
        await pending;
      }
      expect(beforePaidRequest).toHaveBeenCalledOnce();
      expect(events).toEqual([
        "admission",
        "admitted",
        "observed transport",
        "transmit",
        "observed response",
      ]);
    },
  );

  it.each(["gateway", "testPeer"] as const)(
    "refuses the actual %s request without transmission when admission rejects",
    async (route) => {
      const transmit = vi.fn(async () => new Response("must not transmit"));
      const onTransport = vi.fn();
      const onResponse = vi.fn();
      const send = gatewayFetchThrough({
        provider: "workers-ai",
        beforePaidRequest: async (request) => {
          expect(request.endpoint).toBe("run/typesafe/jev");
          expect(await request.query()).toEqual({
            questions: [{ question: "Synthetic related mail?" }],
            normalized: true,
          });
          throw new Error("Synthetic reservation refused.");
        },
        rewriteQuery: (query) => ({ ...query, normalized: true }),
        testPeer: route === "testPeer" ? () => transmit : undefined,
        gateway: transmit,
        onTransport,
        onResponse,
      });
      await expect(send(decisionUrl, decisionInit)).rejects.toThrow(
        "Synthetic reservation refused.",
      );
      expect(transmit).not.toHaveBeenCalled();
      expect(onTransport).not.toHaveBeenCalled();
      expect(onResponse).not.toHaveBeenCalled();
    },
  );

  it("admits each retry separately instead of reusing the first paid reservation", async () => {
    const beforePaidRequest = vi.fn(async () => {});
    const gateway = vi.fn(async () => new Response("retry", { status: 429 }));
    const send = gatewayFetchThrough({
      provider: "workers-ai",
      beforePaidRequest,
      gateway,
    });
    await send(decisionUrl, decisionInit);
    await send(decisionUrl, decisionInit);
    expect(beforePaidRequest).toHaveBeenCalledTimes(2);
    expect(gateway).toHaveBeenCalledTimes(2);
  });
});

describe("gateway required subscription", () => {
  const url = `${gatewayBaseURL("openai")}/responses`;
  const init = {
    method: "POST",
    body: JSON.stringify({ model: "gpt-6-sol", input: [] }),
  };

  // A disconnected research plan may spend only after explicit opt-in and
  // durable admission; a rejected reservation must leave the gateway untouched.
  it("admits budgeted fallback for a disconnected required subscription", async () => {
    const events: string[] = [];
    const send = gatewayFetchThrough({
      provider: "openai",
      subscriptionRequired: true,
      subscriptionFallback: "budgeted",
      chatGpt: async () => null,
      beforePaidRequest: async () => {
        events.push("admitted");
      },
      onTransport: (transport) => events.push(transport),
      gateway: async () => {
        events.push("transmitted");
        return new Response("paid research");
      },
    });
    expect(await (await send(url, init)).text()).toBe("paid research");
    expect(events).toEqual(["admitted", "gateway", "transmitted"]);
  });

  // Only a complete HTTP quota refusal is safe to replay through a paid
  // route. Generic 429s, auth/network/abort errors and emitted streams are not.
  it("falls back on the exact subscription quota refusal and preserves raw diagnostics", async () => {
    const body = JSON.stringify({
      error: {
        code: "subscription_sharing_usage_limit_exceeded",
        message: "Synthetic Subscription Sharing usage limit.",
      },
    });
    const events: string[] = [];
    const failures: unknown[] = [];
    const gateway = vi.fn(async () => {
      events.push("transmitted");
      return new Response("paid research");
    });
    const send = gatewayFetchThrough({
      provider: "openai",
      subscriptionRequired: true,
      subscriptionFallback: "budgeted",
      chatGpt: async (_body, options) => {
        options?.onSelected?.();
        return new Response(body, {
          status: 429,
          headers: { "retry-after": "60" },
        });
      },
      beforePaidRequest: async () => {
        events.push("admitted");
      },
      onTransport: (transport) => events.push(transport),
      onErrorResponse: (failure) => failures.push(failure),
      gateway,
    });
    expect(await (await send(url, init)).text()).toBe("paid research");
    expect(events).toEqual(["chatgpt", "admitted", "gateway", "transmitted"]);
    expect(failures).toEqual([
      { status: 429, statusText: "", body, retryAfter: "60" },
    ]);
  });

  it("separates a recovered quota diagnostic before a refused paid admission", async () => {
    const diagnostic = {
      error: { code: "subscription_sharing_usage_limit_exceeded" },
    };
    const events: string[] = [];
    const routes = {
      provider: "openai",
      subscriptionRequired: true,
      subscriptionFallback: "budgeted" as const,
      chatGpt: async () => Response.json(diagnostic, { status: 429 }),
      onErrorResponse: () => events.push("quota"),
      onRecoveredErrorResponse: () => events.push("recovered"),
      beforePaidRequest: async () => {
        events.push("admission");
        throw new Error("Synthetic budget exhausted");
      },
      gateway: async () => {
        throw new Error("must not transmit");
      },
    };
    await expect(gatewayFetchThrough(routes)(url, init)).rejects.toThrow(
      "Synthetic budget exhausted",
    );
    expect(events).toEqual(["quota", "recovered", "admission"]);
  });

  it.each([16_384, 16_385])(
    "admits complete quota JSON through the 16 KiB boundary: %s bytes",
    async (bytes) => {
      const raw = JSON.stringify({
        error: { code: "subscription_sharing_usage_limit_exceeded" },
      });
      const body = raw + " ".repeat(bytes - raw.length);
      const gateway = vi.fn(async () => new Response("paid research"));
      const send = gatewayFetchThrough({
        provider: "openai",
        subscriptionRequired: true,
        subscriptionFallback: "budgeted",
        chatGpt: async () => new Response(body, { status: 429 }),
        beforePaidRequest: async () => {},
        gateway,
      });
      expect(await (await send(url, init)).text()).toBe(
        bytes === 16_384 ? "paid research" : body,
      );
      expect(gateway).toHaveBeenCalledTimes(bytes === 16_384 ? 1 : 0);
    },
  );

  it.each(["disabled", "missing-admission", "reservation-refused"] as const)(
    "does not transmit quota fallback when %s",
    async (mode) => {
      const raw = JSON.stringify({
        error: { code: "subscription_sharing_usage_limit_exceeded" },
      });
      const gateway = vi.fn(async () => new Response("must not transmit"));
      const send = gatewayFetchThrough({
        provider: "openai",
        subscriptionRequired: true,
        subscriptionFallback: mode === "disabled" ? undefined : "budgeted",
        chatGpt: async () => new Response(raw, { status: 429 }),
        beforePaidRequest:
          mode === "missing-admission"
            ? undefined
            : async () => {
                throw new Error("Synthetic durable allowance exhausted");
              },
        gateway,
      });
      const [outcome] = await Promise.allSettled([
        send(url, init).then((response) => response.text()),
      ]);
      expect(outcome).toEqual(
        mode === "reservation-refused"
          ? {
              status: "rejected",
              reason: new Error("Synthetic durable allowance exhausted"),
            }
          : { status: "fulfilled", value: raw },
      );
      expect(gateway).not.toHaveBeenCalled();
    },
  );

  it.each([
    { status: 429, body: '{"error":{"code":"rate_limit_exceeded"}}' },
    {
      status: 401,
      body: '{"error":{"code":"subscription_sharing_usage_limit_exceeded"}}',
    },
    { status: 429, body: "Subscription Sharing usage limit exceeded" },
    {
      status: 200,
      body: 'data: {"type":"response.output_text.delta","delta":"useful output"}\n\ndata: {"type":"response.failed","response":{"error":{"code":"subscription_sharing_usage_limit_exceeded"}}}\n\n',
    },
  ])(
    "preserves non-definitive refusals and partial streams ($status, $body)",
    async ({ status, body }) => {
      const gateway = vi.fn(async () => new Response("must not transmit"));
      const admission = vi.fn(async () => {});
      const response = new Response(body, { status });
      const send = gatewayFetchThrough({
        provider: "openai",
        subscriptionRequired: true,
        subscriptionFallback: "budgeted",
        chatGpt: async () => response,
        beforePaidRequest: admission,
        gateway,
      });
      expect(await send(url, init)).toBe(response);
      expect(await response.text()).toBe(body);
      expect(gateway).not.toHaveBeenCalled();
      expect(admission).not.toHaveBeenCalled();
    },
  );

  it.each([
    new Error("Synthetic network reset"),
    new DOMException("Synthetic aborted request", "AbortError"),
  ])(
    "preserves a thrown subscription failure without paid replay: %s",
    async (failure) => {
      const gateway = vi.fn(async () => new Response("must not transmit"));
      const send = gatewayFetchThrough({
        provider: "openai",
        subscriptionRequired: true,
        subscriptionFallback: "budgeted",
        chatGpt: async () => {
          throw failure;
        },
        beforePaidRequest: async () => {},
        gateway,
      });
      await expect(send(url, init)).rejects.toBe(failure);
      expect(gateway).not.toHaveBeenCalled();
    },
  );

  it("refuses disconnected fallback without admission even when subscriptionRequired is absent", async () => {
    const gateway = vi.fn(async () => new Response("must not transmit"));
    const send = gatewayFetchThrough({
      provider: "openai",
      subscriptionFallback: "budgeted",
      chatGpt: async () => null,
      gateway,
    });
    await expect(send(url, init)).rejects.toThrow(/subscription/i);
    expect(gateway).not.toHaveBeenCalled();
  });

  it("does not transmit if fallback is aborted while durable admission completes", async () => {
    const controller = new AbortController();
    const gateway = vi.fn(async () => new Response("must not transmit"));
    const send = gatewayFetchThrough({
      provider: "openai",
      subscriptionRequired: true,
      subscriptionFallback: "budgeted",
      chatGpt: async () => null,
      beforePaidRequest: async () => {
        controller.abort(new Error("Synthetic caller cancelled"));
      },
      gateway,
    });
    await expect(
      send(url, { ...init, signal: controller.signal }),
    ).rejects.toThrow("Synthetic caller cancelled");
    expect(gateway).not.toHaveBeenCalled();
  });

  it.each(["absent", "disconnected"] as const)(
    "refuses an %s required ChatGPT subscription without paid chat fallback",
    async (state) => {
      const gateway = vi.fn(async () => new Response("paid fallback"));
      const beforePaidRequest = vi.fn(async () => {});
      const send = gatewayFetchThrough({
        provider: "openai",
        subscriptionRequired: true,
        chatGpt: state === "disconnected" ? async () => null : undefined,
        beforePaidRequest,
        gateway,
      });
      await expect(send(url, init)).rejects.toThrow(/subscription/i);
      expect(gateway).not.toHaveBeenCalled();
      expect(beforePaidRequest).not.toHaveBeenCalled();
    },
  );

  it("uses the connected subscription without a paid reservation and preserves its response", async () => {
    const gateway = vi.fn(async () => new Response("paid fallback"));
    const beforePaidRequest = vi.fn(async () => {});
    const transports: string[] = [];
    const send = gatewayFetchThrough({
      provider: "openai",
      subscriptionRequired: true,
      chatGpt: async (_query, options) => {
        options?.onSelected?.();
        return new Response("subscription original");
      },
      beforePaidRequest,
      gateway,
      onTransport: (route) => transports.push(route),
    });
    expect(await (await send(url, init)).text()).toBe("subscription original");
    expect(transports).toEqual(["chatgpt"]);
    expect(gateway).not.toHaveBeenCalled();
    expect(beforePaidRequest).not.toHaveBeenCalled();
  });

  it("does not replace a selected subscription failure with a paid request", async () => {
    const gateway = vi.fn(async () => new Response("paid fallback"));
    const beforePaidRequest = vi.fn(async () => {});
    const send = gatewayFetchThrough({
      provider: "openai",
      subscriptionRequired: true,
      chatGpt: async () => {
        throw new Error("Synthetic connected-plan failure.");
      },
      beforePaidRequest,
      gateway,
    });
    await expect(send(url, init)).rejects.toThrow(
      "Synthetic connected-plan failure.",
    );
    expect(gateway).not.toHaveBeenCalled();
    expect(beforePaidRequest).not.toHaveBeenCalled();
  });
});

describe("gateway REST request shaping", () => {
  it("addresses a provider route under the account's gateway", () => {
    expect(
      gatewayProviderUrl({
        accountId: "00000000000000000000000000000000",
        gatewayId: "cubby",
        provider: "openai",
        endpoint: "responses",
      }),
    ).toBe(
      "https://gateway.ai.cloudflare.com/v1/00000000000000000000000000000000/cubby/openai/responses",
    );
  });

  it("sets only the controls a caller chose", () => {
    const metadata = {
      environment: "ci",
      feature: "synthetic",
      operation: "test",
    } as const;
    expect(gatewayControlHeaders({ metadata })).toEqual({
      "cf-aig-metadata": JSON.stringify(metadata),
    });
    expect(
      gatewayControlHeaders({
        metadata,
        skipCache: false,
        cacheTtl: 600,
        requestTimeoutMs: 30_000,
      }),
    ).toEqual({
      "cf-aig-metadata": JSON.stringify(metadata),
      "cf-aig-skip-cache": "false",
      "cf-aig-cache-ttl": "600",
      "cf-aig-request-timeout": "30000",
    });
  });
});

// SDKs can replace an HTTP 200 stream refusal with a status-less Error. Passive
// diagnostics must retain that envelope without consuming, replaying, delaying
// or changing the provider stream; incomplete/oversized frames stay unobserved.
describe("subscription stream diagnostics", () => {
  const quota = "subscription_sharing_usage_limit_exceeded";
  const headers = {
    "content-type": "text/event-stream",
    "x-request-id": "synthetic-request",
  };

  it.each([
    {
      event: "error",
      payload: { error: { code: quota, message: "Synthetic quota é" } },
    },
    {
      event: "error",
      payload: { type: "error", code: quota, message: "Synthetic quota é" },
    },
    {
      event: "response.failed",
      payload: {
        type: "response.failed",
        response: {
          error: { code: quota, message: "Synthetic quota é" },
          output: [],
        },
      },
    },
  ])(
    "retains a fragmented $event refusal and forwards its exact bytes without paid replay",
    async ({ event, payload }) => {
      const text = `event: ${event}\r\ndata: ${JSON.stringify(payload)}\r\n\r\n`;
      const bytes = new TextEncoder().encode(text);
      let offset = 0;
      const failures: Array<{ status: number; body: string }> = [];
      const gateway = vi.fn();
      const admission = vi.fn();
      const send = gatewayFetchThrough({
        provider: "openai",
        subscriptionRequired: true,
        subscriptionFallback: "budgeted",
        beforePaidRequest: admission,
        chatGpt: async (_query, options) => {
          options?.onSelected?.();
          return new Response(
            new ReadableStream({
              pull(controller) {
                if (offset === bytes.length) controller.close();
                else controller.enqueue(bytes.slice(offset, ++offset));
              },
            }),
            { headers },
          );
        },
        gateway,
        onErrorResponse: (failure) => failures.push(failure),
      });
      const response = await send(`${gatewayBaseURL("openai")}/responses`, {
        body: "{}",
        method: "POST",
      });
      expect(failures).toEqual([]);
      expect(await response.text()).toBe(text);
      expect(response.status).toBe(200);
      expect(response.headers.get("x-request-id")).toBe("synthetic-request");
      expect(failures).toHaveLength(1);
      expect(failures[0]?.status).toBe(200);
      expect(failures[0]?.body).toContain(quota);
      expect(failures[0]?.body).toContain("Synthetic quota é");
      expect(failures[0]?.body).toContain("synthetic-request");
      expect(failures[0]?.body).toContain(event);
      expect(admission).not.toHaveBeenCalled();
      expect(gateway).not.toHaveBeenCalled();
    },
  );

  it("retains preceding activity without retaining its output in diagnostics", async () => {
    const output = {
      type: "response.output_text.delta",
      delta: "Synthetic private output",
    };
    const failure = {
      type: "response.failed",
      response: { error: { code: quota }, output: [] },
    };
    const text = `data: ${JSON.stringify(output)}\n\ndata: ${JSON.stringify(failure)}\n\n`;
    const diagnostics: string[] = [];
    const send = gatewayFetchThrough({
      provider: "openai",
      chatGpt: async () => new Response(text, { headers }),
      gateway: vi.fn(),
      onErrorResponse: (f) => diagnostics.push(f.body),
    });
    const response = await send(`${gatewayBaseURL("openai")}/responses`, {
      body: "{}",
      method: "POST",
    });
    expect(await response.text()).toBe(text);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toContain("response.output_text.delta");
    expect(diagnostics[0]).not.toContain(output.delta);
  });

  it("does not pull ahead of the SDK and forwards cancellation to the original body", async () => {
    const pull = vi.fn();
    const cancel = vi.fn();
    const send = gatewayFetchThrough({
      provider: "openai",
      chatGpt: async () =>
        new Response(
          new ReadableStream({ pull, cancel }, { highWaterMark: 0 }),
          { headers },
        ),
      gateway: vi.fn(),
      onErrorResponse: vi.fn(),
    });
    const response = await send(`${gatewayBaseURL("openai")}/responses`, {
      body: "{}",
      method: "POST",
    });
    expect(pull).not.toHaveBeenCalled();
    await response.body?.cancel("synthetic cancellation");
    expect(cancel).toHaveBeenCalledWith("synthetic cancellation");
  });

  it.each([
    'event: error\ndata: {"error":',
    `event: error\ndata: ${"x".repeat(70_000)}\n\n`,
  ])("leaves incomplete or oversized envelopes untouched", async (text) => {
    const observer = vi.fn();
    const send = gatewayFetchThrough({
      provider: "openai",
      chatGpt: async () => new Response(text, { headers }),
      gateway: vi.fn(),
      onErrorResponse: observer,
    });
    const response = await send(`${gatewayBaseURL("openai")}/responses`, {
      body: "{}",
      method: "POST",
    });
    expect(await response.text()).toBe(text);
    expect(observer).not.toHaveBeenCalled();
  });
});

// Review regressions: failed-response output is not error evidence; a frame's
// diagnostic eligibility must not depend on the upstream chunk boundaries.
describe("stream diagnostic privacy and envelope bounds", () => {
  const headers = { "content-type": "text/event-stream" };
  it("retains only the provider error when the failed response embeds output", async () => {
    const error = {
      code: "synthetic_error",
      message: "Synthetic provider diagnostic",
      extra: "Original diagnostic field",
    };
    const payload = {
      type: "response.failed",
      response: {
        error,
        output: [
          {
            type: "message",
            content: [{ text: "Synthetic private failed output" }],
          },
        ],
      },
    };
    const text = `data: ${JSON.stringify(payload)}\n\n`;
    const diagnostics: string[] = [];
    const send = gatewayFetchThrough({
      provider: "openai",
      gateway: async () => new Response(text, { headers }),
      onErrorResponse: (f) => diagnostics.push(f.body),
    });
    const response = await send(`${gatewayBaseURL("openai")}/responses`, {
      body: "{}",
      method: "POST",
    });
    expect(await response.text()).toBe(text);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toContain(JSON.stringify(error));
    expect(diagnostics[0]).not.toContain("Synthetic private failed output");
  });

  it.each([1_000, 65_536])(
    "ignores the same complete oversized frame in %i-byte chunks",
    async (chunkSize) => {
      const text = `event: error\ndata: ${JSON.stringify({ code: "synthetic_error", message: "x".repeat(20_000) })}\n\n`;
      const bytes = new TextEncoder().encode(text);
      let offset = 0;
      const observer = vi.fn();
      const send = gatewayFetchThrough({
        provider: "openai",
        gateway: async () =>
          new Response(
            new ReadableStream({
              pull(controller) {
                if (offset >= bytes.length) controller.close();
                else {
                  controller.enqueue(bytes.slice(offset, offset + chunkSize));
                  offset += chunkSize;
                }
              },
            }),
            { headers },
          ),
        onErrorResponse: observer,
      });
      const response = await send(`${gatewayBaseURL("openai")}/responses`, {
        body: "{}",
        method: "POST",
      });
      expect(await response.text()).toBe(text);
      expect(observer).not.toHaveBeenCalled();
    },
  );
});

// Framing overhead and non-JSON keepalives must not change the diagnostic
// evidence when the transport delivers a different valid chunk layout.
describe("stream diagnostic framing evidence", () => {
  const headers = { "content-type": "text/event-stream" };
  it.each(["coalesced", "before-newline"])(
    "observes the same near-limit error with %s framing",
    async (layout) => {
      const base = JSON.stringify({ code: "synthetic_error", message: "" });
      const payload = JSON.stringify({
        code: "synthetic_error",
        message: "x".repeat(16_382 - base.length),
      });
      const text = `event: error\ndata: ${payload}\n\n`;
      const bytes = new TextEncoder().encode(text);
      let offset = 0;
      const firstEnd = layout === "coalesced" ? bytes.length : bytes.length - 2;
      const observer = vi.fn();
      const send = gatewayFetchThrough({
        provider: "openai",
        gateway: async () =>
          new Response(
            new ReadableStream({
              pull(controller) {
                if (offset === bytes.length) controller.close();
                else {
                  const end = offset === 0 ? firstEnd : bytes.length;
                  controller.enqueue(bytes.slice(offset, end));
                  offset = end;
                }
              },
            }),
            { headers },
          ),
        onErrorResponse: observer,
      });
      const response = await send(`${gatewayBaseURL("openai")}/responses`, {
        body: "{}",
        method: "POST",
      });
      expect(await response.text()).toBe(text);
      expect(observer).toHaveBeenCalledTimes(1);
    },
  );

  it("counts non-JSON events without retaining their data", async () => {
    const text =
      'event: ping\ndata: synthetic keepalive\n\nevent: error\ndata: {"code":"synthetic_error"}\n\n';
    const diagnostics: string[] = [];
    const send = gatewayFetchThrough({
      provider: "openai",
      gateway: async () => new Response(text, { headers }),
      onErrorResponse: (f) => diagnostics.push(f.body),
    });
    const response = await send(`${gatewayBaseURL("openai")}/responses`, {
      body: "{}",
      method: "POST",
    });
    expect(await response.text()).toBe(text);
    expect(diagnostics[0]).toContain('"priorEvents":["ping"]');
    expect(diagnostics[0]).toContain('"eventsSeen":1');
    expect(diagnostics[0]).not.toContain("synthetic keepalive");
  });
});

// SSE ignores unknown fields and invalid retry hints. Those warnings must not
// suppress a later complete provider error or alter the original stream.
it.each(["extension: synthetic", "retry: synthetic"])(
  "retains a provider error after the ignorable SSE field %s",
  async (prefix) => {
    const text = `${prefix}\nevent: error\ndata: {"code":"synthetic_error","message":"Synthetic provider diagnostic"}\n\n`;
    const observer = vi.fn();
    const send = gatewayFetchThrough({
      provider: "openai",
      gateway: async () =>
        new Response(text, {
          headers: { "content-type": "text/event-stream" },
        }),
      onErrorResponse: observer,
    });
    const response = await send(`${gatewayBaseURL("openai")}/responses`, {
      body: "{}",
      method: "POST",
    });
    expect(await response.text()).toBe(text);
    expect(observer).toHaveBeenCalledTimes(1);
  },
);

// Preserve later error evidence after large output, honor every SSE line ending,
// and keep the complete diagnostic within its byte cap without broken UTF-8.
describe("bounded stream error evidence", () => {
  const headers = { "content-type": "text/event-stream" };
  it("observes a small error after an oversized preceding output event", async () => {
    const text = `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: "x".repeat(17_000) })}\n\nevent: error\ndata: {"code":"synthetic_error"}\n\n`;
    const diagnostics: string[] = [];
    const send = gatewayFetchThrough({
      provider: "openai",
      gateway: async () => new Response(text, { headers }),
      onErrorResponse: (f) => diagnostics.push(f.body),
    });
    expect(
      await (
        await send(`${gatewayBaseURL("openai")}/responses`, {
          body: "{}",
          method: "POST",
        })
      ).text(),
    ).toBe(text);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toContain('"eventsSeen":1');
    expect(diagnostics[0]).toContain("response.output_text.delta");
    expect(diagnostics[0]).not.toContain('"delta"');
  });

  it.each([
    { chunkSize: 1, suffix: "" },
    { chunkSize: 65_536, suffix: "" },
    { chunkSize: 1, suffix: ":synthetic comment" },
    { chunkSize: 65_536, suffix: ":synthetic comment" },
  ])(
    "retains a CR-delimited complete error in $chunkSize-byte chunks ($suffix)",
    async ({ chunkSize, suffix }) => {
      const text = `event: error\rdata: {"code":"synthetic_error"}\r\r${suffix}`;
      const bytes = new TextEncoder().encode(text);
      let offset = 0;
      const observer = vi.fn();
      const send = gatewayFetchThrough({
        provider: "openai",
        gateway: async () =>
          new Response(
            new ReadableStream({
              pull(controller) {
                if (offset >= bytes.length) controller.close();
                else {
                  controller.enqueue(bytes.slice(offset, offset + chunkSize));
                  offset += chunkSize;
                }
              },
            }),
            { headers },
          ),
        onErrorResponse: observer,
      });
      expect(
        await (
          await send(`${gatewayBaseURL("openai")}/responses`, {
            body: "{}",
            method: "POST",
          })
        ).text(),
      ).toBe(text);
      expect(observer).toHaveBeenCalledTimes(1);
    },
  );

  it("does not invent a terminating blank line for an incomplete CR event", async () => {
    const text = 'event: error\rdata: {"code":"synthetic_error"}\r';
    const observer = vi.fn();
    const send = gatewayFetchThrough({
      provider: "openai",
      gateway: async () => new Response(text, { headers }),
      onErrorResponse: observer,
    });
    expect(
      await (
        await send(`${gatewayBaseURL("openai")}/responses`, {
          body: "{}",
          method: "POST",
        })
      ).text(),
    ).toBe(text);
    expect(observer).not.toHaveBeenCalled();
  });

  it.each(["x".repeat(4_200), "aaa" + "😀".repeat(1_100)])(
    "bounds the entire diagnostic without corrupting UTF-8 (%#)",
    async (message) => {
      const text = `event: error\ndata: ${JSON.stringify({ code: "synthetic_error", message })}\n\n`;
      const diagnostics: string[] = [];
      const send = gatewayFetchThrough({
        provider: "openai",
        gateway: async () => new Response(text, { headers }),
        onErrorResponse: (f) => diagnostics.push(f.body),
      });
      expect(
        await (
          await send(`${gatewayBaseURL("openai")}/responses`, {
            body: "{}",
            method: "POST",
          })
        ).text(),
      ).toBe(text);
      expect(diagnostics).toHaveLength(1);
      expect(
        new TextEncoder().encode(diagnostics[0]).byteLength,
      ).toBeLessThanOrEqual(4_096);
      expect(diagnostics[0]).not.toContain("\uFFFD");
    },
  );
});

// Regression: a provider SDK that requested `stream: true` parses SSE whatever
// the response MIME says, so a refusal streamed under a missing or wrong
// Content-Type reached the SDK as bare prose with no retained diagnostics.
describe("requested stream diagnostics", () => {
  const quota = "subscription_sharing_usage_limit_exceeded";
  const refusal = `event: error\ndata: ${JSON.stringify({ error: { code: quota, message: "Synthetic quota" } })}\n\n`;
  const streamed = JSON.stringify({ model: "synthetic", stream: true });

  function upstream(text: string, contentType: string | undefined) {
    const headers = new Headers({ "x-request-id": "synthetic-request" });
    if (contentType) headers.set("content-type", contentType);
    // A byte body sets no Content-Type of its own.
    return new Response(new TextEncoder().encode(text), { headers });
  }

  it.each([undefined, "application/json", "text/plain; charset=utf-8"])(
    "observes a subscription refusal under Content-Type %s without changing the response",
    async (contentType) => {
      const failures: Array<{ status: number; body: string }> = [];
      const gateway = vi.fn();
      const admission = vi.fn();
      const send = gatewayFetchThrough({
        provider: "openai",
        beforePaidRequest: admission,
        chatGpt: async () => upstream(refusal, contentType),
        gateway,
        onErrorResponse: (failure) => failures.push(failure),
      });
      const response = await send(`${gatewayBaseURL("openai")}/responses`, {
        body: streamed,
        method: "POST",
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(contentType ?? null);
      expect(response.headers.get("x-request-id")).toBe("synthetic-request");
      expect(await response.text()).toBe(refusal);
      expect(failures).toHaveLength(1);
      expect(failures[0]?.body).toContain(quota);
      expect(failures[0]?.body).toContain("synthetic-request");
      expect(admission).not.toHaveBeenCalled();
      expect(gateway).not.toHaveBeenCalled();
    },
  );

  it("observes a paid-route stream the SDK requested from its raw string body", async () => {
    const observer = vi.fn();
    const send = gatewayFetchThrough({
      provider: "openai",
      gateway: async () => upstream(refusal, undefined),
      onErrorResponse: observer,
    });
    const response = await send(`${gatewayBaseURL("openai")}/responses`, {
      body: streamed,
      method: "POST",
    });
    expect(await response.text()).toBe(refusal);
    expect(observer).toHaveBeenCalledTimes(1);
  });

  it("does not pull ahead of the SDK or swallow cancellation for a mislabelled requested stream", async () => {
    const pull = vi.fn();
    const cancel = vi.fn();
    const send = gatewayFetchThrough({
      provider: "openai",
      chatGpt: async () =>
        new Response(
          new ReadableStream({ pull, cancel }, { highWaterMark: 0 }),
          { headers: { "content-type": "application/json" } },
        ),
      gateway: vi.fn(),
      onErrorResponse: vi.fn(),
    });
    const response = await send(`${gatewayBaseURL("openai")}/responses`, {
      body: streamed,
      method: "POST",
    });
    expect(pull).not.toHaveBeenCalled();
    await response.body?.cancel("synthetic cancellation");
    expect(cancel).toHaveBeenCalledWith("synthetic cancellation");
  });

  it.each([
    ["{}", "application/json", JSON.stringify({ error: { code: quota } })],
    [JSON.stringify({ stream: false }), "text/plain", refusal],
  ])(
    "never observes an ordinary body when the request %s did not stream",
    async (requestBody, contentType, text) => {
      const observer = vi.fn();
      const send = gatewayFetchThrough({
        provider: "openai",
        chatGpt: async () => upstream(text, contentType),
        gateway: vi.fn(),
        onErrorResponse: observer,
      });
      const response = await send(`${gatewayBaseURL("openai")}/responses`, {
        body: requestBody,
        method: "POST",
      });
      expect(await response.text()).toBe(text);
      expect(observer).not.toHaveBeenCalled();
    },
  );

  it("leaves a streamed request body for the route that transmits it", async () => {
    const sent: string[] = [];
    const send = gatewayFetchThrough({
      provider: "anthropic",
      gateway: async (request) => {
        sent.push(await new Response(request.init?.body).text());
        return upstream(refusal, "text/event-stream");
      },
      onErrorResponse: vi.fn(),
    });
    const response = await send(`${gatewayBaseURL("anthropic")}/messages`, {
      body: new Blob([streamed]).stream(),
      method: "POST",
      // @ts-expect-error Node requires `duplex` for a streamed request body.
      duplex: "half",
    });
    await response.text();
    expect(sent).toEqual([streamed]);
  });

  it("retains a bounded JSON-string error event but not other JSON-string events", async () => {
    const prose = `Synthetic usage limit ${"é".repeat(5_000)}`;
    const text = `data: ${JSON.stringify("Synthetic private output")}\n\nevent: error\ndata: ${JSON.stringify(prose)}\n\n`;
    const diagnostics: string[] = [];
    const send = gatewayFetchThrough({
      provider: "openai",
      chatGpt: async () => upstream(text, undefined),
      gateway: vi.fn(),
      onErrorResponse: (failure) => diagnostics.push(failure.body),
    });
    const response = await send(`${gatewayBaseURL("openai")}/responses`, {
      body: streamed,
      method: "POST",
    });
    expect(await response.text()).toBe(text);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toContain("Synthetic usage limit");
    expect(diagnostics[0]).not.toContain("Synthetic private output");
    expect(
      new TextEncoder().encode(diagnostics[0]).byteLength,
    ).toBeLessThanOrEqual(4_096);
  });

  it("reports wire metadata for every response without reading its body", async () => {
    const wires: unknown[] = [];
    const send = gatewayFetchThrough({
      provider: "openai",
      chatGpt: async () => upstream(refusal, undefined),
      gateway: vi.fn(),
      onResponse: (_info, wire) => wires.push(wire),
    });
    const response = await send(`${gatewayBaseURL("openai")}/responses`, {
      body: streamed,
      method: "POST",
    });
    expect(wires).toEqual([
      { status: 200, contentType: null, requestId: "synthetic-request" },
    ]);
    expect(await response.text()).toBe(refusal);
  });
});

// Observed: the ChatGPT plan answers a requested stream with HTTP 200, no
// Content-Type, `response.created`/`response.in_progress`, then an `event: error`
// quota envelope. Budgeted fallback may replay only that pre-output refusal.
// Failure modes: output/tool/reasoning/unknown or malformed activity precedes
// the refusal and is replayed through a paid route; held bytes are altered,
// lost, or reordered; an idle, oversized, incomplete, failed, aborted or late
// stream is held forever or recovered; the paid route or a peer is probed;
// fallback skips opt-in or durable admission; diagnostics are lost.
describe("budgeted pre-output stream quota fallback", () => {
  const url = `${gatewayBaseURL("openai")}/responses`;
  const init = {
    method: "POST",
    body: JSON.stringify({ model: "gpt-6-sol", input: [], stream: true }),
  };
  const quota = {
    type: "invalid_request_error",
    code: "subscription_sharing_usage_limit_exceeded",
    message: "Synthetic usage limit",
    param: null,
  };
  const rawFrame = (event: string | undefined, data: string, eol = "\n") =>
    `${event ? `event: ${event}${eol}` : ""}data: ${data}${eol}${eol}`;
  const frame = (
    event: string | undefined,
    data: GatewayQuery[string],
    eol = "\n",
  ) => rawFrame(event, JSON.stringify(data), eol);
  const created = {
    type: "response.created",
    response: { id: "resp_synthetic", status: "in_progress", output: [] },
  };
  const inProgress = {
    type: "response.in_progress",
    response: { id: "resp_synthetic", status: "in_progress", output: [] },
  };
  const metadata = (eol = "\n") =>
    frame("response.created", created, eol) +
    frame("response.in_progress", inProgress, eol);
  const refusal = (eol = "\n") => metadata(eol) + frame("error", quota, eol);

  function chunked(
    text: string,
    size: number,
    extra: UnderlyingDefaultSource<Uint8Array> = {},
  ) {
    const bytes = new TextEncoder().encode(text);
    let offset = 0;
    return new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (offset >= bytes.length) controller.close();
          else {
            controller.enqueue(bytes.slice(offset, offset + size));
            offset += size;
          }
        },
        ...extra,
      },
      { highWaterMark: 0 },
    );
  }

  function routes(subscription: () => Response) {
    const events: string[] = [];
    const failures: Array<{ status: number; body: string }> = [];
    const recovered: Array<{ status: number; body: string }> = [];
    const gateway = vi.fn(async () => {
      events.push("transmitted");
      return new Response("paid research");
    });
    const beforePaidRequest = vi.fn(async () => {
      events.push("admitted");
    });
    return {
      events,
      failures,
      recovered,
      gateway,
      beforePaidRequest,
      fetchRoutes: {
        provider: "openai",
        subscriptionRequired: true,
        subscriptionFallback: "budgeted" as const,
        chatGpt: async (_query, options) => {
          options?.onSelected?.();
          return subscription();
        },
        beforePaidRequest,
        onTransport: (transport: string) => events.push(transport),
        onErrorResponse: (failure: { status: number; body: string }) =>
          failures.push(failure),
        onRecoveredErrorResponse: (failure: { status: number; body: string }) =>
          recovered.push(failure),
        gateway,
      } satisfies GatewayFetchRoutes,
    };
  }

  // A rejected metadata frame currently hides why an otherwise exact quota
  // refusal was replayed. Diagnostics must preserve the first decision only,
  // expose structural issues, and never retain lifecycle values.
  it("reports the first stream admission rejection without lifecycle values", async () => {
    const source =
      frame("response.created", {
        ...created,
        response: {
          ...created.response,
          user: null,
          unknown_metadata: "PRIVATE_SYNTHETIC_VALUE",
        },
      }) + refusal();
    const r = routes(() => new Response(chunked(source, 17)));
    const response = await gatewayFetchThrough(r.fetchRoutes)(url, init);
    expect(await response.text()).toBe(source);
    expect(r.gateway).not.toHaveBeenCalled();
    expect(r.beforePaidRequest).not.toHaveBeenCalled();
    const diagnostic = r.failures[0]?.body ?? "";
    expect(diagnostic).toContain('"reason":"metadata_schema"');
    expect(diagnostic).toContain('"event":"response.created"');
    expect(diagnostic).toContain('"path":["response","user"]');
    expect(diagnostic).toContain('"code":"invalid_type"');
    expect(diagnostic).toContain('"keys":["unknown_metadata"]');
    expect(diagnostic).not.toContain("PRIVATE_SYNTHETIC_VALUE");
    expect(diagnostic).toContain(quota.code);
  });

  it("keeps admission evidence valid and bounded with escaped structural keys", async () => {
    const unknown = Object.fromEntries(
      Array.from({ length: 4 }, (_, index) => [
        "\u0000".repeat(40) + index,
        "PRIVATE_SYNTHETIC_VALUE",
      ]),
    );
    const source =
      frame("response.created", {
        ...created,
        ...unknown,
        response: {
          ...created.response,
          ...unknown,
          reasoning: { ...unknown },
          text: { ...unknown },
        },
      }) + refusal();
    const r = routes(() => new Response(chunked(source, 131)));
    const response = await gatewayFetchThrough(r.fetchRoutes)(url, init);
    expect(await response.text()).toBe(source);
    expect(r.gateway).not.toHaveBeenCalled();
    const prefix = "Subscription stream admission: ";
    const diagnostic = (r.failures[0]?.body ?? "").split(prefix)[1] ?? "";
    expect(
      new TextEncoder().encode("\n" + prefix + diagnostic).length,
    ).toBeLessThanOrEqual(2_048);
    expect(JSON.parse(diagnostic)).toMatchObject({
      reason: "metadata_schema",
      streamRequested: true,
      elapsedMs: expect.any(Number),
      inspectedBytes: expect.any(Number),
    });
    expect(diagnostic).not.toContain("PRIVATE_SYNTHETIC_VALUE");
  });

  it.each(["\n", "\r\n"])(
    "recovers the observed MIME-less fragmented pre-output refusal (%j)",
    async (eol) => {
      const cancel = vi.fn();
      const r = routes(
        () => new Response(chunked(refusal(eol), 1, { cancel }), {}),
      );
      const response = await gatewayFetchThrough(r.fetchRoutes)(url, init);
      expect(await response.text()).toBe("paid research");
      expect(r.events).toEqual([
        "chatgpt",
        "admitted",
        "gateway",
        "transmitted",
      ]);
      expect(r.failures).toHaveLength(1);
      expect(r.recovered).toEqual(r.failures);
      expect(r.failures[0]?.status).toBe(200);
      expect(r.failures[0]?.body).toContain(
        '"priorEvents":["response.created","response.in_progress"]',
      );
      expect(r.failures[0]?.body).toContain(quota.code);
      expect(r.failures[0]?.body).toContain(quota.message);
      expect(r.failures[0]?.body).toContain('"contentType":null');
    },
  );

  it("forwards a normal output stream byte-for-byte without waiting for its end", async () => {
    const text =
      metadata("\r\n") +
      frame("response.output_text.delta", {
        type: "response.output_text.delta",
        delta: "Synthetic output é",
      });
    const tail = frame("response.completed", {
      type: "response.completed",
      response: { status: "completed" },
    });
    const head = new TextEncoder().encode(text);
    const rest = new TextEncoder().encode(tail);
    let step = 0;
    let releaseTail: () => void = () => {};
    const tailReady = new Promise<void>((resolve) => {
      releaseTail = resolve;
    });
    const headers = {
      "content-type": "text/event-stream",
      "x-request-id": "synthetic-request",
    };
    const r = routes(
      () =>
        new Response(
          new ReadableStream<Uint8Array>(
            {
              async pull(controller) {
                step += 1;
                if (step === 1) controller.enqueue(head.slice(0, 7));
                else if (step === 2) controller.enqueue(head.slice(7));
                else if (step === 3) {
                  await tailReady;
                  controller.enqueue(rest);
                } else controller.close();
              },
            },
            { highWaterMark: 0 },
          ),
          { status: 200, statusText: "Synthetic OK", headers },
        ),
    );
    const response = await gatewayFetchThrough(r.fetchRoutes)(url, init);
    expect(response.status).toBe(200);
    expect(response.statusText).toBe("Synthetic OK");
    expect(response.headers.get("x-request-id")).toBe("synthetic-request");
    releaseTail();
    expect(await response.text()).toBe(text + tail);
    expect(r.beforePaidRequest).not.toHaveBeenCalled();
    expect(r.gateway).not.toHaveBeenCalled();
    expect(r.events).toEqual(["chatgpt"]);
  });

  it.each([
    [
      "output text",
      frame("response.output_text.delta", {
        type: "response.output_text.delta",
        delta: "Synthetic output",
      }),
    ],
    [
      "tool activity",
      frame("response.output_item.added", {
        type: "response.output_item.added",
        item: { type: "function_call", name: "synthetic_tool" },
      }),
    ],
    [
      "reasoning",
      frame("response.reasoning_summary_text.delta", {
        type: "response.reasoning_summary_text.delta",
        delta: "Synthetic reasoning",
      }),
    ],
    [
      "unknown event",
      frame("response.synthetic", { type: "response.synthetic" }),
    ],
    ["unnamed unknown data", frame(undefined, { type: "response.synthetic" })],
    ["malformed metadata", rawFrame("response.created", "{not json")],
    ["string data", rawFrame(undefined, JSON.stringify("Synthetic output"))],
    [
      "metadata carrying output",
      frame("response.created", {
        ...created,
        response: { ...created.response, output: [{ type: "message" }] },
      }),
    ],
    [
      "metadata of a finished response",
      frame("response.in_progress", {
        ...inProgress,
        response: { ...inProgress.response, status: "completed" },
      }),
    ],
    [
      "metadata whose event name disagrees with its type",
      frame("response.created", { ...created, type: "response.output_text" }),
    ],
    [
      "unnamed metadata",
      frame(undefined, { ...created, response: { output: [] } }),
    ],
    [
      "unexpected top-level metadata output",
      frame("response.created", { ...created, delta: "Synthetic output" }),
    ],
    [
      "unexpected nested metadata output",
      frame("response.created", {
        ...created,
        response: { ...created.response, delta: "Synthetic output" },
      }),
    ],
    [
      "metadata carrying an error",
      frame("response.created", {
        ...created,
        response: { ...created.response, error: { code: "synthetic" } },
      }),
    ],
  ])("never recovers a quota refusal after %s", async (_name, prior) => {
    const text = prior + frame("error", quota);
    // Small chunks and one whole chunk: the first semantic event decides.
    for (const size of [3, 1 << 20]) {
      const r = routes(() => new Response(chunked(text, size)));
      const response = await gatewayFetchThrough(r.fetchRoutes)(url, init);
      expect(await response.text()).toBe(text);
      expect(r.beforePaidRequest).not.toHaveBeenCalled();
      expect(r.gateway).not.toHaveBeenCalled();
      expect(r.recovered).toEqual([]);
    }
  });

  it.each([
    ["another error code", frame("error", { ...quota, code: "rate_limit" })],
    ["a JSON-string error", rawFrame("error", JSON.stringify(quota.code))],
    [
      "an error with a conflicting failed-response type",
      frame("error", {
        type: "response.failed",
        response: { output: [], error: quota },
      }),
    ],
    [
      "an error containing a function call",
      frame("error", {
        type: "error",
        response: {
          output: [{ type: "function_call", name: "synthetic_tool" }],
          error: quota,
        },
      }),
    ],
    [
      "a quota error carrying unexpected output",
      frame("error", { ...quota, delta: "Synthetic output" }),
    ],
    [
      "a failed response",
      frame("response.failed", {
        type: "response.failed",
        response: { error: { code: quota.code }, output: [] },
      }),
    ],
    [
      "an incomplete frame at EOF",
      `event: error\ndata: ${JSON.stringify(quota)}\n`,
    ],
    [
      "oversized metadata",
      frame("response.created", {
        ...created,
        response: { ...created.response, instructions: "x".repeat(70_000) },
      }) + frame("error", quota),
    ],
    ["an empty stream", ""],
  ])("returns the original stream for %s", async (_name, tail) => {
    const text = metadata() + tail;
    // A single oversized delivery must not bypass the held-prefix bound.
    for (const size of [4_096, 1 << 20]) {
      const r = routes(() => new Response(chunked(text, size)));
      const response = await gatewayFetchThrough(r.fetchRoutes)(url, init);
      expect(await response.text()).toBe(text);
      expect(r.beforePaidRequest).not.toHaveBeenCalled();
      expect(r.gateway).not.toHaveBeenCalled();
      expect(r.recovered).toEqual([]);
    }
  });

  it("recovers a refusal completed within the byte bound despite a larger delivery", async () => {
    const text = refusal() + `: ${"x".repeat(70_000)}\n\n`;
    const r = routes(() => new Response(chunked(text, 1 << 20)));
    const response = await gatewayFetchThrough(r.fetchRoutes)(url, init);
    expect(await response.text()).toBe("paid research");
    expect(r.recovered).toHaveLength(1);
  });

  it("replays held bytes and then the original read failure", async () => {
    const failure = new Error("Synthetic network reset");
    const head = new TextEncoder().encode(metadata());
    let step = 0;
    const r = routes(
      () =>
        new Response(
          new ReadableStream<Uint8Array>(
            {
              pull(controller) {
                step += 1;
                if (step === 1) controller.enqueue(head);
                else controller.error(failure);
              },
            },
            { highWaterMark: 0 },
          ),
        ),
    );
    const response = await gatewayFetchThrough(r.fetchRoutes)(url, init);
    const reader = response.body!.getReader();
    expect(await reader.read()).toEqual({ done: false, value: head });
    await expect(reader.read()).rejects.toBe(failure);
    expect(r.gateway).not.toHaveBeenCalled();
    expect(r.beforePaidRequest).not.toHaveBeenCalled();
  });

  it("rejects with the caller's abort and cancels the held subscription stream", async () => {
    const controller = new AbortController();
    const reason = new Error("Synthetic caller cancelled");
    const cancel = vi.fn();
    const head = new TextEncoder().encode(metadata());
    let step = 0;
    const r = routes(
      () =>
        new Response(
          new ReadableStream<Uint8Array>(
            {
              pull(c) {
                step += 1;
                if (step === 1) c.enqueue(head);
                else controller.abort(reason);
                // Otherwise idle: no further bytes.
              },
              cancel,
            },
            { highWaterMark: 0 },
          ),
        ),
    );
    await expect(
      gatewayFetchThrough(r.fetchRoutes)(url, {
        ...init,
        signal: controller.signal,
      }),
    ).rejects.toBe(reason);
    expect(cancel).toHaveBeenCalledWith(reason);
    expect(r.beforePaidRequest).not.toHaveBeenCalled();
    expect(r.gateway).not.toHaveBeenCalled();
  });

  it("stops holding an idle stream, then forwards a late refusal and cancellation unchanged", async () => {
    vi.useFakeTimers();
    try {
      const head = new TextEncoder().encode(metadata());
      const late = new TextEncoder().encode(frame("error", quota));
      let step = 0;
      let releaseLate: () => void = () => {};
      const lateReady = new Promise<void>((resolve) => {
        releaseLate = resolve;
      });
      const cancel = vi.fn();
      const r = routes(
        () =>
          new Response(
            new ReadableStream<Uint8Array>(
              {
                async pull(c) {
                  step += 1;
                  if (step === 1) c.enqueue(head);
                  else if (step === 2) {
                    await lateReady;
                    c.enqueue(late);
                  }
                },
                cancel,
              },
              { highWaterMark: 0 },
            ),
          ),
      );
      let settled = false;
      const pending = gatewayFetchThrough(r.fetchRoutes)(url, init).finally(
        () => {
          settled = true;
        },
      );
      await vi.advanceTimersByTimeAsync(1_000);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(60_000);
      const response = await pending;
      releaseLate();
      const reader = response.body!.getReader();
      expect(await reader.read()).toEqual({ done: false, value: head });
      expect(await reader.read()).toEqual({ done: false, value: late });
      await reader.cancel("synthetic cancellation");
      expect(cancel).toHaveBeenCalledWith("synthetic cancellation");
      expect(r.beforePaidRequest).not.toHaveBeenCalled();
      expect(r.gateway).not.toHaveBeenCalled();
      expect(r.recovered).toEqual([]);
      expect(r.failures).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["not opted in", "no admission"] as const)(
    "does not probe or recover a streamed refusal when %s",
    async (mode) => {
      const r = routes(() => new Response(refusal()));
      const response = await gatewayFetchThrough({
        ...r.fetchRoutes,
        subscriptionFallback: mode === "not opted in" ? undefined : "budgeted",
        beforePaidRequest:
          mode === "no admission" ? undefined : r.beforePaidRequest,
      })(url, init);
      expect(await response.text()).toBe(refusal());
      expect(r.gateway).not.toHaveBeenCalled();
      expect(r.recovered).toEqual([]);
    },
  );

  it("does not probe a stream the request did not ask for", async () => {
    const r = routes(() => new Response(refusal()));
    const response = await gatewayFetchThrough(r.fetchRoutes)(url, {
      ...init,
      body: JSON.stringify({ model: "gpt-6-sol", input: [] }),
    });
    expect(await response.text()).toBe(refusal());
    expect(r.gateway).not.toHaveBeenCalled();
  });

  it("does not probe an HTTP auth failure carrying the quota code", async () => {
    const r = routes(() => new Response(refusal(), { status: 401 }));
    const response = await gatewayFetchThrough(r.fetchRoutes)(url, init);
    expect(response.status).toBe(401);
    expect(await response.text()).toBe(refusal());
    expect(r.gateway).not.toHaveBeenCalled();
    expect(r.recovered).toEqual([]);
  });

  it.each(["gateway", "testPeer"] as const)(
    "never probes or replays a paid %s stream",
    async (route) => {
      const paid = vi.fn(async () => new Response(refusal()));
      const r = routes(() => new Response(""));
      const response = await gatewayFetchThrough({
        ...r.fetchRoutes,
        chatGpt: async () => null,
        testPeer: route === "testPeer" ? () => paid : undefined,
        gateway: paid,
      })(url, init);
      expect(await response.text()).toBe(refusal());
      expect(paid).toHaveBeenCalledOnce();
      expect(r.beforePaidRequest).toHaveBeenCalledOnce();
      expect(r.recovered).toEqual([]);
    },
  );

  it.each(["refused", "aborted"] as const)(
    "reports the recovered quota separately when admission is %s",
    async (mode) => {
      const controller = new AbortController();
      const r = routes(() => new Response(chunked(refusal("\r\n"), 5)));
      const order: string[] = [];
      const send = gatewayFetchThrough({
        ...r.fetchRoutes,
        onErrorResponse: () => order.push("quota"),
        onRecoveredErrorResponse: () => order.push("recovered"),
        beforePaidRequest: async () => {
          order.push("admission");
          if (mode === "refused") throw new Error("Synthetic budget exhausted");
          controller.abort(new Error("Synthetic caller cancelled"));
        },
      });
      await expect(
        send(url, { ...init, signal: controller.signal }),
      ).rejects.toThrow(
        mode === "refused"
          ? "Synthetic budget exhausted"
          : "Synthetic caller cancelled",
      );
      expect(order).toEqual(["quota", "recovered", "admission"]);
      expect(r.gateway).not.toHaveBeenCalled();
    },
  );
});
