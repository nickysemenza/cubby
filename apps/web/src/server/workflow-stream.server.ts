import superjson from "superjson";
import type { z } from "zod";
import type { StartOperationIdOfKind } from "~/lib/generated/start-operation-registry.gen";
import { REQUEST_ID_HEADER } from "~/lib/request-id";
import { startOperationDefinition } from "~/lib/start-operation-observability";
import { observeOperation } from "~/server/observed-request";
import type { PublicStartOperationError } from "~/server/start-operation.contract";
import {
  type AuthenticatedStartOperationContext,
  authenticateStartOperation,
  normalizeStartOperationError,
  type OperationStage,
  throwIfStartOperationAborted,
} from "~/server/start-operation.server";
import { getRequestId } from "~/server/tracing";
import type { Workload } from "~/server/workload";

type StreamFrame =
  | { kind: "event"; payload: ReturnType<typeof superjson.serialize> }
  | { kind: "error"; error: PublicStartOperationError };

const encoder = new TextEncoder();
const encodeFrame = (frame: StreamFrame) =>
  encoder.encode(`${JSON.stringify(frame)}\n`);

/**
 * A one-frame NDJSON body. The browser reader treats a lone error frame exactly
 * like an error frame mid-stream, so a request that fails before any work
 * starts still surfaces as a `StartOperationError` rather than an HTTP status
 * the caller has to translate.
 */
export const workflowStreamErrorResponse = (
  error: PublicStartOperationError,
): Response =>
  new Response(encodeFrame({ kind: "error", error }), {
    headers: {
      "cache-control": "private, no-store",
      "content-type": "application/x-ndjson; charset=utf-8",
    },
  });

const errorResponse = (
  error: unknown,
  stage: OperationStage,
  requestId?: string,
) =>
  workflowStreamErrorResponse(
    normalizeStartOperationError(error, stage, requestId).publicError,
  );

const hasSameOrigin = (request: Request) => {
  const origin = request.headers.get("origin");
  return origin === null || origin === new URL(request.url).origin;
};

export async function workflowStreamResponse<
  InputSchema extends z.ZodType,
  Event,
>(options: {
  request: Request;
  operation: StartOperationIdOfKind<"subscription">;
  inputSchema: InputSchema;
  eventSchema: z.ZodType<Event>;
  workload?: Workload;
  run: (
    context: AuthenticatedStartOperationContext,
    input: z.output<InputSchema>,
    signal: AbortSignal,
  ) => AsyncIterable<unknown> | Promise<AsyncIterable<unknown>>;
}): Promise<Response> {
  if (!hasSameOrigin(options.request)) {
    return new Response("Cross-origin workflow streams are not allowed", {
      status: 403,
    });
  }

  let rawInput: unknown;
  try {
    rawInput = superjson.parse(await options.request.text());
  } catch (error) {
    return errorResponse(error, "input", getRequestId(options.request.headers));
  }

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      void (async () => {
        // Authentication and input parsing happen INSIDE the span, the same
        // order `runStartOperation` uses, so a rejected actor is observed
        // rather than silently short-circuited — and so an invalid payload
        // never gets to report before an unauthorized caller does.
        let stage: OperationStage = "context";
        try {
          await observeOperation(
            startOperationDefinition(options.operation),
            {
              origin: "ui",
              workload: options.workload ?? "import-stream",
            },
            async (span) => {
              span.setAttribute("cubby.authenticated", false);
              throwIfStartOperationAborted(options.request.signal);
              const context = await authenticateStartOperation(
                options.request.headers,
                span,
              );

              stage = "input";
              const input = options.inputSchema.parse(rawInput);

              stage = "run";
              const events = await options.run(
                context,
                input,
                options.request.signal,
              );
              for await (const event of events) {
                throwIfStartOperationAborted(options.request.signal);
                stage = "output";
                const parsed = options.eventSchema.parse(event);
                controller.enqueue(
                  encodeFrame({
                    kind: "event",
                    payload: superjson.serialize(parsed),
                  }),
                );
                stage = "run";
              }
            },
          );
        } catch (error) {
          if (!options.request.signal.aborted) {
            const normalized = normalizeStartOperationError(
              error,
              stage,
              getRequestId(options.request.headers),
            );
            controller.enqueue(
              encodeFrame({ kind: "error", error: normalized.publicError }),
            );
          }
        } finally {
          controller.close();
        }
      })();
    },
  });

  const headers = new Headers({
    "cache-control": "private, no-store",
    "content-type": "application/x-ndjson; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  const requestId = getRequestId(options.request.headers);
  if (requestId) headers.set(REQUEST_ID_HEADER, requestId);
  return new Response(stream, { headers });
}
