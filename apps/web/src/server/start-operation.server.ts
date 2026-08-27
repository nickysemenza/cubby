import { z } from "zod";
import {
  isStartOperationEntity,
  startOperationDefinitionFor,
} from "~/lib/start-operation-observability";
import {
  appErrorFromUnknown,
  toPublicErrorPayload,
} from "~/server/errors/app-error";
import { translateDatabaseError } from "~/server/errors/db-errors";
import { observeOperation } from "~/server/observed-request";
import { createRequestContext, requireActor } from "~/server/request-context";
import type {
  PublicStartOperationError,
  StartOperationResult,
} from "~/server/start-operation.contract";
import { type AppSpan, getRequestId } from "~/server/tracing";
import type { Workload } from "~/server/workload";

export type StartOperationRequest = {
  headers: Headers;
  signal: AbortSignal;
};

export type AuthenticatedStartOperationContext = ReturnType<
  typeof requireActor
>;

export type OperationStage = "context" | "input" | "run" | "output";

type ObservedStartResult<Output> = {
  result: StartOperationResult<Output>;
  observedError?: unknown;
};

const abortError = (signal: AbortSignal): Error =>
  signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The operation was cancelled", "AbortError");

export function throwIfStartOperationAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError(signal);
}

const validationMessage = (error: z.ZodError): string =>
  error.issues
    .map((issue) =>
      issue.path.length > 0
        ? `${issue.path.map(String).join(".")}: ${issue.message}`
        : issue.message,
    )
    .join(", ");

export function normalizeStartOperationError(
  error: unknown,
  stage: OperationStage,
  requestId?: string,
): { publicError: PublicStartOperationError; observedError: unknown } {
  if (stage === "input" && error instanceof z.ZodError) {
    const publicError = {
      code: "BAD_REQUEST",
      reason: "INVALID_INPUT",
      message: validationMessage(error),
      ...(requestId ? { requestId } : {}),
      validationIssues: error.issues.map((issue) => ({
        code: issue.code,
        path: issue.path.map((part) =>
          typeof part === "string" || typeof part === "number"
            ? part
            : String(part),
        ),
        message: issue.message,
      })),
    } satisfies PublicStartOperationError;
    return { publicError, observedError: publicError };
  }

  const knownError =
    translateDatabaseError(error) ?? appErrorFromUnknown(error);
  if (knownError) {
    const payload = toPublicErrorPayload(knownError);
    const { code, ...details } = payload;
    return {
      publicError: {
        code:
          code ??
          (payload.blockers && payload.blockers.length > 0
            ? "PRECONDITION_FAILED"
            : "BAD_REQUEST"),
        message: knownError.message || "The operation could not be completed",
        ...(requestId ? { requestId } : {}),
        ...details,
      },
      observedError: knownError,
    };
  }

  return {
    publicError: {
      code: "INTERNAL_SERVER_ERROR",
      reason: stage === "output" ? "INVALID_OUTPUT" : "UNKNOWN_ERROR",
      message: "The operation could not be completed",
      ...(requestId ? { requestId } : {}),
    },
    observedError: error,
  };
}

/**
 * Resolve the actor for a Start request and record the one span fact both
 * transports report identically.
 *
 * This is the whole of what `runStartOperation` and `workflowStreamResponse`
 * share. Everything downstream differs BECAUSE one transport returns a value
 * and the other a stream: read-policy selection, output parsing, and the
 * result envelope have no counterpart on the stream side, and the same-origin
 * check, per-event `eventSchema.parse`, and NDJSON framing have none here.
 */
export async function authenticateStartOperation(
  headers: Headers,
  span: AppSpan,
): Promise<AuthenticatedStartOperationContext> {
  const authenticated = requireActor(await createRequestContext({ headers }));
  span.setAttribute("cubby.authenticated", true);
  return authenticated;
}

export async function runStartOperation<
  InputSchema extends z.ZodType,
  Output,
>(options: {
  operation: string;
  type: "query" | "mutation" | "subscription";
  input: unknown;
  inputSchema: InputSchema;
  outputSchema:
    | z.ZodType<Output>
    | ((input: z.output<InputSchema>) => z.ZodType<Output>);
  request: StartOperationRequest;
  readPolicy?: "context" | "strong";
  workload?: Workload;
  run: (
    context: AuthenticatedStartOperationContext,
    input: z.output<InputSchema>,
  ) => Promise<unknown>;
}): Promise<StartOperationResult<Output>> {
  const workload = options.workload ?? "ui";
  const definition = startOperationDefinitionFor(options.operation);
  if (!definition || definition.kind !== options.type) {
    throw new Error(
      `Unregistered Start operation: ${options.operation} (${options.type})`,
    );
  }
  const observed = await observeOperation<ObservedStartResult<Output>>(
    definition,
    {
      origin: "ui",
      workload,
      inspectResult: (result) => ({
        ...(result.observedError ? { error: result.observedError } : {}),
        workload,
      }),
    },
    async (span) => {
      span.setAttribute("cubby.authenticated", false);
      let stage: OperationStage = "context";
      try {
        throwIfStartOperationAborted(options.request.signal);
        const authenticated = await authenticateStartOperation(
          options.request.headers,
          span,
        );
        const readPolicy =
          options.readPolicy ??
          (options.type === "mutation" ? "strong" : "context");
        const context =
          readPolicy === "strong" && authenticated.readDb !== authenticated.db
            ? { ...authenticated, readDb: authenticated.db }
            : authenticated;
        span.setAttributes({
          "cubby.request_origin": context.requestOrigin,
          "cubby.read.consistency":
            readPolicy === "strong"
              ? "strong"
              : context.readConsistency.consistency,
          "cubby.read.reason":
            readPolicy === "strong"
              ? options.type === "mutation"
                ? "mutation"
                : "authoritative-operation"
              : context.readConsistency.reason,
        });

        stage = "input";
        const input = options.inputSchema.parse(options.input);
        const entity =
          input &&
          typeof input === "object" &&
          "entity" in input &&
          isStartOperationEntity(definition.id, input.entity)
            ? input.entity
            : undefined;
        if (entity) span.setAttribute("cubby.entity", entity);
        throwIfStartOperationAborted(options.request.signal);

        stage = "run";
        const rawOutput = await options.run(context, input);
        throwIfStartOperationAborted(options.request.signal);

        stage = "output";
        const outputSchema =
          typeof options.outputSchema === "function"
            ? options.outputSchema(input)
            : options.outputSchema;
        const data = outputSchema.parse(rawOutput);
        throwIfStartOperationAborted(options.request.signal);
        return { result: { ok: true, data } as const };
      } catch (error) {
        if (options.request.signal.aborted)
          throw abortError(options.request.signal);
        const normalized = normalizeStartOperationError(
          error,
          stage,
          getRequestId(options.request.headers),
        );
        return {
          result: { ok: false, error: normalized.publicError } as const,
          observedError: normalized.observedError,
        };
      }
    },
  );
  return observed.result;
}
