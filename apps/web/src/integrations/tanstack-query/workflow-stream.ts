import type { z } from "zod";

import { streamOperation } from "~/integrations/tanstack-query/browser-operation-transport";
import {
  beginOperationCall,
  unwrapOperationResult,
} from "~/integrations/tanstack-query/operation-call";
import type { OperationIdOfKind } from "~/lib/generated/operation-registry.gen";
import { parseOperationOutput, OperationError } from "~/lib/operation-error";
import { acceptMemberWriteCookie } from "~/lib/read-consistency";
import { operationWireValueSchema } from "~/server/operation-runtime/operation.contract";

/**
 * Open a workflow stream over `POST /api/operations/<id>`. The server ends a
 * completed stream with a data-less envelope carrying the final read marker;
 * a body that ends without it, or without a failure envelope, was cut off.
 */
export async function openWorkflowStream<
  Input,
  EventSchema extends z.ZodTypeAny,
>(options: {
  operation: OperationIdOfKind<"subscription">;
  kind: "query" | "mutation";
  input: Input;
  eventSchema: EventSchema;
  signal?: AbortSignal;
}): Promise<AsyncIterable<z.output<EventSchema>>> {
  const input = operationWireValueSchema.parse(options.input);
  const call = beginOperationCall({
    operation: options.operation,
    kind: options.kind,
    input,
  });
  // Early iterator return must cancel the request, not just stop reading.
  const controller = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;
  let results: Awaited<ReturnType<typeof streamOperation>>;
  try {
    results = await streamOperation(
      { operation: options.operation, input },
      call.headers,
      signal,
    );
  } catch (error) {
    controller.abort();
    call.finish({ error });
    throw error;
  }
  return (async function* () {
    let finished = false;
    try {
      let completed = false;
      for await (const result of results) {
        signal.throwIfAborted();
        if (result.ok && result.data === undefined) {
          acceptMemberWriteCookie(result.readMarker);
          completed = true;
          continue;
        }
        const event = unwrapOperationResult(options.operation, result);
        yield await parseOperationOutput(options.operation, () =>
          options.eventSchema.parse(event),
        );
      }
      if (!completed)
        throw new OperationError({
          code: "INVALID_TRANSPORT_RESPONSE",
          message: `${options.operation} ended before its stream completed`,
        });
      finished = true;
      call.finish({ result: "stream-complete" });
    } catch (error) {
      finished = true;
      call.finish({ error });
      throw error;
    } finally {
      controller.abort();
      if (!finished) call.finish({ result: "stream-cancelled" }, true);
    }
  })();
}
