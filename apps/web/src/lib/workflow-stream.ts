import superjson from "superjson";
import { z } from "zod";

import {
  beginObservedOperation,
  finishObservedOperation,
  operationHeaders,
} from "~/integrations/tanstack-query/operation-recorder";
import { StartOperationError } from "~/integrations/tanstack-query/start-transport";
import type { StartOperationIdOfKind } from "~/lib/generated/start-operation-registry.gen";
import { superJsonResultSchema } from "~/lib/superjson-wire";
import { publicStartOperationErrorSchema } from "~/server/start-operation.contract";

const streamFrameSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("event"), payload: superJsonResultSchema }),
  z.object({
    kind: z.literal("error"),
    error: publicStartOperationErrorSchema,
  }),
]);

type StreamFrame = z.infer<typeof streamFrameSchema>;

/** The browser edge the stream owns; tests supply a local runtime. */
export interface WorkflowStreamRuntime {
  fetch: typeof fetch;
}

const productionWorkflowStreamRuntime: WorkflowStreamRuntime = {
  // Wrap rather than store the native function: `runtime.fetch(...)` invokes
  // it with the runtime object as `this`, which browsers reject with
  // "Illegal invocation" and which broke every durable maintenance stream.
  fetch: (input, init) => fetch(input, init),
};

const parseFrame = (line: string): StreamFrame => {
  const parsed = streamFrameSchema.safeParse(JSON.parse(line));
  if (parsed.success) return parsed.data;
  throw new Error("Workflow stream returned an invalid frame", {
    cause: parsed.error,
  });
};

async function* readFrames<EventSchema extends z.ZodTypeAny>(options: {
  response: Response;
  eventSchema: EventSchema;
}): AsyncGenerator<z.output<EventSchema>> {
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

export async function openWorkflowStream<
  Input,
  EventSchema extends z.ZodTypeAny,
>(
  options: {
    operation: StartOperationIdOfKind<"subscription">;
    kind: "query" | "mutation";
    url: string;
    input: Input;
    eventSchema: EventSchema;
    signal?: AbortSignal;
  },
  runtime: WorkflowStreamRuntime = productionWorkflowStreamRuntime,
): Promise<AsyncIterable<z.output<EventSchema>>> {
  const observed = beginObservedOperation({
    kind: options.kind,
    transport: "start",
    operation: options.operation,
    input: options.input,
  });
  try {
    const response = await runtime.fetch(options.url, {
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
