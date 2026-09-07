import { describe, expect, it, vi } from "vitest";

import {
  COOKBOOK_ESCALATION_MODEL,
  DEFAULT_CHAT_MODEL,
} from "~/server/ai/models";

import { extractCookbookChunk, type CookbookLlmPort } from "./cookbook-llm";

const request = {
  system: "Extract recipes",
  user: "Chapter text",
  toolName: "return_recipes",
  toolSchema: {
    type: "object",
    properties: { recipes: { type: "array", items: { type: "object" } } },
    required: ["recipes"],
  },
};

const usage = {
  input_tokens: 120,
  output_tokens: 34,
  cache_creation_input_tokens: 80,
  cache_read_input_tokens: 20,
};

type ProviderContent = Array<{
  type: string;
  name?: string;
  input?: null | boolean | number | string | object;
}>;

function providerResponse(
  content: ProviderContent,
  stopReason: string | null = "end_turn",
) {
  return new Response(
    JSON.stringify({ content, stop_reason: stopReason, usage }),
  );
}

function providerResponseWithoutContent(stopReason: string) {
  return new Response(JSON.stringify({ stop_reason: stopReason, usage }));
}

function recipeToolUse(recipes: object[]): ProviderContent {
  return [
    {
      type: "tool_use",
      name: request.toolName,
      input: { recipes },
    },
  ];
}

describe("extractCookbookChunk", () => {
  it("returns forced-tool input with raw usage and server-owned settings", async () => {
    const requestProvider = vi.fn(() =>
      Promise.resolve(providerResponse(recipeToolUse([{ name: "Soup" }]))),
    );

    await expect(
      extractCookbookChunk(request, undefined, { request: requestProvider }),
    ).resolves.toEqual({
      input: { recipes: [{ name: "Soup" }] },
      usage,
      truncated: false,
    });
    expect(requestProvider).toHaveBeenCalledWith(
      {
        model: DEFAULT_CHAT_MODEL,
        max_tokens: 16_000,
        system: [
          {
            type: "text",
            text: request.system,
            cache_control: { type: "ephemeral" },
          },
        ],
        messages: [{ role: "user", content: request.user }],
        tools: [
          {
            name: request.toolName,
            description: "Return the recipes extracted from this EPUB chunk.",
            input_schema: request.toolSchema,
          },
        ],
        tool_choice: { type: "tool", name: request.toolName },
      },
      expect.any(AbortSignal),
    );
  });

  it.each([
    ["null", [{ type: "tool_use", name: request.toolName, input: null }]],
    ["an array", [{ type: "tool_use", name: request.toolName, input: [] }]],
    [
      "an empty object",
      [{ type: "tool_use", name: request.toolName, input: {} }],
    ],
    [
      "a non-array recipes field",
      [{ type: "tool_use", name: request.toolName, input: { recipes: null } }],
    ],
    [
      "the wrong tool",
      [{ type: "tool_use", name: "other", input: { recipes: [] } }],
    ],
  ])("makes %s an explicit payload failure", async (_label, content) => {
    const ai: CookbookLlmPort = {
      request: () => Promise.resolve(providerResponse(content)),
    };

    const result = await extractCookbookChunk(request, undefined, ai);

    expect(result).toMatchObject({
      input: null,
      usage,
      truncated: false,
      error: { kind: "payload" },
    });
  });

  it("makes malformed provider JSON an explicit payload failure", async () => {
    const ai: CookbookLlmPort = {
      request: () => Promise.resolve(new Response("not JSON")),
    };

    await expect(extractCookbookChunk(request, undefined, ai)).resolves.toEqual(
      {
        input: null,
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
        truncated: false,
        error: {
          message: "Cookbook extraction returned invalid JSON (HTTP 200)",
          kind: "payload",
        },
      },
    );
  });

  it("preserves valid input and usage when the provider reports truncation", async () => {
    const ai: CookbookLlmPort = {
      request: () =>
        Promise.resolve(
          providerResponse(recipeToolUse([{ name: "Soup" }]), "max_tokens"),
        ),
    };

    await expect(extractCookbookChunk(request, undefined, ai)).resolves.toEqual(
      {
        input: { recipes: [{ name: "Soup" }] },
        usage,
        truncated: true,
      },
    );
  });

  it("keeps usage and truncation when partial tool input is malformed", async () => {
    const ai: CookbookLlmPort = {
      request: () =>
        Promise.resolve(
          providerResponse(
            [{ type: "tool_use", name: request.toolName, input: {} }],
            "max_tokens",
          ),
        ),
    };

    const result = await extractCookbookChunk(request, undefined, ai);

    expect(result).toMatchObject({
      input: null,
      usage,
      truncated: true,
      error: { kind: "payload" },
    });
  });

  it("keeps usage and truncation when provider content is absent", async () => {
    const ai: CookbookLlmPort = {
      request: () =>
        Promise.resolve(providerResponseWithoutContent("max_tokens")),
    };

    const result = await extractCookbookChunk(request, undefined, ai);

    expect(result).toMatchObject({
      input: null,
      usage,
      truncated: true,
      error: { kind: "payload" },
    });
  });

  it("classifies network failures for the TypeScript transport retry", async () => {
    const ai: CookbookLlmPort = {
      request: () => Promise.reject(new TypeError("connection reset")),
    };

    const result = await extractCookbookChunk(request, undefined, ai);

    expect(result).toMatchObject({
      input: null,
      truncated: false,
      error: { message: "connection reset", kind: "transport" },
    });
  });

  it("selects the server-owned escalation model", async () => {
    const requestProvider = vi.fn(() =>
      Promise.resolve(providerResponse(recipeToolUse([]))),
    );

    await extractCookbookChunk({ ...request, escalate: true }, undefined, {
      request: requestProvider,
    });

    expect(requestProvider).toHaveBeenCalledWith(
      expect.objectContaining({ model: COOKBOOK_ESCALATION_MODEL }),
      expect.any(AbortSignal),
    );
  });
});
