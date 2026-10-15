import { runEntityId } from "@cubby/schemas/identifiers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DECISION_MAX_CANDIDATES,
  type DecisionChoiceResponse,
  type DecisionImage,
  type DecisionPort,
  runDecisionChoice,
} from "./decision-model";
import { FIELD_SUGGESTION_FEATURE } from "./features";

const base = {
  feature: { ...FIELD_SUGGESTION_FEATURE, cache: false },
  subject: "pick one",
  rules: "Choose one.",
  usage: {
    operation: "jev-test",
    cacheStatus: "none" as const,
    runId: runEntityId.parse("00000000-0000-4000-8000-000000000001"),
  },
};

function answerFor(
  choice: string,
  probabilities: Record<string, number>,
): DecisionChoiceResponse {
  return {
    answers: {
      selection: { type: "choice", choice, confidence: 0.7, probabilities },
    },
  };
}

/** The model a REST `/ai/run` request names in its body. */
function sentModel(init: RequestInit | undefined): string {
  return JSON.parse(String(init?.body)).model;
}

function decisionPortFor(
  choice: string,
  probabilities: Record<string, number>,
) {
  const port: DecisionPort = vi.fn(async () =>
    answerFor(choice, probabilities),
  );
  return port;
}

beforeEach(() => {
  vi.spyOn(Math, "random").mockReturnValue(0.25);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("runDecisionChoice", () => {
  it("accepts media beyond the text byte budget and strips dimension metadata", async () => {
    const port = decisionPortFor("c0", { c0: 0.9, none: 0.1 });
    const image = {
      content_type: "image/webp" as const,
      base64: "AAAA".repeat(20_000),
      width: 4000,
      height: 4000,
    };
    await runDecisionChoice({
      ...base,
      choices: ["one"],
      images: [image],
      port,
    });
    expect(port).toHaveBeenCalledWith(
      expect.objectContaining({
        images: [{ content_type: "image/webp", base64: image.base64 }],
      }),
    );
  });

  it.each<{ images: DecisionImage[]; error: RegExp }>([
    { images: Array(5).fill("data:image/png;base64,AAAA"), error: /at most 4/ },
    { images: ["https://example.com/image.png"], error: /embedded/ },
    { images: ["data:image/gif;base64,AAAA"], error: /embedded/ },
    { images: ["data:image/png;base64,AA=A"], error: /invalid base64/ },
    {
      images: [
        {
          content_type: "image/jpeg",
          base64: "AAAA",
          width: 4001,
          height: 4000,
        },
      ],
      error: /16 megapixels/,
    },
    {
      images: [{ content_type: "image/png", base64: "AAAA", width: 1 }],
      error: /both width and height/,
    },
    {
      images: [{ content_type: "image/png", base64: "AAAA".repeat(1_398_102) }],
      error: /4 MiB/,
    },
    {
      images: Array.from({ length: 3 }, () => ({
        content_type: "image/png",
        base64: "AAAA".repeat(1_000_000),
      })),
      error: /8 MiB/,
    },
  ])(
    "rejects invalid media before the model: $error",
    async ({ images, error }) => {
      const port: DecisionPort = vi.fn();
      await expect(
        runDecisionChoice({ ...base, choices: ["one"], images, port }),
      ).rejects.toThrow(error);
      expect(port).not.toHaveBeenCalled();
    },
  );

  // Images must override even a pinned Jev and survive the native gateway envelope.
  it("forces Clef for embedded images instead of a pinned text-only model", async () => {
    vi.stubEnv("AI_GATEWAY_API_KEY", "dev-token");
    vi.resetModules();
    const { runDecisionChoice: request } = await import("./decision-model");
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) =>
      Response.json(answerFor("c0", { c0: 0.9, none: 0.1 })),
    );
    vi.stubGlobal("fetch", fetch);
    const images = ["data:image/png;base64,aGVsbG8="];
    await request({
      ...base,
      choices: ["one"],
      decisionModel: "typesafe/jev",
      images,
    });
    const body = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body));
    expect(body).toMatchObject({
      model: "@cf/cloudflare/clef",
      input: { model: "clef", images },
    });
  });

  it.each(["2", "Tue, 01 Sep 2026 00:00:02 GMT"])(
    "recovers after Retry-After %s without changing the choice request",
    async (retryAfter) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-09-01T00:00:00Z"));
      vi.stubEnv("AI_GATEWAY_API_KEY", "dev-token");
      vi.resetModules();
      const { runDecisionChoice: request } = await import("./decision-model");
      const fetch = vi
        .fn()
        .mockResolvedValueOnce(
          new Response("Wholesale Rate limited", {
            status: 429,
            headers: { "Retry-After": retryAfter },
          }),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              result: answerFor("c0", { c0: 0.9, none: 0.1 }),
            }),
          ),
        );
      vi.stubGlobal("fetch", fetch);
      await Promise.all([
        expect(request({ ...base, choices: ["one"] })).resolves.toMatchObject({
          selectedIndex: 0,
        }),
        (async () => {
          await vi.advanceTimersByTimeAsync(1_999);
          expect(fetch).toHaveBeenCalledTimes(1);
          await vi.runAllTimersAsync();
        })(),
      ]);
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(fetch.mock.calls[0]?.[1].body).toEqual(
        fetch.mock.calls[1]?.[1].body,
      );
    },
  );

  it("keeps a caller-pinned model and omits payload logging when trial sampling would choose Clef", async () => {
    vi.stubEnv("AI_GATEWAY_API_KEY", "dev-token");
    vi.spyOn(Math, "random").mockReturnValue(0.75);
    vi.resetModules();
    const { runDecisionChoice: route } = await import("./decision-model");
    const sent: RequestInit[] = [];
    vi.stubGlobal("fetch", (_url: string, init: RequestInit) => {
      sent.push(init);
      return Promise.resolve(
        new Response(
          JSON.stringify({
            state: "Completed",
            result: answerFor("c0", { c0: 0.95, none: 0.05 }),
          }),
        ),
      );
    });
    await route({
      ...base,
      feature: { ...base.feature, collectPayload: false },
      decisionModel: "typesafe/jev",
      choices: ["purchase-related"],
    });
    expect(sentModel(sent[0])).toBe("typesafe/jev");
    expect(
      new Headers(sent[0]?.headers).get("cf-aig-collect-log-payload"),
    ).toBe("false");
  });

  it.each([
    { status: 429, retryAfter: null, attempts: 3 },
    { status: 429, retryAfter: "invalid", attempts: 3 },
    { status: 429, retryAfter: "60", attempts: 1 },
    { status: 401, retryAfter: null, attempts: 1 },
    { status: 503, retryAfter: null, attempts: 1 },
  ])(
    "bounds retries for $status with Retry-After $retryAfter",
    async ({ status, retryAfter, attempts }) => {
      vi.useFakeTimers();
      vi.stubEnv("AI_GATEWAY_API_KEY", "dev-token");
      vi.resetModules();
      const { runDecisionChoice: request } = await import("./decision-model");
      const fetch = vi.fn(
        async () =>
          new Response("Provider unavailable", {
            status,
            headers:
              retryAfter === null ? undefined : { "Retry-After": retryAfter },
          }),
      );
      vi.stubGlobal("fetch", fetch);
      await Promise.all([
        expect(request({ ...base, choices: ["one"] })).rejects.toThrow(
          FIELD_SUGGESTION_FEATURE.model,
        ),
        vi.runAllTimersAsync(),
      ]);
      expect(fetch).toHaveBeenCalledTimes(attempts);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("preserves the complete provider rejection body", async () => {
    vi.stubEnv("AI_GATEWAY_API_KEY", "dev-token");
    vi.resetModules();
    const { runDecisionChoice: request } = await import("./decision-model");
    const body = "synthetic provider diagnostic ".repeat(20);
    vi.stubGlobal("fetch", async () => new Response(body, { status: 401 }));
    await expect(request({ ...base, choices: ["one"] })).rejects.toThrow(body);
  });

  // Regression: the gateway-scoped `/ai/run` (REST, and the binding's
  // `AI.run` with `gateway.id`) wraps the decision model's answer in a completed-run layer
  // the old `/workers-ai/run/<model>` route did not; an unrecognized wrapper
  // failed every decision as "invalid choice response".
  it("unwraps the gateway run route's completed-run envelope", async () => {
    vi.stubEnv("AI_GATEWAY_API_KEY", "dev-token");
    vi.resetModules();
    const { runDecisionChoice: request } = await import("./decision-model");
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          JSON.stringify({
            result: {
              state: "Completed",
              result: {
                model: "jev-synthetic",
                ...answerFor("c0", { c0: 0.9, none: 0.1 }),
                usage: { input_tokens: 300, output_tokens: 30 },
              },
            },
            success: true,
            errors: [],
            messages: [],
          }),
        ),
    );
    await expect(request({ ...base, choices: ["one"] })).resolves.toMatchObject(
      { selectedIndex: 0, probability: 0.9 },
    );
  });

  // An uncacheable decision must say so: omitting the flag leaves the
  // gateway's own cache policy free to replay a stale choice.
  it("asks the gateway to skip its cache for an uncacheable decision", async () => {
    vi.stubEnv("AI_GATEWAY_API_KEY", "dev-token");
    vi.resetModules();
    const { runDecisionChoice: request } = await import("./decision-model");
    const fetch = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(
          JSON.stringify({ result: answerFor("c0", { c0: 0.9, none: 0.1 }) }),
        ),
    );
    vi.stubGlobal("fetch", fetch);
    await request({ ...base, choices: ["one"] });
    const headers = new Headers(fetch.mock.calls[0]?.[1]?.headers);
    expect(headers.get("cf-aig-skip-cache")).toBe("true");
  });

  it("surfaces an unfinished run's state and errors instead of a generic parse failure", async () => {
    vi.stubEnv("AI_GATEWAY_API_KEY", "dev-token");
    vi.resetModules();
    const { runDecisionChoice: request } = await import("./decision-model");
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          JSON.stringify({
            result: { state: "Failed" },
            success: false,
            errors: [{ code: 5000, message: "synthetic run failure" }],
            messages: [],
          }),
        ),
    );
    const failure = request({ ...base, choices: ["one"] });
    await expect(failure).rejects.toThrow(/Failed/);
    await expect(failure).rejects.toThrow(/synthetic run failure/);
  });

  it("aborts a stalled gateway request at the overall deadline", async () => {
    vi.useFakeTimers();
    vi.stubEnv("AI_GATEWAY_API_KEY", "dev-token");
    vi.resetModules();
    const { runDecisionChoice: request } = await import("./decision-model");
    const fetch = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason),
            { once: true },
          );
        }),
    );
    vi.stubGlobal("fetch", fetch);
    await Promise.all([
      expect(request({ ...base, choices: ["one"] })).rejects.toThrow(
        "30-second deadline",
      ),
      vi.advanceTimersByTimeAsync(30_000),
    ]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("throws on a roster beyond the choice limit instead of truncating it", async () => {
    const choices = Array.from(
      { length: DECISION_MAX_CANDIDATES + 1 },
      (_, i) => `candidate-${i}`,
    );
    const port: DecisionPort = vi.fn();

    await expect(runDecisionChoice({ ...base, choices, port })).rejects.toThrow(
      /at most 254/,
    );
    expect(port).not.toHaveBeenCalled();
  });

  it("bounds the input by UTF-8 bytes, not characters", async () => {
    const port: DecisionPort = vi.fn();

    // 10k four-byte emoji is 10k characters but 40k bytes.
    await expect(
      runDecisionChoice({
        ...base,
        subject: "🙂".repeat(10_000),
        choices: ["one"],
        port,
      }),
    ).rejects.toThrow(/exceeds/);
    expect(port).not.toHaveBeenCalled();
  });

  it("offers none by default and resolves it to a null index with its confidence", async () => {
    const port = decisionPortFor("none", { c0: 0.2, none: 0.8 });

    const result = await runDecisionChoice({
      ...base,
      choices: ["a product"],
      port,
    });

    expect(port).toHaveBeenCalledWith(
      expect.objectContaining({
        questions: {
          selection: expect.objectContaining({
            criteria: { c0: "a product", none: expect.any(String) },
          }),
        },
      }),
    );
    expect(result).toEqual({
      selectedIndex: null,
      confidence: "medium",
      probability: 0.8,
      ranked: [{ index: 0, probability: 0.2 }],
    });
  });

  it("omits none for an exhaustive vocabulary and rejects a none answer", async () => {
    const port = decisionPortFor("c1", { c0: 0.1, c1: 0.9 });

    const result = await runDecisionChoice({
      ...base,
      choices: ["red", "blue"],
      allowNone: false,
      port,
    });

    expect(port).toHaveBeenCalledWith(
      expect.objectContaining({
        questions: {
          selection: expect.objectContaining({
            criteria: { c0: "red", c1: "blue" },
          }),
        },
      }),
    );
    expect(result).toEqual({
      selectedIndex: 1,
      confidence: "high",
      probability: 0.9,
      ranked: [
        { index: 1, probability: 0.9 },
        { index: 0, probability: 0.1 },
      ],
    });

    await expect(
      runDecisionChoice({
        ...base,
        choices: ["red"],
        allowNone: false,
        port: decisionPortFor("none", { c0: 0.1, none: 0.9 }),
      }),
    ).rejects.toThrow(/probability key set/);
  });

  it("ranks every candidate desc by probability, excluding none", async () => {
    const port = decisionPortFor("c2", {
      c0: 0.1,
      c1: 0.25,
      c2: 0.5,
      none: 0.15,
    });

    const result = await runDecisionChoice({
      ...base,
      choices: ["a", "b", "c"],
      port,
    });

    expect(result.ranked).toEqual([
      { index: 2, probability: 0.5 },
      { index: 1, probability: 0.25 },
      { index: 0, probability: 0.1 },
    ]);
  });

  it("throws decision failures and invalid distributions instead of answering elsewhere", async () => {
    const failing: DecisionPort = vi.fn(async () => {
      throw new Error("gateway timeout");
    });
    await expect(
      runDecisionChoice({ ...base, choices: ["one"], port: failing }),
    ).rejects.toThrow("gateway timeout");

    await expect(
      runDecisionChoice({
        ...base,
        choices: ["one"],
        port: decisionPortFor("c0", { c0: 0.6, none: 0.1 }),
      }),
    ).rejects.toThrow("do not normalize");
  });

  it.each([
    { random: 0.25, model: "typesafe/jev", selector: undefined },
    { random: 0.75, model: "@cf/cloudflare/clef", selector: "clef" },
  ])(
    "posts the selected $model to the gateway-scoped run route",
    async ({ random, model, selector }) => {
      // Jev wraps its answer in a completed run; Clef returns it directly.
      vi.stubEnv("AI_GATEWAY_API_KEY", "dev-token");
      vi.spyOn(Math, "random").mockReturnValue(random);
      vi.resetModules();
      const { runDecisionChoice: devRunDecisionChoice } =
        await import("./decision-model");
      const sent: { url: string; init: RequestInit | undefined }[] = [];
      vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
        sent.push({ url: String(url), init });
        return Promise.resolve(
          new Response(
            JSON.stringify(
              selector
                ? answerFor("c0", { c0: 0.9, c1: 0.05, none: 0.05 })
                : {
                    state: "Completed",
                    result: answerFor("c0", { c0: 0.9, c1: 0.05, none: 0.05 }),
                  },
            ),
          ),
        );
      });

      const result = await devRunDecisionChoice({
        ...base,
        subject: "pick red",
        choices: ["red", "blue"],
      });

      expect(result).toEqual({
        selectedIndex: 0,
        confidence: "high",
        probability: 0.9,
        ranked: [
          { index: 0, probability: 0.9 },
          { index: 1, probability: 0.05 },
        ],
      });
      const [call] = sent;
      expect(call?.url).toMatch(/\/ai\/run$/);
      expect(new Headers(call?.init?.headers).get("authorization")).toBe(
        "Bearer dev-token",
      );
      const sentBody = JSON.parse(String(call?.init?.body));
      expect(sentBody.model).toBe(model);
      expect(sentBody.input).toMatchObject({ state: "pick red" });
      expect(sentBody.input.model).toBe(selector);
      expect(new Headers(call?.init?.headers).get("cf-aig-gateway-id")).toBe(
        "cubby-testing",
      );
      expect(sentBody).not.toHaveProperty("options.gateway");
    },
  );

  it.each([{ answers: {} }, answerFor("c0", { c0: 1.1, none: -0.1 })])(
    "rejects malformed flat Clef answers: %j",
    async (response) => {
      vi.stubEnv("AI_GATEWAY_API_KEY", "dev-token");
      vi.spyOn(Math, "random").mockReturnValue(0.75);
      vi.resetModules();
      const { runDecisionChoice: request } = await import("./decision-model");
      vi.stubGlobal("fetch", async () => Response.json(response));
      await expect(request({ ...base, choices: ["one"] })).rejects.toThrow(
        "Decision model returned an invalid choice response.",
      );
    },
  );

  it("keeps Clef selected through a throttled retry even when the next coin flip changes", async () => {
    vi.useFakeTimers();
    vi.stubEnv("AI_GATEWAY_API_KEY", "dev-token");
    const random = vi.spyOn(Math, "random").mockReturnValue(0.75);
    vi.resetModules();
    const { runDecisionChoice: request } = await import("./decision-model");
    const sent: string[] = [];
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      sent.push(sentModel(init));
      random.mockReturnValue(0.25);
      return sent.length === 1
        ? new Response("Rate limited", { status: 429 })
        : Response.json(answerFor("c0", { c0: 0.9, none: 0.1 }));
    });
    await Promise.all([
      expect(request({ ...base, choices: ["one"] })).resolves.toMatchObject({
        selectedIndex: 0,
      }),
      vi.runAllTimersAsync(),
    ]);
    expect(sent).toHaveLength(2);
    expect(sent).toEqual(["@cf/cloudflare/clef", "@cf/cloudflare/clef"]);
  });

  it("isolates and reuses each model's cached choice for the same input", async () => {
    vi.stubEnv("AI_GATEWAY_API_KEY", "dev-token");
    const random = vi.spyOn(Math, "random").mockReturnValue(0.25);
    vi.resetModules();
    const { runDecisionChoice: request } = await import("./decision-model");
    const sent: string[] = [];
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      sent.push(sentModel(init));
      const clef = sentModel(init) === "@cf/cloudflare/clef";
      return Response.json(
        clef
          ? answerFor("c1", { c0: 0.05, c1: 0.9, none: 0.05 })
          : { result: answerFor("c0", { c0: 0.9, c1: 0.05, none: 0.05 }) },
      );
    });
    const input = {
      ...base,
      feature: FIELD_SUGGESTION_FEATURE,
      subject: `synthetic cache trial ${crypto.randomUUID()}`,
      choices: ["red", "blue"],
    };
    expect((await request(input)).selectedIndex).toBe(0);
    random.mockReturnValue(0.75);
    expect((await request(input)).selectedIndex).toBe(1);
    random.mockReturnValue(0.25);
    expect((await request(input)).selectedIndex).toBe(0);
    random.mockReturnValue(0.75);
    expect((await request(input)).selectedIndex).toBe(1);
    expect(sent).toHaveLength(2);
  });
});

describe("runDecisionChoices", () => {
  it("batches cold questions, maps answers by id, and retains individual cache entries", async () => {
    vi.stubEnv("AI_GATEWAY_API_KEY", "dev-token");
    vi.resetModules();
    const { runDecisionChoice, runDecisionChoices } =
      await import("./decision-model");
    const tokenCounts: number[] = [];
    const requests: {
      state: string;
      questions: Record<string, { criteria: Record<string, string> }>;
    }[] = [];
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      const input = JSON.parse(String(init?.body)).input;
      requests.push(input);
      return Response.json({
        result: {
          usage: { input_tokens: 9, output_tokens: 2 },
          answers: Object.fromEntries(
            Object.keys(input.questions)
              .reverse()
              .map((id, index) => [
                id,
                {
                  type: "choice",
                  choice: index === 0 ? "c1" : "c0",
                  confidence: 0.9,
                  probabilities:
                    index === 0 ? { c0: 0.1, c1: 0.9 } : { c0: 0.9, c1: 0.1 },
                },
              ]),
          ),
        },
      });
    });
    const inputs = ["first", "second"].map((label) => ({
      ...base,
      feature: FIELD_SUGGESTION_FEATURE,
      subject: `synthetic ${label} ${crypto.randomUUID()}`,
      choices: ["red", "blue"],
      allowNone: false,
      onTokenUsage: (usage: { inputTokens: number | null }) =>
        tokenCounts.push(usage.inputTokens ?? 0),
    }));
    const results = await runDecisionChoices(inputs);
    expect(requests).toHaveLength(1);
    expect(Object.keys(requests[0]!.questions)).toHaveLength(2);
    expect(results.map((result) => result.selectedIndex)).toEqual([0, 1]);
    expect(tokenCounts.reduce((sum, count) => sum + count, 0)).toBe(9);
    expect(await runDecisionChoice(inputs[1]!)).toEqual(results[1]);
    expect(await runDecisionChoices([inputs[1]!, inputs[0]!])).toEqual([
      results[1],
      results[0],
    ]);
    expect(requests).toHaveLength(1);
  });

  it("splits at the context bound without dropping questions", async () => {
    vi.stubEnv("AI_GATEWAY_API_KEY", "dev-token");
    vi.resetModules();
    const { runDecisionChoices } = await import("./decision-model");
    let count = 0;
    let calls = 0;
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      const input = JSON.parse(String(init?.body)).input;
      expect(
        new TextEncoder().encode(JSON.stringify(input)).byteLength,
      ).toBeLessThanOrEqual(32_000);
      calls++;
      count += Object.keys(input.questions).length;
      return Response.json({
        result: {
          answers: Object.fromEntries(
            Object.keys(input.questions).map((id) => [
              id,
              {
                type: "choice",
                choice: "c0",
                confidence: 1,
                probabilities: { c0: 1 },
              },
            ]),
          ),
        },
      });
    });
    const results = await runDecisionChoices(
      Array.from({ length: 5 }, (_, i) => ({
        ...base,
        subject: `${i} ${"x".repeat(12_000)}`,
        choices: ["one"],
        allowNone: false,
      })),
    );
    expect(results).toHaveLength(5);
    expect(count).toBe(5);
    expect(calls).toBe(3);
  });

  it("coalesces duplicate cold questions without a cache-lease deadlock", async () => {
    vi.stubEnv("AI_GATEWAY_API_KEY", "dev-token");
    vi.resetModules();
    const { runDecisionChoices } = await import("./decision-model");
    const fetch = vi.fn(async () =>
      Response.json({ result: answerFor("c0", { c0: 1 }) }),
    );
    vi.stubGlobal("fetch", fetch);
    const input = {
      ...base,
      feature: FIELD_SUGGESTION_FEATURE,
      subject: `synthetic duplicate ${crypto.randomUUID()}`,
      choices: ["one"],
      allowNone: false,
    };
    const result = await runDecisionChoices([input, input]);
    expect(result[0]).toEqual(result[1]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects incomplete batch answers and releases claims for a retry", async () => {
    vi.stubEnv("AI_GATEWAY_API_KEY", "dev-token");
    vi.resetModules();
    const { runDecisionChoices } = await import("./decision-model");
    const inputs = ["left", "right"].map((label) => ({
      ...base,
      feature: FIELD_SUGGESTION_FEATURE,
      subject: `${label} ${crypto.randomUUID()}`,
      choices: ["one"],
      allowNone: false,
    }));
    vi.stubGlobal("fetch", async () =>
      Response.json({ result: answerFor("c0", { c0: 1 }) }),
    );
    await expect(runDecisionChoices(inputs)).rejects.toThrow(/question/);
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      const input = JSON.parse(String(init?.body)).input;
      return Response.json({
        answers: Object.fromEntries(
          Object.keys(input.questions).map((id) => [
            id,
            {
              type: "choice",
              choice: "c0",
              confidence: 1,
              probabilities: { c0: 1 },
            },
          ]),
        ),
      });
    });
    expect(
      (await runDecisionChoices(inputs)).map((result) => result.selectedIndex),
    ).toEqual([0, 0]);
  });

  it("bounds question counts and keeps sampled models in separate requests", async () => {
    vi.stubEnv("AI_GATEWAY_API_KEY", "dev-token");
    vi.resetModules();
    const { runDecisionChoices } = await import("./decision-model");
    const requests: { model: string; count: number }[] = [];
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      const { model, input } = JSON.parse(String(init?.body));
      const ids = Object.keys(input.questions);
      requests.push({ model, count: ids.length });
      return Response.json({
        answers: Object.fromEntries(
          ids.map((id) => [
            id,
            {
              type: "choice",
              choice: "c0",
              confidence: 1,
              probabilities: { c0: 1 },
            },
          ]),
        ),
      });
    });
    const inputs = Array.from({ length: 66 }, (_, index) => ({
      ...base,
      subject: `synthetic item ${index}`,
      choices: ["one"],
      allowNone: false,
      decisionModel:
        index === 65
          ? ("@cf/cloudflare/clef" as const)
          : ("typesafe/jev" as const),
    }));
    expect(await runDecisionChoices(inputs)).toHaveLength(66);
    expect(
      requests
        .filter(({ model }) => model === "typesafe/jev")
        .map(({ count }) => count),
    ).toEqual([64, 1]);
    expect(
      requests
        .filter(({ model }) => model === "@cf/cloudflare/clef")
        .map(({ count }) => count),
    ).toEqual([1]);
  });
});

describe("shared-image decision batches", () => {
  it("sends shared media once, preserves vision routing and reuses individual cache entries", async () => {
    vi.stubEnv("AI_GATEWAY_API_KEY", "dev-token");
    vi.resetModules();
    const { runDecisionChoice, runDecisionChoices } =
      await import("./decision-model");
    const base64 = "AAAA".repeat(20_000);
    let count = 0;
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      count++;
      const { model, input } = JSON.parse(String(init?.body));
      expect(model).toBe("@cf/cloudflare/clef");
      expect(input.images).toEqual([{ content_type: "image/png", base64 }]);
      expect(Object.keys(input.questions)).toHaveLength(2);
      return Response.json({
        answers: Object.fromEntries(
          Object.keys(input.questions).map((id) => [
            id,
            {
              type: "choice",
              choice: "c0",
              confidence: 0.9,
              probabilities: { c0: 0.9, none: 0.1 },
            },
          ]),
        ),
      });
    });
    const inputs = ["composition", "scope"].map((subject) => ({
      ...base,
      subject: `synthetic ${subject} ${crypto.randomUUID()}`,
      feature: FIELD_SUGGESTION_FEATURE,
      choices: ["one"],
      decisionModel: "typesafe/jev" as const,
      images: [{ content_type: "image/png" as const, base64 }],
    }));
    const results = await runDecisionChoices(inputs);
    expect(count).toBe(1);
    expect(await runDecisionChoice(inputs[1]!)).toEqual(results[1]);
    expect(count).toBe(1);
  });

  it("keeps different media and text questions in separate requests", async () => {
    vi.stubEnv("AI_GATEWAY_API_KEY", "dev-token");
    vi.resetModules();
    const { runDecisionChoices } = await import("./decision-model");
    const media: unknown[] = [];
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      const { input } = JSON.parse(String(init?.body));
      media.push(input.images ?? null);
      return Response.json({
        answers: Object.fromEntries(
          Object.keys(input.questions).map((id) => [
            id,
            {
              type: "choice",
              choice: "c0",
              confidence: 0.9,
              probabilities: { c0: 0.9, none: 0.1 },
            },
          ]),
        ),
      });
    });
    const make = (subject: string) => ({
      ...base,
      subject,
      choices: ["one"],
      decisionModel: "@cf/cloudflare/clef" as const,
    });
    const results = await runDecisionChoices([
      { ...make("first"), images: ["data:image/png;base64,AAAA"] },
      { ...make("second"), images: ["data:image/png;base64,AQAA"] },
      make("text"),
    ]);
    expect(results).toHaveLength(3);
    expect(media).toHaveLength(3);
    expect(media).toContainEqual(["data:image/png;base64,AAAA"]);
    expect(media).toContainEqual(["data:image/png;base64,AQAA"]);
    expect(media).toContainEqual(null);
  });
});
