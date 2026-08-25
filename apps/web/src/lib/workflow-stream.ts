import superjson from "superjson";
import type { z } from "zod";
import {
  beginObservedOperation,
  finishObservedOperation,
  operationHeaders,
} from "~/integrations/tanstack-query/operation-recorder";
import { StartOperationError } from "~/integrations/tanstack-query/start-transport";
import { markFreshReads } from "~/lib/fresh-read-marker";
import type { StartOperationIdOfKind } from "~/lib/generated/start-operation-registry.gen";
import type { PublicStartOperationError } from "~/server/start-operation.contract";

type EventFrame = {
  kind: "event";
  payload: Parameters<typeof superjson.deserialize>[0];
};
type ErrorFrame = { kind: "error"; error: PublicStartOperationError };
type StreamFrame = EventFrame | ErrorFrame;

const parseFrame = (line: string): StreamFrame => {
  const value: unknown = JSON.parse(line);
  if (!value || typeof value !== "object" || !("kind" in value)) {
    throw new Error("Workflow stream returned an invalid frame");
  }
  const frame = value as Record<string, unknown>;
  if (frame.kind === "event" && "payload" in frame) {
    return frame as EventFrame;
  }
  if (
    frame.kind === "error" &&
    frame.error &&
    typeof frame.error === "object"
  ) {
    return frame as ErrorFrame;
  }
  throw new Error("Workflow stream returned an invalid frame");
};

async function* readFrames<Event>(options: {
  response: Response;
  eventSchema: z.ZodType<Event>;
}): AsyncGenerator<Event> {
  if (!options.response.body) {
    throw new Error("Workflow stream returned no body");
  }
  const reader = options.response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) {
          const frame = parseFrame(line);
          if (frame.kind === "error")
            throw new StartOperationError(frame.error);
          yield options.eventSchema.parse(superjson.deserialize(frame.payload));
        }
        newline = buffer.indexOf("\n");
      }
      if (done) break;
    }
    if (buffer.trim()) {
      const frame = parseFrame(buffer.trim());
      if (frame.kind === "error") throw new StartOperationError(frame.error);
      yield options.eventSchema.parse(superjson.deserialize(frame.payload));
    }
  } finally {
    reader.releaseLock();
  }
}

export async function openWorkflowStream<Input, Event>(options: {
  operation: StartOperationIdOfKind<"subscription">;
  kind: "query" | "mutation";
  url: string;
  input: Input;
  eventSchema: z.ZodType<Event>;
  signal?: AbortSignal;
}): Promise<AsyncIterable<Event>> {
  const observed = beginObservedOperation({
    kind: options.kind,
    transport: "start",
    operation: options.operation,
    input: options.input,
  });
  try {
    const response = await fetch(options.url, {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "content-type": "application/json",
        ...operationHeaders(observed),
      },
      body: superjson.stringify(options.input),
      signal: options.signal,
    });
    if (!response.ok) {
      throw new Error(`Workflow stream failed with HTTP ${response.status}`);
    }
    return (async function* () {
      try {
        for await (const event of readFrames({
          response,
          eventSchema: options.eventSchema,
        })) {
          yield event;
        }
        if (options.kind === "mutation") markFreshReads();
        finishObservedOperation(observed, { result: "stream-complete" });
      } catch (error) {
        finishObservedOperation(observed, { error });
        throw error;
      }
    })();
  } catch (error) {
    finishObservedOperation(observed, { error });
    throw error;
  }
}
