import {
  type AdapterYieldChunk,
  type AnyTextAdapter,
  chat,
  type StreamChunk,
} from "@tanstack/ai";
import { createAnthropicChat } from "@tanstack/ai-anthropic";
import { EventType } from "@tanstack/ai/client";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { surfaceStructuredOutputRunErrors } from "./structured-output-adapter";

function streamOf(...chunks: StreamChunk[]): AsyncIterable<StreamChunk> {
  return {
    async *[Symbol.asyncIterator]() {
      yield* chunks;
    },
  };
}

function fakeAdapter(
  chatChunks: StreamChunk[],
  structuredChunks?: StreamChunk[],
  structuredOutputImpl?: AnyTextAdapter["structuredOutput"],
): AnyTextAdapter {
  return {
    kind: "text",
    name: "test",
    model: "test-model",
    "~types": {
      providerOptions: {},
      inputModalities: [],
      messageMetadataByModality: {},
      toolCapabilities: [],
      toolCallMetadata: {},
      systemPromptMetadata: {},
    },
    chatStream: () => streamOf(...chatChunks),
    structuredOutput:
      structuredOutputImpl ?? (async () => ({ data: {}, rawText: "{}" })),
    structuredOutputStream: structuredChunks
      ? () => streamOf(...structuredChunks)
      : undefined,
  };
}

const chatOptions: Parameters<AnyTextAdapter["chatStream"]>[0] = Object.assign(
  Object.create(null),
  {
    model: "test-model",
    messages: [],
  },
);
const structuredOutputOptions = {
  chatOptions,
  outputSchema: { type: "object" },
} satisfies Parameters<
  NonNullable<AnyTextAdapter["structuredOutputStream"]>
>[0];

async function collect(stream: AsyncIterable<AdapterYieldChunk>) {
  const chunks: AdapterYieldChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

describe("surfaceStructuredOutputRunErrors", () => {
  it("preserves class adapter methods through structured generation", async () => {
    const provider = createAnthropicChat("claude-opus-4-1", "test-key", {
      fetch: () =>
        Promise.resolve(
          Response.json({
            id: "msg_test",
            type: "message",
            role: "assistant",
            model: "claude-opus-4-1",
            content: [
              {
                type: "tool_use",
                id: "tool_test",
                name: "structured_output",
                input: { title: "Test recipe" },
              },
            ],
            stop_reason: "tool_use",
            usage: { input_tokens: 10, output_tokens: 10 },
          }),
        ),
    });
    const adapter = surfaceStructuredOutputRunErrors(provider);

    await expect(
      chat({
        adapter,
        messages: [{ role: "user", content: "Generate a recipe title" }],
        outputSchema: z.object({ title: z.string() }),
      }),
    ).resolves.toEqual({ title: "Test recipe" });
  });

  it("throws the original provider error from the combined chat stream", async () => {
    const runError = {
      type: EventType.RUN_ERROR,
      threadId: "thread",
      runId: "run",
      message: "400 invalid_request_error: schema keyword oneOf is unsupported",
      code: "invalid_request_error",
    } satisfies Extract<StreamChunk, { type: EventType.RUN_ERROR }>;
    const adapter = surfaceStructuredOutputRunErrors(fakeAdapter([runError]));

    await expect(
      collect(adapter.chatStream(chatOptions)),
    ).rejects.toMatchObject({
      name: "AIProviderRunError",
      message: "400 invalid_request_error: schema keyword oneOf is unsupported",
      code: "invalid_request_error",
    });
  });

  it("throws provider errors from the separate structured output stream", async () => {
    const runError = {
      type: EventType.RUN_ERROR,
      threadId: "thread",
      runId: "run",
      message: "upstream request timed out",
      code: "timeout",
    } satisfies Extract<StreamChunk, { type: EventType.RUN_ERROR }>;
    const adapter = surfaceStructuredOutputRunErrors(
      fakeAdapter([], [runError]),
    );

    await expect(
      collect(
        adapter.structuredOutputStream?.(structuredOutputOptions) ?? streamOf(),
      ),
    ).rejects.toMatchObject({
      message: "upstream request timed out",
      code: "timeout",
    });
  });

  it("passes successful stream events through unchanged", async () => {
    const finished = {
      type: EventType.RUN_FINISHED,
      threadId: "thread",
      runId: "run",
    } satisfies Extract<StreamChunk, { type: EventType.RUN_FINISHED }>;
    const adapter = surfaceStructuredOutputRunErrors(fakeAdapter([finished]));

    await expect(collect(adapter.chatStream(chatOptions))).resolves.toEqual([
      finished,
    ]);
  });
});

describe("surfaceStructuredOutputRunErrors with { streaming: false }", () => {
  it("clears structuredOutputStream even when the adapter defines one, forcing the engine's non-streaming fallback (which puts stream: false on the wire)", () => {
    const finished = {
      type: EventType.RUN_FINISHED,
      threadId: "thread",
      runId: "run",
    } satisfies Extract<StreamChunk, { type: EventType.RUN_FINISHED }>;
    const adapter = surfaceStructuredOutputRunErrors(
      fakeAdapter([], [finished]),
      { streaming: false },
    );

    expect(adapter.structuredOutputStream).toBeUndefined();
  });

  it("wraps a thrown structuredOutput error as AIProviderRunError, preserving message and code", async () => {
    const providerError = Object.assign(
      new Error("upstream request timed out"),
      { code: "timeout" },
    );
    const adapter = surfaceStructuredOutputRunErrors(
      fakeAdapter([], undefined, async () => {
        throw providerError;
      }),
      { streaming: false },
    );

    await expect(
      adapter.structuredOutput(structuredOutputOptions),
    ).rejects.toMatchObject({
      name: "AIProviderRunError",
      message: "upstream request timed out",
      code: "timeout",
    });
  });

  it("leaves a thrown structuredOutput error untouched by default (streaming behaviour unchanged)", async () => {
    const providerError = new Error("boom");
    const adapter = surfaceStructuredOutputRunErrors(
      fakeAdapter([], undefined, async () => {
        throw providerError;
      }),
    );

    await expect(
      adapter.structuredOutput(structuredOutputOptions),
    ).rejects.toBe(providerError);
  });

  it("surfaces a non-streaming structuredOutput failure through chat()'s rejection as an AIProviderRunError, carried as .cause of the engine's own wrapping error", async () => {
    // Mirrors what the real adapters do on this path: `fallbackStructuredOutputStream`
    // only ever carries the thrown error forward as `finalizationError.cause`
    // inside a generic engine Error — never re-thrown as our named error — so
    // this is the shape callers (e.g. ai/selection.ts) must match against.
    const providerError = Object.assign(
      new Error("Structured output generation failed: 429 rate_limited"),
      { code: "rate_limited" },
    );
    const adapter = surfaceStructuredOutputRunErrors(
      fakeAdapter([], undefined, async () => {
        throw providerError;
      }),
      { streaming: false },
    );

    await expect(
      chat({
        adapter,
        messages: [{ role: "user", content: "hi" }],
        outputSchema: z.object({ title: z.string() }),
      }),
    ).rejects.toMatchObject({
      cause: {
        name: "AIProviderRunError",
        message: "Structured output generation failed: 429 rate_limited",
        code: "rate_limited",
      },
    });
  });
});
