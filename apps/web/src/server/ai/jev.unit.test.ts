import { runEntityId } from "@cubby/schemas/identifiers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FIELD_SUGGESTION_FEATURE } from "./features";
import {
  JEV_MAX_CANDIDATES,
  type JevChoiceResponse,
  type JevPort,
  runJevChoice,
} from "./jev";

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
): JevChoiceResponse {
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

function jevFor(choice: string, probabilities: Record<string, number>) {
  const port: JevPort = vi.fn(async () => answerFor(choice, probabilities));
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

describe("runJevChoice", () => {
  it.each(["2", "Tue, 01 Sep 2026 00:00:02 GMT"])(
    "recovers after Retry-After %s without changing the choice request",
    async (retryAfter) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-09-01T00:00:00Z"));
      vi.stubEnv("AI_GATEWAY_API_KEY", "dev-token");
      vi.resetModules();
      const { runJevChoice: request } = await import("./jev");
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
      const { runJevChoice: request } = await import("./jev");
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
    const { runJevChoice: request } = await import("./jev");
    const body = "synthetic provider diagnostic ".repeat(20);
    vi.stubGlobal("fetch", async () => new Response(body, { status: 401 }));
    await expect(request({ ...base, choices: ["one"] })).rejects.toThrow(body);
  });

  // Regression: the gateway-scoped `/ai/run` (REST, and the binding's
  // `AI.run` with `gateway.id`) wraps Jev's answer in a completed-run layer
  // the old `/workers-ai/run/<model>` route did not; an unrecognized wrapper
  // failed every decision as "invalid choice response".
  it("unwraps the gateway run route's completed-run envelope", async () => {
    vi.stubEnv("AI_GATEWAY_API_KEY", "dev-token");
    vi.resetModules();
    const { runJevChoice: request } = await import("./jev");
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

  it("surfaces an unfinished run's state and errors instead of a generic parse failure", async () => {
    vi.stubEnv("AI_GATEWAY_API_KEY", "dev-token");
    vi.resetModules();
    const { runJevChoice: request } = await import("./jev");
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
    const { runJevChoice: request } = await import("./jev");
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
      { length: JEV_MAX_CANDIDATES + 1 },
      (_, i) => `candidate-${i}`,
    );
    const port: JevPort = vi.fn();

    await expect(runJevChoice({ ...base, choices, port })).rejects.toThrow(
      /at most 254/,
    );
    expect(port).not.toHaveBeenCalled();
  });

  it("bounds the input by UTF-8 bytes, not characters", async () => {
    const port: JevPort = vi.fn();

    // 10k four-byte emoji is 10k characters but 40k bytes.
    await expect(
      runJevChoice({
        ...base,
        subject: "🙂".repeat(10_000),
        choices: ["one"],
        port,
      }),
    ).rejects.toThrow(/exceeds/);
    expect(port).not.toHaveBeenCalled();
  });

  it("offers none by default and resolves it to a null index with its confidence", async () => {
    const port = jevFor("none", { c0: 0.2, none: 0.8 });

    const result = await runJevChoice({
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
    const port = jevFor("c1", { c0: 0.1, c1: 0.9 });

    const result = await runJevChoice({
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
      runJevChoice({
        ...base,
        choices: ["red"],
        allowNone: false,
        port: jevFor("none", { c0: 0.1, none: 0.9 }),
      }),
    ).rejects.toThrow(/probability key set/);
  });

  it("ranks every candidate desc by probability, excluding none", async () => {
    const port = jevFor("c2", {
      c0: 0.1,
      c1: 0.25,
      c2: 0.5,
      none: 0.15,
    });

    const result = await runJevChoice({
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

  it("throws Jev failures and invalid distributions instead of answering elsewhere", async () => {
    const failing: JevPort = vi.fn(async () => {
      throw new Error("gateway timeout");
    });
    await expect(
      runJevChoice({ ...base, choices: ["one"], port: failing }),
    ).rejects.toThrow("gateway timeout");

    await expect(
      runJevChoice({
        ...base,
        choices: ["one"],
        port: jevFor("c0", { c0: 0.6, none: 0.1 }),
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
      const { runJevChoice: devRunJevChoice } = await import("./jev");
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

      const result = await devRunJevChoice({
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
      expect(sentBody.options.gateway.id).toBe("cubby");
    },
  );

  it.each([{ answers: {} }, answerFor("c0", { c0: 1.1, none: -0.1 })])(
    "rejects malformed flat Clef answers: %j",
    async (response) => {
      vi.stubEnv("AI_GATEWAY_API_KEY", "dev-token");
      vi.spyOn(Math, "random").mockReturnValue(0.75);
      vi.resetModules();
      const { runJevChoice: request } = await import("./jev");
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
    const { runJevChoice: request } = await import("./jev");
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
    const { runJevChoice: request } = await import("./jev");
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
