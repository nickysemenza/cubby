import { createAnthropicChat } from "@cloudflare/tanstack-ai/adapters/anthropic";
import { type AnyTextAdapter, chat, type StreamChunk } from "@tanstack/ai";
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
    structuredOutput: async () => ({ data: {}, rawText: "{}" }),
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

async function collect(stream: AsyncIterable<StreamChunk>) {
  const chunks: StreamChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

describe("surfaceStructuredOutputRunErrors", () => {
  it("preserves class adapter methods through structured generation", async () => {
    const provider = createAnthropicChat("claude-opus-4-1", {
      binding: {
        async run() {
          return Response.json({
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
          });
        },
      },
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
