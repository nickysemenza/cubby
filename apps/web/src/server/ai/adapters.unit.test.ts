import { FAST_MODEL } from "@cubby/shared/ai/models";
import { afterEach, describe, expect, it, vi } from "vitest";

import { chatCompletionOptionsFor, piCallTarget } from "./adapters";

// Constructing a call target must never need a gateway: the shim resolves
// the binding per request, and dev has none.
afterEach(() => {
  vi.unstubAllEnvs();
});

const opts = { metadata: { feature: "test", operation: "adapter.routing" } };

describe("piCallTarget resolves the declared model and gateway provider", () => {
  it("sends the fast tier to OpenAI's Responses API", () => {
    const target = piCallTarget(FAST_MODEL, opts);
    expect(target.model.provider).toBe("openai");
    expect(target.model.id).toBe(FAST_MODEL);
  });

  it("routes Anthropic models to the anthropic provider", () => {
    expect(piCallTarget("claude-haiku-5-5", opts).model.provider).toBe(
      "anthropic",
    );
  });
});

describe("chatCompletionOptionsFor", () => {
  it("never emits sampling parameters for Anthropic (Sonnet rejects them)", () => {
    const options = chatCompletionOptionsFor(
      "claude-sonnet-5-5",
      { maxTokens: 4000, effort: "low" },
      "respond",
    );
    expect(options).toEqual({
      maxTokens: 4000,
      thinkingEnabled: true,
      effort: "low",
      toolChoice: "auto",
    });
    expect(options).not.toHaveProperty("temperature");
    expect(options).not.toHaveProperty("top_p");
    expect(options).not.toHaveProperty("top_k");
    expect(
      chatCompletionOptionsFor(
        "claude-sonnet-5-5",
        { maxTokens: 300 },
        "respond",
      ),
    ).not.toHaveProperty("effort");
  });

  // Haiku 5.5 400s on a forced tool or a thinking budget; only adaptive
  // thinking with effort is accepted.
  it.each(["claude-haiku-5-5", "claude-sonnet-5-5"] as const)(
    "sends %s adaptive thinking with effort and an unforced tool",
    (model) => {
      expect(
        chatCompletionOptionsFor(
          model,
          { maxTokens: 300, effort: "low" },
          "respond",
        ),
      ).toEqual({
        maxTokens: 300,
        thinkingEnabled: true,
        effort: "low",
        toolChoice: "auto",
      });
    },
  );

  it("caps Luna's visible plus reasoning output and forces the named function tool", () => {
    expect(
      chatCompletionOptionsFor(
        FAST_MODEL,
        { maxTokens: 500, effort: "none" },
        "respond",
      ),
    ).toEqual({
      maxTokens: 500,
      reasoningEffort: "none",
      toolChoice: { type: "function", name: "respond" },
    });
  });
});
