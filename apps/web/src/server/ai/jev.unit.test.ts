import { afterEach, describe, expect, it, vi } from "vitest";

import { LOCATION_SUGGESTION_FEATURE } from "./features";
import {
  JEV_MAX_CANDIDATES,
  type JevChoiceResponse,
  type JevPort,
  runJevChoice,
} from "./jev";

const base = {
  feature: LOCATION_SUGGESTION_FEATURE,
  subject: "pick one",
  rules: "Choose one.",
  usage: { operation: "jev-test", cacheStatus: "none" as const },
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
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("runJevChoice", () => {
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
    expect(result).toEqual({ selectedIndex: null, confidence: "medium" });
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
    expect(result).toEqual({ selectedIndex: 1, confidence: "high" });

    await expect(
      runJevChoice({
        ...base,
        choices: ["red"],
        allowNone: false,
        port: jevFor("none", { c0: 0.1, none: 0.9 }),
      }),
    ).rejects.toThrow(/probability key set/);
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

    expect(result).toEqual({ selectedIndex: 0, confidence: "high" });
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
