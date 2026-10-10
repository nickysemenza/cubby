import { FAST_MODEL } from "@cubby/shared/ai/models";
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

afterEach(() => vi.unstubAllEnvs());

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
])("scopes the driver to cubby as $environment", ({ ci, environment }) => {
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
  expect(config.TESTER_ARMY_MODEL).toBe(`openai/${FAST_MODEL}`);
  expect(testerArmyAgent(config).executor?.name).toBe("decision");
  expect(testerArmyDriverIdentity(config)).toBe(
    `typesafe/jev + openai/${FAST_MODEL}`,
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
