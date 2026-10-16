import { AUDIT_RECOVERY_MODEL, QUALITY_MODEL } from "@cubby/shared/ai/models";
import { createOpenAI } from "@ai-sdk/openai";
import { wrapLanguageModel, APICallError } from "ai";
import { z } from "zod";
import { experimental_decide as decide, generateText } from "ai";
import { afterEach, expect, it, vi } from "vitest";

import {
  modelConfiguration,
  testerArmyGatewayHeaders,
  testerArmyModel,
  testerArmyDecisionModel,
  testerArmyReplayCommand,
  testerArmyAgent,
  testerArmyDriverIdentity,
} from "./model";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

// Failure modes: Jev is sent to the OpenAI Responses endpoint, its text tier
// loses the provider prefix, or a run starts without the shared gateway token.
it("configures Jev decisions with a separate gateway text model", () => {
  const config = modelConfiguration(
    { TESTER_ARMY_MODEL: "openai/gpt-5.4-mini" },
    () => "synthetic-token",
  );
  expect(config.TESTER_ARMY_MODEL).toBe("openai/gpt-5.4-mini");
  expect(() => modelConfiguration({}, () => undefined)).toThrow(
    /TESTER_ARMY_CF_API_TOKEN/u,
  );
});

// Failure modes: driver traffic lands on a separate or unnamed gateway, or a
// laptop run is reported as CI (or either as production); a per-run revision
// becomes a gateway label again.
it.each([
  { ci: "true", environment: "ci" },
  { ci: undefined, environment: "development" },
])("scopes the driver to evaluation as $environment", ({ ci, environment }) => {
  const headers = testerArmyGatewayHeaders(ci);
  expect(headers["cf-aig-gateway-id"]).toBe("cubby");
  expect(headers["cf-aig-skip-cache"]).toBe("true");
  expect(JSON.parse(headers["cf-aig-metadata"])).toEqual({
    environment,
    feature: "tester-army",
    operation: "driver",
  });
});

// GitHub renders an unset repository variable as "", so a workflow that
// forwards one must still resolve the canonical driver and account.
it("treats blank workflow variables as omitted", () => {
  vi.stubEnv("TESTER_ARMY_MODEL", "");
  vi.stubEnv("TESTER_ARMY_CF_ACCOUNT_ID", "");
  const config = modelConfiguration(process.env, () => "synthetic-token");
  expect(config.TESTER_ARMY_MODEL).toBe(`anthropic/${AUDIT_RECOVERY_MODEL}`);
  expect(testerArmyAgent(config).executor?.name).toBe("decision");
  expect(testerArmyDriverIdentity(config)).toBe(
    `typesafe/jev + anthropic/${AUDIT_RECOVERY_MODEL}`,
  );
  expect(config.TESTER_ARMY_CF_ACCOUNT_ID).toMatch(/^[a-f0-9]{32}$/u);
});

// Missing inference credentials must fail before starting fixture services.
it("requires a token and an OpenAI model id for the text tier", () => {
  expect(() => modelConfiguration({}, () => undefined)).toThrow(
    /TESTER_ARMY_CF_API_TOKEN/u,
  );
  expect(() =>
    modelConfiguration(
      { TESTER_ARMY_MODEL: "other/model" },
      () => "synthetic-token",
    ),
  ).toThrow(/TESTER_ARMY_MODEL/u);
});

// External transport seam: the real SDK must decode Cloudflare's envelope and
// preserve the decision, usage, and cancellation while routing no TypeSafe key.
it.each(["direct", "envelope", "run"])(
  "routes Jev through Workers AI (envelope=%s)",
  async (envelope) => {
    const config = modelConfiguration(
      {
        TESTER_ARMY_CF_ACCOUNT_ID: "a".repeat(32),
      },
      () => "synthetic-token",
    );
    const controller = new AbortController();
    const response = {
      model: "jev-1.13.0",
      answers: {
        action: {
          type: "choice",
          choice: "save",
          confidence: 0.99,
          probabilities: { save: 0.99, cancel: 0.01 },
        },
      },
      usage: { input_tokens: 20, output_tokens: 0 },
    };
    const fetcher: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      expect(request.url).toBe(
        `https://api.cloudflare.com/client/v4/accounts/${"a".repeat(32)}/ai/run`,
      );
      expect(request.headers.get("authorization")).toBe(
        "Bearer synthetic-token",
      );
      expect(request.headers.get("cf-aig-gateway-id")).toBe("cubby");
      expect(request.headers.get("cf-aig-skip-cache")).toBe("true");
      expect(await request.json()).toEqual({
        model: "typesafe/jev",
        input: {
          state: "Synthetic editor is ready",
          questions: {
            action: {
              type: "choice",
              instructions: "Choose the next action",
              criteria: { save: "Save the editor", cancel: "Cancel changes" },
            },
          },
        },
      });
      expect(init?.signal?.aborted).toBe(false);
      return Response.json(
        envelope === "run"
          ? { result: { state: "Completed", result: response }, success: true }
          : envelope === "envelope"
            ? { result: response, success: true }
            : response,
      );
    };
    const result = await decide({
      model: testerArmyDecisionModel(config, fetcher),
      state: "Synthetic editor is ready",
      questions: {
        action: {
          type: "choice",
          instructions: "Choose the next action",
          criteria: { save: "Save the editor", cancel: "Cancel changes" },
        },
      },
      abortSignal: controller.signal,
      maxRetries: 0,
    });
    expect(result.answers.action.choice).toBe("save");
    expect(result.usage.inputTokens).toBe(20);
  },
);

// A Jev run must replay with Jev, not silently return to the default driver.
// Credentials must stay outside the artifact's runnable command.
it("preserves the driver and text tier in the replay command without secrets", () => {
  const config = modelConfiguration(
    { TESTER_ARMY_MODEL: "openai/gpt-6-luna" },
    () => "synthetic-token",
  );
  expect(
    testerArmyReplayCommand(
      ["pnpm", "test:e2e:agent:web", "--", "--journey", "product-rename"],
      config,
    ),
  ).toEqual([
    "env",
    "TESTER_ARMY_MODEL=openai/gpt-6-luna",
    "pnpm",
    "test:e2e:agent:web",
    "--",
    "--journey",
    "product-rename",
  ]);
});

// A retryable gateway status must fail once, even if an upstream executor allows retries.
it.each(["decision", "text"] as const)(
  "fails %s gateway calls without transport retries",
  async (tier) => {
    const config = modelConfiguration({}, () => "synthetic-token");
    let calls = 0;
    const fetcher: typeof fetch = async () => {
      calls += 1;
      return Response.json(
        { error: { message: "synthetic rate limit" } },
        { status: 429 },
      );
    };
    const request =
      tier === "decision"
        ? decide({
            model: testerArmyDecisionModel(config, fetcher),
            state: "Synthetic editor",
            questions: {
              action: {
                type: "choice",
                instructions: "Choose",
                criteria: { save: "Save" },
              },
            },
            maxRetries: 1,
          })
        : generateText({
            model: testerArmyModel(config, fetcher),
            prompt: "Synthetic readback",
            maxRetries: 1,
          });
    await expect(request).rejects.toThrow(/gateway HTTP 429/);
    expect(calls).toBe(1);
  },
);

// Connection errors must not become retryable provider errors; cancellation stays cancellation.
it.each(["decision", "text"] as const)(
  "fails %s network calls once and preserves aborts",
  async (tier) => {
    const config = modelConfiguration({}, () => "synthetic-token");
    for (const abort of [false, true]) {
      let calls = 0;
      const error = abort
        ? new DOMException("Synthetic abort", "AbortError")
        : new TypeError("fetch failed", {
            cause: Object.assign(new Error("Synthetic reset"), {
              code: "ECONNRESET",
            }),
          });
      const fetcher: typeof fetch = async () => {
        calls += 1;
        throw error;
      };
      const request =
        tier === "decision"
          ? decide({
              model: testerArmyDecisionModel(config, fetcher),
              state: "Synthetic editor",
              questions: {
                action: {
                  type: "choice",
                  instructions: "Choose",
                  criteria: { save: "Save" },
                },
              },
              maxRetries: 1,
            })
          : generateText({
              model: testerArmyModel(config, fetcher),
              prompt: "Synthetic readback",
              maxRetries: 1,
            });
      await expect(request).rejects.toMatchObject(
        abort ? { name: "AbortError" } : {},
      );
      await expect(request).rejects.toThrow(
        abort ? /Synthetic abort/ : /Synthetic reset/,
      );
      expect(calls).toBe(1);
    }
  },
);

// Connection errors must not become retryable provider errors; cancellation stays cancellation.
it.each(["decision", "text"] as const)(
  "fails %s response-body reads once and preserves aborts",
  async (tier) => {
    const config = modelConfiguration({}, () => "synthetic-token");
    for (const status of [200, 429])
      for (const abort of [false, true]) {
        let calls = 0;
        const error = abort
          ? new DOMException("Synthetic abort", "AbortError")
          : new TypeError("fetch failed", {
              cause: Object.assign(new Error("Synthetic reset"), {
                code: "ECONNRESET",
              }),
            });
        const fetcher: typeof fetch = async () => {
          calls += 1;
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.error(error);
              },
            }),
            { status },
          );
        };
        const request =
          tier === "decision"
            ? decide({
                model: testerArmyDecisionModel(config, fetcher),
                state: "Synthetic editor",
                questions: {
                  action: {
                    type: "choice",
                    instructions: "Choose",
                    criteria: { save: "Save" },
                  },
                },
                maxRetries: 1,
              })
            : generateText({
                model: testerArmyModel(config, fetcher),
                prompt: "Synthetic readback",
                maxRetries: 1,
              });
        await expect(request).rejects.toMatchObject(
          abort ? { name: "AbortError" } : {},
        );
        await expect(request).rejects.toThrow(
          abort ? /Synthetic abort/ : /Synthetic reset/,
        );
        expect(calls).toBe(1);
      }
  },
);

// Funding refusal must switch models without repeating a failed call. Ordinary
// auth, malformed requests, throttling and transport failures must not spend
// from another source. A missing local OAuth login is explicitly unavailable.
it.each([
  {
    status: 400,
    body: {
      error: {
        type: "invalid_request_error",
        message: "Your credit balance is too low to access the Anthropic API.",
      },
    },
    fallback: true,
  },
  { status: 401, body: { error: { message: "invalid key" } }, fallback: false },
  {
    status: 400,
    body: { error: { message: "unsupported image" } },
    fallback: false,
  },
  {
    status: 429,
    body: { error: { message: "synthetic rate limit" } },
    fallback: false,
  },
])(
  "switches funding only for recognized refusal ($status, $fallback)",
  async ({ status, body, fallback }) => {
    const config = modelConfiguration({}, () => "synthetic-token");
    const requests: Request[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      return requests.length === 1
        ? Response.json(body, { status })
        : Response.json(
            { error: { message: "synthetic paid failure" } },
            { status: 402 },
          );
    };
    let subscriptionCalls = 0;
    const subscription = wrapLanguageModel({
      model: createOpenAI({ apiKey: "synthetic" }).responses(QUALITY_MODEL),
      middleware: {
        wrapGenerate: async () => {
          subscriptionCalls += 1;
          throw Object.assign(new Error("synthetic missing login"), {
            name: "OAuthError",
            code: "NOT_LOGGED_IN",
          });
        },
      },
    });
    await expect(
      generateText({
        model: testerArmyModel(config, fetcher, subscription),
        prompt: "Synthetic readback",
        maxRetries: 0,
      }),
    ).rejects.toThrow(fallback ? /synthetic paid failure/ : /gateway HTTP/);
    expect(subscriptionCalls).toBe(fallback ? 1 : 0);
    expect(requests).toHaveLength(fallback ? 2 : 1);
    expect(requests[0]?.url).toContain("/cubby/anthropic/v1/messages");
    expect(requests[0]?.headers.get("cf-aig-byok-alias")).toBe(
      "subscriber-credit",
    );
    expect(requests[0]?.headers.get("cf-aig-no-wholesale")).toBe("true");
    expect(requests[0]?.headers.has("x-api-key")).toBe(false);
    const paidBody = requests[1] ? await requests[1].json() : undefined;
    const paidRequest = {
      url: requests[1]?.url,
      alias: requests[1]?.headers.has("cf-aig-byok-alias"),
      body: paidBody,
    };
    const paidUrl = expect.stringContaining("/ai/v1/responses");
    const paidModel = expect.objectContaining({
      model: `openai/${QUALITY_MODEL}`,
    });
    const expectedPaidRequest = fallback
      ? { url: paidUrl, alias: false, body: paidModel }
      : { url: undefined, alias: undefined, body: undefined };
    expect(paidRequest).toEqual(expectedPaidRequest);
  },
);

// Subscription outages and arbitrary authorization failures cannot authorize
// paid replay. Exact subscription quota errors can; raw failures survive.
it.each([
  { status: 429, code: "usage_limit_reached", fallback: true },
  { status: 401, code: "invalid_api_key", fallback: false },
  { status: 429, code: "unknown_error", fallback: false },
  { status: 0, code: "network", fallback: false },
])(
  "preserves subscription failures unless funding refused ($code)",
  async ({ status, code, fallback }) => {
    const config = modelConfiguration({}, () => "synthetic-token");
    let calls = 0;
    const fetcher: typeof fetch = async () => {
      calls += 1;
      return calls === 1
        ? Response.json(
            {
              error: {
                type: "invalid_request_error",
                message:
                  "Your credit balance is too low to access the Anthropic API.",
              },
            },
            { status: 400 },
          )
        : Response.json(
            { error: { message: "synthetic paid failure" } },
            { status: 402 },
          );
    };
    const refusal = status
      ? new APICallError({
          message: "synthetic subscription failure",
          url: "https://synthetic.invalid",
          requestBodyValues: undefined,
          statusCode: status,
          responseBody: JSON.stringify({ error: { code } }),
          isRetryable: false,
        })
      : new Error("synthetic subscription failure");
    const subscription = wrapLanguageModel({
      model: createOpenAI({ apiKey: "synthetic" }).responses(QUALITY_MODEL),
      middleware: {
        wrapGenerate: async () => {
          throw refusal;
        },
      },
    });
    const pending = generateText({
      model: testerArmyModel(config, fetcher, subscription),
      prompt: "Synthetic readback",
      maxRetries: 0,
    });
    const failure = await pending.then(
      () => null,
      (error) => error,
    );
    const actual = fallback ? failure?.message : failure;
    const paidFailure = expect.stringContaining("synthetic paid failure");
    const expected = fallback ? paidFailure : refusal;
    expect(actual).toEqual(expected);
    expect(calls).toBe(fallback ? 2 : 1);
  },
);

// A funded image/tool call must complete on Opus without touching OAuth or
// paid billing. The SDK must encode the image and decode the tool result.
it("keeps successful image and tool inference on native Anthropic", async () => {
  const config = modelConfiguration({}, () => "synthetic-token");
  let calls = 0;
  const fetcher: typeof fetch = async (input, init) => {
    calls += 1;
    const request = new Request(input, init);
    const body = await request.json();
    expect(body.model).toBe(AUDIT_RECOVERY_MODEL);
    expect(body.messages[0].content).toContainEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "c3ludGhldGlj" },
    });
    expect(body.tools[0].name).toBe("ready");
    return Response.json({
      id: "synthetic-message",
      type: "message",
      role: "assistant",
      model: AUDIT_RECOVERY_MODEL,
      content: [
        {
          type: "tool_use",
          id: "synthetic-call",
          name: "ready",
          input: { supported: true },
        },
      ],
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: { input_tokens: 12, output_tokens: 3 },
    });
  };
  const subscription = wrapLanguageModel({
    model: createOpenAI({ apiKey: "synthetic" }).responses(QUALITY_MODEL),
    middleware: {
      wrapGenerate: async () => {
        throw new Error("Subscription must not be called");
      },
    },
  });
  const response = await generateText({
    model: testerArmyModel(config, fetcher, subscription),
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            image: Buffer.from("synthetic"),
            mediaType: "image/png",
          },
        ],
      },
    ],
    tools: { ready: { inputSchema: z.object({ supported: z.boolean() }) } },
    maxRetries: 0,
  });
  expect(response.toolCalls[0]).toMatchObject({
    toolName: "ready",
    input: { supported: true },
  });
  expect(calls).toBe(1);
});

// The actual OAuth adapter folds SSE quota errors into HTTP 400. Failed
// partial output must be discarded before the paid SDK response is returned.
it.each([false, true])(
  "uses the owned OAuth adapter before paid billing (quota=%s)",
  async (quota) => {
    vi.stubEnv(
      "E2E_OAUTH_CREDENTIALS",
      JSON.stringify({
        openai: {
          access: "synthetic-access",
          refresh: "synthetic-refresh",
          expires: 0,
        },
      }),
    );
    const response = {
      id: "synthetic-response",
      object: "response",
      created_at: 0,
      status: "completed",
      model: QUALITY_MODEL,
      output: [
        {
          type: "message",
          id: "synthetic-message",
          role: "assistant",
          status: "completed",
          content: [
            {
              type: "output_text",
              text: "Synthetic complete",
              annotations: [],
            },
          ],
        },
      ],
      usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
    };
    let subscriptionCalls = 0;
    vi.stubGlobal(
      "fetch",
      async (input: RequestInfo | URL, init?: RequestInit) => {
        subscriptionCalls += 1;
        const request = new Request(input, init);
        expect(request.url).toBe(
          "https://chatgpt.com/backend-api/codex/responses",
        );
        expect(request.headers.get("authorization")).toBe(
          "Bearer synthetic-access",
        );
        expect(await request.json()).toMatchObject({
          model: QUALITY_MODEL,
          store: false,
          stream: true,
        });
        return quota
          ? new Response(
              'data: {"type":"response.output_text.delta","delta":"discard this"}\n\ndata: {"type":"response.failed","response":{"error":{"code":"usage_limit_reached","message":"synthetic quota"}}}\n\n',
              { headers: { "content-type": "text/event-stream" } },
            )
          : Response.json(response);
      },
    );
    let gatewayCalls = 0;
    const fetcher: typeof fetch = async () => {
      gatewayCalls += 1;
      return gatewayCalls === 1
        ? Response.json(
            {
              error: {
                type: "invalid_request_error",
                message:
                  "Your credit balance is too low to access the Anthropic API.",
              },
            },
            { status: 400 },
          )
        : Response.json(response);
    };
    const result = await generateText({
      model: testerArmyModel(
        modelConfiguration({}, () => "synthetic-token"),
        fetcher,
      ),
      prompt: "Synthetic readback",
      maxRetries: 0,
    });
    expect(result.text).toBe("Synthetic complete");
    expect(subscriptionCalls).toBe(1);
    expect(gatewayCalls).toBe(quota ? 2 : 1);
  },
);
