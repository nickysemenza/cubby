import superjson from "superjson";
import type { z } from "zod";
import { REQUEST_ID_HEADER } from "~/lib/request-id";
import { observeRequest } from "~/server/observed-request";
import { createRequestContext, requireActor } from "~/server/request-context";
import {
  type AuthenticatedStartOperationContext,
  normalizeStartOperationError,
  type OperationStage,
  throwIfStartOperationAborted,
} from "~/server/start-operation.server";
import { getRequestId } from "~/server/tracing";
import type { Workload } from "~/server/workload";

type StreamFrame =
  | { kind: "event"; payload: ReturnType<typeof superjson.serialize> }
  | {
      kind: "error";
      error: ReturnType<typeof normalizeStartOperationError>["publicError"];
    };

const encoder = new TextEncoder();
const encodeFrame = (frame: StreamFrame) =>
  encoder.encode(`${JSON.stringify(frame)}\n`);

const errorResponse = (error: unknown, stage: OperationStage) => {
  const normalized = normalizeStartOperationError(error, stage);
  return new Response(
    encodeFrame({ kind: "error", error: normalized.publicError }),
    {
      headers: {
        "cache-control": "private, no-store",
        "content-type": "application/x-ndjson; charset=utf-8",
      },
    },
  );
};

const hasSameOrigin = (request: Request) => {
  const origin = request.headers.get("origin");
  return origin === null || origin === new URL(request.url).origin;
};

export async function workflowStreamResponse<
  InputSchema extends z.ZodType,
  Event,
>(options: {
  request: Request;
  operation: string;
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
    return errorResponse(error, "input");
  }

  let context: AuthenticatedStartOperationContext;
  try {
    context = requireActor(
      await createRequestContext({ headers: options.request.headers }),
    );
  } catch (error) {
    return errorResponse(error, "context");
  }

  let input: z.output<InputSchema>;
  try {
    input = options.inputSchema.parse(rawInput);
  } catch (error) {
    return errorResponse(error, "input");
  }

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      void (async () => {
        let stage: OperationStage = "run";
        try {
          await observeRequest({
            system: "start",
            method: options.operation,
            type: "subscription",
            origin: "ui",
            actorId: context.auth.userId,
            input,
            workload: options.workload ?? "import-stream",
            operationId:
              options.request.headers.get("x-cubby-operation-id") ?? undefined,
            run: async () => {
              throwIfStartOperationAborted(options.request.signal);
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
          });
        } catch (error) {
          if (!options.request.signal.aborted) {
            const normalized = normalizeStartOperationError(error, stage);
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
