import { describe, expect, it, vi } from "vitest";

import {
  gatewayControlHeaders,
  gatewayProviderUrl,
  gatewayResponseInfo,
  gatewayBaseURL,
  gatewayFetchThrough,
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
