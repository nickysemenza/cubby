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
