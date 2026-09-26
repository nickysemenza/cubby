import { runEntityId } from "@cubby/schemas/identifiers";
import { afterEach, describe, expect, it, vi } from "vitest";

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

function jevFor(choice: string, probabilities: Record<string, number>) {
  const port: JevPort = vi.fn(async () => answerFor(choice, probabilities));
  return port;
}

afterEach(() => {
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
          `Jev request failed (${status})`,
        ),
        vi.runAllTimersAsync(),
      ]);
      expect(fetch).toHaveBeenCalledTimes(attempts);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

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

  it("posts the input to the gateway's Workers AI run route and unwraps its envelope", async () => {
    // The route is `workers-ai/run/<model>`, not `workers-ai/<model>` (which
    // the gateway rejects with "no route"), and the answer comes back under
    // `result` — both verified against the live gateway on 2026-09-18.
    vi.stubEnv("AI_GATEWAY_API_KEY", "dev-token");
    vi.resetModules();
    const { runJevChoice: devRunJevChoice } = await import("./jev");
    const sent: { url: string; init: RequestInit | undefined }[] = [];
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
      sent.push({ url: String(url), init });
      return Promise.resolve(
        new Response(
          JSON.stringify({
            state: "Completed",
            result: answerFor("c0", { c0: 0.9, c1: 0.05, none: 0.05 }),
            gatewayMetadata: { keySource: "Unified" },
          }),
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
    expect(call?.url).toBe(
      "https://gateway.ai.cloudflare.com/v1/9f10f078d35d86c78dedece2300a6b88/cubby/workers-ai/run/typesafe/jev",
    );
    expect(new Headers(call?.init?.headers).get("cf-aig-authorization")).toBe(
      "Bearer dev-token",
    );
    expect(JSON.parse(String(call?.init?.body))).toMatchObject({
      state: "pick red",
    });
  });
});
