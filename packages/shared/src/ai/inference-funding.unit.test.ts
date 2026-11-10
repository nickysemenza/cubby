import { describe, expect, it } from "vitest";

import {
  type GatewayQuery,
  creditRefusedResponse,
  inferenceFundingHeaders,
  isInferenceFundingRefusal,
  isInferenceStreamFundingRefusal,
  isOpenAiCreditRefusal,
  runProviderGateway,
  gatewayFetchThrough,
  type InferenceFunding,
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
  it.each([
    { provider: "anthropic", funding: "subscriber_credit" },
    { provider: "openai", funding: "openai_credit" },
    { provider: "anthropic", funding: "paid" },
    { provider: "openai", funding: "paid" },
  ] satisfies { provider: string; funding: InferenceFunding }[])(
    "sends $provider $funding controls on the funded transport",
    async ({ provider, funding }) => {
      let sent: Request | undefined;
      const endpoint = provider === "openai" ? "responses" : "v1/messages";
      const query: GatewayQuery =
        provider === "openai"
          ? {
              model: "gpt-6.1-sol",
              input: [],
              stream: true,
              reasoning: { effort: "high" },
              tools: [{ type: "function", name: "synthetic" }],
            }
          : {
              model: "claude-sonnet-5-5",
              messages: [],
              stream: true,
              thinking: { type: "adaptive" },
              max_tokens: 512,
            };
      await runProviderGateway({
        accountId: "example-account",
        gatewayId: "cubby",
        token: "example-token",
        provider,
        request: {
          endpoint,
          headers: new Headers(inferenceFundingHeaders(funding)),
          input: new URL(`https://ai-gateway.invalid/${provider}/${endpoint}`),
          init: { method: "POST" },
          signal: undefined,
          query: async () => query,
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
        funding === "paid"
          ? `https://api.cloudflare.com/client/v4/accounts/example-account/ai/v1/${provider === "openai" ? "responses" : "messages"}`
          : `https://gateway.ai.cloudflare.com/v1/example-account/cubby/${provider}/${endpoint}`,
      );
      expect(sent?.headers.get("cf-aig-byok-alias")).toBe(
        funding === "paid" ? null : "subscriber-credit",
      );
      expect(sent?.headers.get("cf-aig-no-wholesale")).toBe(
        funding === "paid" ? null : "true",
      );
      expect(sent?.headers.get("cf-aig-authorization")).toBe(
        funding === "paid" ? null : "Bearer example-token",
      );
      expect(sent?.headers.get("authorization")).toBe(
        funding === "paid" ? "Bearer example-token" : null,
      );
      expect(sent?.headers.get("cf-aig-gateway-id")).toBe(
        funding === "paid" ? "cubby-testing" : null,
      );
      expect(query.model).toBe(
        provider === "openai" ? "gpt-6.1-sol" : "claude-sonnet-5-5",
      );
      expect(await sent?.json()).toEqual(
        funding === "paid"
          ? {
              ...query,
              model:
                provider === "openai"
                  ? "openai/gpt-6.1-sol"
                  : "anthropic/claude-sonnet-5.5",
            }
          : query,
      );
    },
  );

  it("advances past the plan's bare rate limit", () => {
    const body = JSON.stringify({ detail: "Rate limit exceeded" });
    expect(isInferenceFundingRefusal(429, body, "subscription")).toBe(true);
    expect(isInferenceFundingRefusal(429, body, "openai_credit")).toBe(false);
  });

  it.each(["credit_balance_exhausted", "insufficient_quota"])(
    "recognizes OpenAI credit exhaustion %s without treating rate limits as exhausted credit",
    (code) => {
      expect(
        isInferenceFundingRefusal(
          429,
          JSON.stringify({ error: { code } }),
          "openai_credit",
        ),
      ).toBe(true);
      expect(
        isInferenceFundingRefusal(
          429,
          JSON.stringify({ error: { code: "rate_limit_exceeded" } }),
          "openai_credit",
        ),
      ).toBe(false);
    },
  );

  // The Responses envelope usually carries code and type. When it does not,
  // the billing sentence is the refusal, including pi's terminal text.
  it("recognizes OpenAI's no-credits sentence when the envelope has no code", async () => {
    const message =
      "You have no credits remaining. Add credits to continue using the API at https://platform.openai.com/settings/organization/billing/.";
    const body = JSON.stringify({ error: { message } });
    expect(isInferenceFundingRefusal(429, body, "openai_credit")).toBe(true);
    expect(
      isInferenceFundingRefusal(
        429,
        JSON.stringify({
          error: {
            message,
            type: "insufficient_quota",
            code: "credit_balance_exhausted",
          },
        }),
        "openai_credit",
      ),
    ).toBe(true);
    expect(isInferenceFundingRefusal(500, message, "openai_credit")).toBe(
      false,
    );
    expect(isInferenceFundingRefusal(429, message, "subscriber_credit")).toBe(
      false,
    );
    expect(isInferenceStreamFundingRefusal(message, "openai_credit")).toBe(
      true,
    );
    expect(
      isInferenceStreamFundingRefusal(`unknown: ${message}`, "openai_credit"),
    ).toBe(true);
    expect(
      isInferenceStreamFundingRefusal(
        `Error Code credit_balance_exhausted: ${message}`,
        "openai_credit",
      ),
    ).toBe(true);
    expect(isInferenceStreamFundingRefusal(message, "subscriber_credit")).toBe(
      false,
    );
    expect(isOpenAiCreditRefusal(message)).toBe(true);
    expect(isOpenAiCreditRefusal("429 Too Many Requests")).toBe(false);
    expect(
      isOpenAiCreditRefusal(
        `Mail discovery quoted a billing email: ${message}`,
      ),
    ).toBe(false);
    expect(
      isOpenAiCreditRefusal(
        JSON.stringify({
          input: [{ content: message }],
          error: { message: "The model produced no output" },
        }),
      ),
    ).toBe(false);
    const refusal = {
      until: Date.parse("2099-01-01T00:00:00Z"),
      reason: "Synthetic provider limit",
    };
    expect(
      isOpenAiCreditRefusal(await creditRefusedResponse(refusal).text()),
    ).toBe(false);
    expect(
      isOpenAiCreditRefusal(
        await creditRefusedResponse(refusal, "openai").text(),
      ),
    ).toBe(true);
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
  // Provider credits have no window budget (ADR 0027): a spent plan budget
  // must never stop a credit attempt, which runs until the provider refuses.
  it.each(["subscriber_credit", "openai_credit"] as const)(
    "transmits a %s attempt regardless of the plan budget",
    async (funding) => {
      const sent: string[] = [];
      const response = await gatewayFetchThrough({
        provider: funding === "openai_credit" ? "openai" : "anthropic",
        funding,
        chatGpt: async () => {
          throw new Error("Credit attempt must bypass OAuth");
        },
        beforePlanRequest: async () =>
          "ChatGPT plan budget reached: $2 of $2 standard cost",
        gateway: async () => {
          sent.push("credit");
          return Response.json({});
        },
      })(
        `https://ai-gateway.invalid/${funding === "openai_credit" ? "openai/responses" : "anthropic/v1/messages"}`,
        { method: "POST", body: '{"model":"claude-sonnet-5-5"}' },
      );
      expect(response.status).toBe(200);
      expect(sent).toEqual(["credit"]);
    },
  );

  // A workflow that lost its Job must not transmit on a credit key either.
  it.each(["subscriber_credit", "openai_credit"] as const)(
    "stops a %s attempt whose execution admission throws, before transmitting",
    async (funding) => {
      const sent: string[] = [];
      await expect(
        gatewayFetchThrough({
          provider: funding === "openai_credit" ? "openai" : "anthropic",
          funding,
          beforeCreditRequest: async () => {
            throw new Error("Synthetic workflow no longer current");
          },
          gateway: async () => {
            sent.push("credit");
            return Response.json({});
          },
        })(
          `https://ai-gateway.invalid/${funding === "openai_credit" ? "openai/responses" : "anthropic/v1/messages"}`,
          { method: "POST", body: '{"model":"claude-sonnet-5-5"}' },
        ),
      ).rejects.toThrow("Synthetic workflow no longer current");
      expect(sent).toEqual([]);
    },
  );

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
        beforePlanRequest: async () =>
          "ChatGPT plan budget reached: $2 of $2 standard cost",
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
