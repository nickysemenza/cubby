import type { z } from "zod";

import type { StartOperationIdOfKind } from "~/lib/generated/start-operation-registry.gen";
import { startOperationDefinition } from "~/lib/start-operation-observability";
import { recordDatabaseWrite } from "~/server/db/freshness/client";
import { withErrorReporting } from "~/server/errors/report-error";
import {
  authenticate,
  type Authenticate,
  BROWSER_AUTH,
  challengeError,
  isChallenge,
} from "~/server/http/authenticate";
import { actorSpanAttributes } from "~/server/http/request-context";
import type { Workload } from "~/server/http/workload";
import { observeOperation } from "~/server/observability/observed-request";
import { getRequestId } from "~/server/observability/tracing";
import {
  type PublicStartOperationError,
  type StartOperationResult,
  type UnparsedStartOperationData,
  unparsedStartOperationDataSchema,
} from "~/server/operation-runtime/start-operation.contract";
import {
  assertClientMayWrite,
  type AuthenticatedStartOperationContext,
  normalizeStartOperationError,
  type OperationStage,
  throwIfStartOperationAborted,
} from "~/server/operation-runtime/start-operation.server";

export type WorkflowStream = ReadableStream<
  StartOperationResult<UnparsedStartOperationData>
>;

/** Keep diagnostic envelopes: Start's thrown Error transport preserves only message. */
export const workflowStreamError = (
  error: PublicStartOperationError,
): WorkflowStream =>
  new ReadableStream({
    start(controller) {
      controller.enqueue({ ok: false, error });
      controller.close();
    },
  });

export interface WorkflowStreamRuntime {
  authenticate: Authenticate;
  observe: typeof observeOperation;
  recordDatabaseWrite: typeof recordDatabaseWrite;
}

const productionWorkflowStreamRuntime = {
  authenticate,
  observe: observeOperation,
  recordDatabaseWrite,
} satisfies WorkflowStreamRuntime;

export async function workflowStream<InputSchema extends z.ZodType, Event>(
  options: {
    request: Request;
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
): Promise<WorkflowStream> {
  const abortController = new AbortController();
  const signal = AbortSignal.any([
    options.request.signal,
    abortController.signal,
  ]);
  let mutationStarted = false;
  return new ReadableStream({
    start(controller) {
      void withErrorReporting(async () => {
        // Authentication and input parsing happen INSIDE the span, the same
        // order `runStartOperation` uses, so a rejected actor is observed
        // rather than silently short-circuited — and so an invalid payload
        // never gets to report before an unauthorized caller does.
        let stage: OperationStage = "context";
        let actorVerified = false;
        try {
          await runtime.observe(
            startOperationDefinition(options.operation),
            {
              origin: "ui",
              workload: options.workload ?? "import-stream",
            },
            async (span) => {
              span.setAttribute("cubby.authenticated", false);
              throwIfStartOperationAborted(signal);
              const principal = await runtime.authenticate(
                options.request,
                BROWSER_AUTH,
              );
              if (isChallenge(principal)) throw challengeError(principal);
              // A fresh request context has one database handle, the
              // authoritative one, so a stream needs no read-policy selection.
              const { context } = principal;
              span.setAttributes({
                "cubby.authenticated": true,
                ...actorSpanAttributes(
                  context.auth.sessionId,
                  context.actorContext,
                ),
              });

              actorVerified = true;
              assertClientMayWrite(principal);
              stage = "input";
              const input = options.inputSchema.parse(options.input);

              stage = "run";
              mutationStarted = true;
              const events = await options.run(context, input, signal);
              for await (const event of events) {
                throwIfStartOperationAborted(signal);
                stage = "output";
                const parsed = options.eventSchema.parse(event);
                await runtime.recordDatabaseWrite(options.operation);
                controller.enqueue({
                  ok: true,
                  data: unparsedStartOperationDataSchema.parse(parsed),
                });
                stage = "run";
              }
            },
          );
        } catch (error) {
          if (!signal.aborted) {
            const normalized = normalizeStartOperationError(
              error,
              stage,
              getRequestId(options.request.headers),
              {
                operation: options.operation,
                authenticated: actorVerified,
                headers: options.request.headers,
              },
            );
            controller.enqueue({ ok: false, error: normalized.publicError });
          }
        } finally {
          if (mutationStarted)
            await runtime.recordDatabaseWrite(options.operation);
          if (!abortController.signal.aborted) controller.close();
        }
      });
    },
    async cancel(reason) {
      abortController.abort(reason);
      if (mutationStarted) await runtime.recordDatabaseWrite(options.operation);
    },
  });
}
