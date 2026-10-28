import type { z } from "zod";

import {
  beginObservedOperation,
  finishObservedOperation,
  operationHeaders,
} from "~/integrations/tanstack-query/operation-recorder";
import { unwrapStartOperationResult } from "~/integrations/tanstack-query/start-transport";
import type { StartOperationIdOfKind } from "~/lib/generated/start-operation-registry.gen";
import {
  acceptMemberWriteCookie,
  beginMemberWrite,
} from "~/lib/read-consistency";
import {
  unparsedStartOperationDataSchema,
  unparsedStartOperationResultSchema,
} from "~/server/operation-runtime/start-operation.contract";

export async function openWorkflowStream<
  Input,
  EventSchema extends z.ZodTypeAny,
>(options: {
  operation: StartOperationIdOfKind<"subscription">;
  kind: "query" | "mutation";
  input: Input;
  eventSchema: EventSchema;
  signal?: AbortSignal;
}): Promise<AsyncIterable<z.output<EventSchema>>> {
  const observed = beginObservedOperation({
    kind: options.kind,
    transport: "start",
    operation: options.operation,
    input: options.input,
  });
  const controller = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;
  let transportEnded = false;
  let readPending = false;
  const rejectIncompleteStream = () => {
    if (!transportEnded || !readPending) return;
    // Carrier values exclude promises. Let Start drain its synchronous patches
    // through the microtask queue before checking for a missing closing patch.
    setTimeout(() => {
      if (readPending) {
        controller.abort(
          new Error("Workflow response ended before its stream completed"),
        );
      }
    }, 0);
  };
  try {
    beginMemberWrite();
    const { callWorkflowStream } = await import("~/lib/workflow-stream-call");
    const stream = await callWorkflowStream({
      data: {
        operation: options.operation,
        input: unparsedStartOperationDataSchema.parse(options.input),
      },
      headers: operationHeaders(observed),
      signal,
      fetch: async (url, init) => {
        const response = await globalThis.fetch(url, init);
        if (!response.body) return response;
        const reader = response.body.getReader();
        // Start currently logs framing read failures without rejecting streams
        // it already deserialized. Abort those readers with the original error.
        return new Response(
          new ReadableStream({
            async pull(body) {
              try {
                const chunk = await reader.read();
                if (chunk.done) {
                  transportEnded = true;
                  body.close();
                  rejectIncompleteStream();
                } else body.enqueue(chunk.value);
              } catch (error) {
                controller.abort(error);
                body.error(error);
              }
            },
            cancel: (reason) => {
              controller.abort(reason);
              return reader.cancel(reason);
            },
          }),
          response,
        );
      },
    });
    return (async function* () {
      const reader = stream.getReader();
      const cancelReader = () => {
        // Start can leave deserialized reads pending after a transport abort.
        void reader.cancel(signal.reason).catch(() => {
          // SILENT: the abort reason is surfaced by throwIfAborted below.
        });
      };
      signal.addEventListener("abort", cancelReader, { once: true });
      let finished = false;
      try {
        while (true) {
          signal.throwIfAborted();
          readPending = true;
          rejectIncompleteStream();
          const { value, done } = await reader.read().finally(() => {
            readPending = false;
          });
          signal.throwIfAborted();
          if (done) break;
          const result = unparsedStartOperationResultSchema.parse(value);
          if (result.ok && result.data === undefined && result.readMarker) {
            acceptMemberWriteCookie(result.readMarker);
            continue;
          }
          yield options.eventSchema.parse(
            unwrapStartOperationResult(options.operation, result),
          );
        }
        finished = true;
        finishObservedOperation(observed, { result: "stream-complete" });
      } catch (error) {
        beginMemberWrite();
        finished = true;
        finishObservedOperation(observed, { error });
        throw error;
      } finally {
        // Early iterator return must cancel the request, not just release its reader.
        signal.removeEventListener("abort", cancelReader);
        controller.abort();
        try {
          await reader.cancel();
        } catch {
          // SILENT: an already-aborted transport must not replace the stream's error.
        }
        reader.releaseLock();
        if (!finished) beginMemberWrite();
        if (!finished)
          finishObservedOperation(observed, { result: "stream-cancelled" });
      }
    })();
  } catch (error) {
    beginMemberWrite();
    controller.abort();
    finishObservedOperation(observed, { error });
    throw error;
  }
}
