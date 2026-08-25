import { z } from "zod";
import {
  isStartOperationEntity,
  readStartOperationTraceContext,
  startOperationTraceAttributes,
} from "~/lib/start-operation-observability";
import {
  appErrorFromUnknown,
  toPublicErrorPayload,
} from "~/server/errors/app-error";
import { translateDatabaseError } from "~/server/errors/db-errors";
import { observeRequest } from "~/server/observed-request";
import { createRequestContext, requireActor } from "~/server/request-context";
import type {
  PublicStartOperationError,
  StartOperationResult,
} from "~/server/start-operation.contract";
import type { Workload } from "~/server/workload";

export type StartOperationRequest = {
  headers: Headers;
  signal: AbortSignal;
};

export type AuthenticatedStartOperationContext = ReturnType<
  typeof requireActor
>;

export type OperationStage = "context" | "input" | "run" | "output";

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
): { publicError: PublicStartOperationError; observedError: unknown } {
  if (stage === "input" && error instanceof z.ZodError) {
    const publicError = {
      code: "BAD_REQUEST",
      reason: "INVALID_INPUT",
      message: validationMessage(error),
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
    },
    observedError: error,
  };
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
  const clientTraceContext = readStartOperationTraceContext(
    options.request.headers,
  );
  // The operation/type are declared server-side. The request header is useful
  // at the HTTP boundary, but never supplies the inner span's entity value.
  const traceContext =
    clientTraceContext?.operation === options.operation &&
    clientTraceContext.kind === options.type
      ? clientTraceContext
      : undefined;
  const observed = await observeRequest({
    system: "start",
    method: options.operation,
    type: options.type,
    origin: "ui",
    input: options.input,
    workload,
    operationId:
      options.request.headers.get("x-cubby-operation-id") ?? undefined,
    includeInputValues: false,
    attributes: startOperationTraceAttributes(
      traceContext ? { ...traceContext, entity: undefined } : undefined,
    ),
    run: async (span) => {
      let stage: OperationStage = "context";
      try {
        throwIfStartOperationAborted(options.request.signal);
        const authenticated = requireActor(
          await createRequestContext({ headers: options.request.headers }),
        );
        const readPolicy =
          options.readPolicy ??
          (options.type === "mutation" ? "strong" : "context");
        const context =
          readPolicy === "strong" && authenticated.readDb !== authenticated.db
            ? { ...authenticated, readDb: authenticated.db }
            : authenticated;
        span.setAttributes({
          "enduser.id": context.auth.userId,
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
          isStartOperationEntity(input.entity)
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
        const normalized = normalizeStartOperationError(error, stage);
        return {
          result: { ok: false, error: normalized.publicError } as const,
          observedError: normalized.observedError,
        };
      }
    },
    inspectResult: (result) => ({
      ...(result.observedError ? { error: result.observedError } : {}),
      workload,
    }),
  });
  return observed.result;
}
