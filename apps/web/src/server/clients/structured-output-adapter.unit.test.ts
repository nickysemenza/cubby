import type { AnyTextAdapter, StreamChunk } from "@tanstack/ai";
import { describe, expect, it } from "vitest";

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
    chatStream: () => streamOf(...chatChunks),
    structuredOutput: async () => ({ data: {}, rawText: "{}" }),
    structuredOutputStream: structuredChunks
      ? () => streamOf(...structuredChunks)
      : undefined,
  } as unknown as AnyTextAdapter;
}

async function collect(stream: AsyncIterable<StreamChunk>) {
  const chunks: StreamChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

describe("surfaceStructuredOutputRunErrors", () => {
  it("throws the original provider error from the combined chat stream", async () => {
    const runError = {
      type: "RUN_ERROR",
      threadId: "thread",
      runId: "run",
      message: "400 invalid_request_error: schema keyword oneOf is unsupported",
      code: "invalid_request_error",
    } as StreamChunk;
    const adapter = surfaceStructuredOutputRunErrors(fakeAdapter([runError]));

    await expect(
      collect(adapter.chatStream({} as never)),
    ).rejects.toMatchObject({
      name: "AIProviderRunError",
      message: "400 invalid_request_error: schema keyword oneOf is unsupported",
      code: "invalid_request_error",
    });
  });

  it("throws provider errors from the separate structured output stream", async () => {
    const runError = {
      type: "RUN_ERROR",
      threadId: "thread",
      runId: "run",
      message: "upstream request timed out",
      code: "timeout",
    } as StreamChunk;
    const adapter = surfaceStructuredOutputRunErrors(
      fakeAdapter([], [runError]),
    );

    await expect(
      collect(adapter.structuredOutputStream?.({} as never) ?? streamOf()),
    ).rejects.toMatchObject({
      message: "upstream request timed out",
      code: "timeout",
    });
  });

  it("passes successful stream events through unchanged", async () => {
    const finished = {
      type: "RUN_FINISHED",
      threadId: "thread",
      runId: "run",
    } as StreamChunk;
    const adapter = surfaceStructuredOutputRunErrors(fakeAdapter([finished]));

    await expect(collect(adapter.chatStream({} as never))).resolves.toEqual([
      finished,
    ]);
  });
});
