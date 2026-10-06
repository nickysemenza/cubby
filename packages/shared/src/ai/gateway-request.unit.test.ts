import { describe, expect, it } from "vitest";

import {
  gatewayControlHeaders,
  gatewayProviderUrl,
  gatewayResponseInfo,
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
