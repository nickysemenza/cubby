import type { z } from "zod";

import type { StartOperationIdOfKind } from "~/lib/generated/start-operation-registry.gen";
import { startOperationDefinition } from "~/lib/start-operation-observability";
import { recordDatabaseWrite } from "~/server/db/freshness/member-marker";
import { withErrorReporting } from "~/server/errors/report-error";
import type { Workload } from "~/server/http/workload";
import {
  type ObservedFailure,
  observeOperation,
} from "~/server/observability/observed-request";
import { type AppSpan, getRequestId } from "~/server/observability/tracing";
import {
  type StartOperationResult,
  type UnparsedStartOperationData,
  unparsedStartOperationDataSchema,
} from "~/server/operation-runtime/start-operation.contract";
import {
  assertClientMayWrite,
  type AuthenticatedStartOperationContext,
  CHANNEL_OBSERVATION,
  deadlineClassOf,
  deadlineExceededError,
  enterOperationSpan,
  normalizeStartOperationError,
  type OperationStage,
  operationFailure,
  type StartOperationRequest,
  type StartOperationRuntime,
  throwIfStartOperationAborted,
  withinBudget,
  withReadMarker,
} from "~/server/operation-runtime/start-operation.server";

type StreamResult = StartOperationResult<UnparsedStartOperationData>;

export type WorkflowStream = ReadableStream<StreamResult>;

export interface WorkflowStreamRuntime {
  observe: StartOperationRuntime["observe"];
  recordDatabaseWrite: (operation: string) => Promise<void>;
}

const productionWorkflowStreamRuntime = {
  observe: observeOperation,
  recordDatabaseWrite,
} satisfies WorkflowStreamRuntime;

/**
 * Run one stream under the principal the endpoint authenticated, with the
 * unary runner's lifecycle: channel observation, deadline budget, client-write
 * gate, staged normalization, write records and read markers. Each event is
 * a result envelope; the stream ends with a failure envelope or a data-less
 * success envelope carrying the final read marker.
 */
export function workflowStream<InputSchema extends z.ZodType, Event>(
  options: {
    request: StartOperationRequest;
    input: UnparsedStartOperationData;
    operation: StartOperationIdOfKind<"subscription">;
    inputSchema: InputSchema;
    eventSchema: z.ZodType<Event>;
    workload?: Workload;
    run: (
      context: AuthenticatedStartOperationContext,
      input: z.output<InputSchema>,
      signal: AbortSignal,
    ) => AsyncIterable<unknown> | Promise<AsyncIterable<unknown>>;
  },
  runtime: WorkflowStreamRuntime = productionWorkflowStreamRuntime,
): WorkflowStream {
  const { principal, headers } = options.request;
  const definition = startOperationDefinition(options.operation);
  const requestId = getRequestId(headers);
  const cancelled = new AbortController();
  const signal = AbortSignal.any([options.request.signal, cancelled.signal]);
  const workload = options.workload ?? "import-stream";
  let stage: OperationStage = "context";
  let mutationStarted = false;
  let failed = false;
  const failureContext = {
    operation: options.operation,
    authenticated: true,
    headers,
  };

  return new ReadableStream({
    start(controller) {
      const pump = async (
        span: AppSpan,
        budgetSignal: AbortSignal,
      ): Promise<{ observedError?: ObservedFailure }> => {
        try {
          throwIfStartOperationAborted(signal);
          enterOperationSpan(span, principal);
          assertClientMayWrite(principal);
          stage = "input";
          const input = options.inputSchema.parse(options.input);

          stage = "run";
          mutationStarted = true;
          const events = await options.run(
            // A fresh request context has one database handle, the
            // authoritative one, so a stream needs no read-policy selection.
            principal.context,
            input,
            budgetSignal,
          );
          for await (const event of events) {
            throwIfStartOperationAborted(budgetSignal);
            stage = "output";
            const parsed = options.eventSchema.parse(event);
            await runtime.recordDatabaseWrite(options.operation);
            controller.enqueue(
              await withReadMarker<StreamResult>({
                ok: true,
                data: unparsedStartOperationDataSchema.parse(parsed),
              }),
            );
            stage = "run";
          }
          return {};
        } catch (error) {
          if (signal.aborted) throw error;
          if (budgetSignal.aborted) return {};
          const normalized = operationFailure(
            span,
            error,
            stage,
            requestId,
            failureContext,
          );
          if (mutationStarted) {
            await runtime.recordDatabaseWrite(options.operation);
            mutationStarted = false;
          }
          failed = true;
          controller.enqueue(
            await withReadMarker<StreamResult>({
              ok: false,
              error: normalized.publicError,
            }),
          );
          return { observedError: normalized.observedError };
        }
      };

      void withErrorReporting(async () => {
        try {
          await withinBudget(
            principal.budget,
            deadlineClassOf("subscription"),
            signal,
            (budgetSignal) =>
              runtime.observe<{ observedError?: ObservedFailure }>(
                definition,
                {
                  origin: CHANNEL_OBSERVATION[principal.channel].origin,
                  workload,
                  requestId,
                  inspectResult: (result) =>
                    result.observedError
                      ? {
                          workload,
                          error: result.observedError,
                          reported: true,
                        }
                      : { workload },
                },
                (span) => pump(span, budgetSignal),
              ),
            async (budgetMs) => {
              if (mutationStarted) {
                await runtime.recordDatabaseWrite(options.operation);
                mutationStarted = false;
              }
              failed = true;
              controller.enqueue(
                await withReadMarker<StreamResult>({
                  ok: false,
                  error: normalizeStartOperationError(
                    deadlineExceededError(options.operation, budgetMs),
                    stage,
                    requestId,
                    failureContext,
                  ).publicError,
                }),
              );
              return {};
            },
          );
        } catch {
          // SILENT: only cancellation escapes `pump`; the client that
          // cancelled no longer reads this stream.
        } finally {
          if (mutationStarted)
            await runtime.recordDatabaseWrite(options.operation);
          // A completed stream ends with a data-less envelope, so the client
          // tells completion from a cut-off body. It carries the marker for
          // commits after the last progress event.
          if (!failed && !signal.aborted)
            controller.enqueue(
              await withReadMarker<StreamResult>({ ok: true, data: undefined }),
            );
          if (!cancelled.signal.aborted) controller.close();
        }
      });
    },
    async cancel(reason) {
      cancelled.abort(reason);
      if (mutationStarted) await runtime.recordDatabaseWrite(options.operation);
    },
  });
}
