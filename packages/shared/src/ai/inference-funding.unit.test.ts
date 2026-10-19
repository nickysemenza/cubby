import { describe, expect, it } from "vitest";

import {
  inferenceFundingHeaders,
  isInferenceFundingRefusal,
  runNativeGateway,
  gatewayFetchThrough,
} from "./gateway-request";

// A missing credit key must not silently spend Unified Billing. Only capacity
// refusal advances funding; malformed requests, bad keys and outages stay errors.
describe("inference funding", () => {
  it("labels a subscription-only peer attempt without paid admission", async () => {
    const calls: string[] = [];
    const send = gatewayFetchThrough({
      provider: "openai",
      funding: "subscription",
      beforePaidRequest: async () => {
        calls.push("paid admission");
      },
      testPeer: () => async (request) => {
        calls.push(
          request.headers.get("x-cubby-inference-funding") ?? "missing funding",
        );
        return Response.json(
          { error: { code: "subscription_unavailable" } },
          { status: 429 },
        );
      },
      gateway: async () => {
        throw new Error("must not purchase inference");
      },
    });
    expect(
      (
        await send("https://ai-gateway.invalid/openai/responses", {
          method: "POST",
          body: "{}",
        })
      ).status,
    ).toBe(429);
    expect(calls).toEqual(["subscription"]);
  });
  it("sends named BYOK controls on the native provider request, not a Universal payload", async () => {
    let sent: Request | undefined;
    await runNativeGateway({
      accountId: "example-account",
      gatewayId: "cubby",
      token: "example-token",
      provider: "anthropic",
      request: {
        endpoint: "v1/messages",
        headers: new Headers(inferenceFundingHeaders("subscriber_credit")),
        input: new URL("https://ai-gateway.invalid/anthropic/v1/messages"),
        init: { method: "POST" },
        signal: undefined,
        query: async () => ({ model: "claude-opus-5-5", messages: [] }),
      },
      controls: {
        metadata: {
          environment: "development",
          feature: "synthetic",
          operation: "probe",
        },
      },
      fetcher: async (input, init) => {
        sent = new Request(input, init);
        return Response.json({});
      },
    });
    expect(sent?.url).toBe(
      "https://gateway.ai.cloudflare.com/v1/example-account/cubby/anthropic/v1/messages",
    );
    expect(sent?.headers.get("cf-aig-byok-alias")).toBe("subscriber-credit");
    expect(sent?.headers.get("cf-aig-no-wholesale")).toBe("true");
    expect(await sent?.json()).toEqual({
      model: "claude-opus-5-5",
      messages: [],
    });
  });

  it("leaves subscription quota refusal to the model owner without internal paid fallback", async () => {
    const calls: string[] = [];
    const send = gatewayFetchThrough({
      provider: "openai",
      funding: "subscription",
      subscriptionFallback: "budgeted",
      beforePaidRequest: async () => {
        calls.push("admit");
      },
      chatGpt: async () =>
        Response.json(
          { error: { code: "usage_limit_reached" } },
          { status: 429 },
        ),
      gateway: async () => {
        calls.push("paid");
        return Response.json({});
      },
    });
    expect(
      (
        await send("https://ai-gateway.invalid/openai/responses", {
          method: "POST",
          body: "{}",
        })
      ).status,
    ).toBe(429);
    expect(calls).toEqual([]);
  });
  // A spent Claude credit budget must advance the ladder like a Console
  // refusal, before anything is transmitted on the credit key.
  it("refuses a credit attempt Cubby's credit budget stops as a funding refusal", async () => {
    const sent: string[] = [];
    const send = (refusal: string | null) =>
      gatewayFetchThrough({
        provider: "anthropic",
        funding: "subscriber_credit",
        beforeFreeRequest: async () => refusal,
        gateway: async () => {
          sent.push("credit");
          return Response.json({});
        },
      })("https://ai-gateway.invalid/anthropic/v1/messages", {
        method: "POST",
        body: '{"model":"claude-opus-5-5"}',
      });
    const refused = await send(
      "Claude credit budget reached: $5 of $5 standard cost",
    );
    const body = await refused.text();
    expect(refused.status).toBe(429);
    expect(body).toContain("Claude credit budget reached");
    expect(isInferenceFundingRefusal(429, body, "subscriber_credit")).toBe(
      true,
    );
    expect(sent).toEqual([]);
    expect((await send(null)).status).toBe(200);
    expect(sent).toEqual(["credit"]);
  });

  // The ChatGPT plan's quota is shared with the members' own use: a spent
  // plan budget must leave the plan untouched and advance the ladder, and an
  // unladdered call must take its paid path instead.
  it("refuses a plan attempt Cubby's plan budget stops, before the plan is called", async () => {
    const sent: string[] = [];
    const send = (funding: "subscription" | undefined) =>
      gatewayFetchThrough({
        provider: "openai",
        funding,
        subscriptionFallback: funding ? undefined : "budgeted",
        beforePaidRequest: async () => undefined,
        beforeFreeRequest: async (_request, rung) =>
          rung === "subscription"
            ? "ChatGPT plan budget reached: $2 of $2 standard cost"
            : null,
        chatGpt: async () => {
          sent.push("plan");
          return Response.json({});
        },
        gateway: async () => {
          sent.push("paid");
          return Response.json({});
        },
      })("https://ai-gateway.invalid/openai/responses", {
        method: "POST",
        body: '{"model":"gpt-6-luna"}',
      });
    const refused = await send("subscription");
    const body = await refused.text();
    expect(refused.status).toBe(429);
    expect(body).toContain("cubby_plan_budget_reached");
    expect(isInferenceFundingRefusal(429, body, "subscription")).toBe(true);
    expect(sent).toEqual([]);
    expect((await send(undefined)).status).toBe(200);
    expect(sent).toEqual(["paid"]);
  });

  it("requires the named credit key and leaves paid requests unaliased", () => {
    expect(inferenceFundingHeaders("subscriber_credit")).toEqual({
      "cf-aig-byok-alias": "subscriber-credit",
      "cf-aig-no-wholesale": "true",
    });
    expect(inferenceFundingHeaders("paid")).toEqual({});
  });

  it.each([
    [400, "Your credit balance is too low to access the Anthropic API."],
    [400, "You have reached your specified API usage limits."],
    [
      429,
      '{"error":{"type":"rate_limit_error","message":"enforced_spend_limit_reached"}}',
    ],
  ])("advances credit funding on capacity refusal %s", (status, body) => {
    expect(isInferenceFundingRefusal(status, body, "subscriber_credit")).toBe(
      true,
    );
  });

  it.each([
    [400, "tool_choice is invalid"],
    [401, "invalid x-api-key"],
    [429, "AI Gateway admission is waiting for shared capacity"],
    [
      429,
      '{"error":{"type":"rate_limit_error","message":"Requests per minute limit exceeded"}}',
    ],
    [500, "Your credit balance is too low"],
  ])("preserves non-funding failure %s", (status, body) => {
    expect(isInferenceFundingRefusal(status, body, "subscriber_credit")).toBe(
      false,
    );
  });

  it("recognizes subscription exhaustion without retrying the paid stage", () => {
    const body = '{"error":{"code":"usage_limit_reached"}}';
    expect(isInferenceFundingRefusal(429, body, "subscription")).toBe(true);
    expect(isInferenceFundingRefusal(429, body, "paid")).toBe(false);
  });
});
