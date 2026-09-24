import { z } from "zod";

import {
  CLOUDFLARE_OBSERVABILITY_URL,
  describeErrorCauses,
  scrubErrorMessage,
  sentryEventUrl,
} from "~/lib/error-diagnostics";
import {
  isStartOperationEntity,
  type StartOperationId,
  type StartOperationDefinition,
  startOperationDefinitionFor,
} from "~/lib/start-operation-observability";
import { scheduleCalendarFeedDirty } from "~/server/calendar/client";
import { recordDatabaseWrite } from "~/server/database-freshness/client";
import {
  appErrorFromUnknown,
  isExpectedAppError,
  toPublicErrorPayload,
} from "~/server/errors/app-error";
import { translateDatabaseError } from "~/server/errors/db-errors";
import {
  reportServerError,
  withErrorReporting,
} from "~/server/errors/report-error";
import {
  type ObservedFailure,
  type OperationObservation,
  observeOperation,
  parseObservedFailure,
} from "~/server/observed-request";
import {
  type ReadPolicy,
  mutationChangesHouseholdData,
  readPolicyFor,
} from "~/server/read-policy";
import {
  createRequestContext,
  requireActor,
  selectOperationContext,
} from "~/server/request-context";
import type {
  PublicStartOperationError,
  StartOperationResult,
} from "~/server/start-operation.contract";
import { type AppSpan, getRequestId } from "~/server/tracing";
import type { Workload } from "~/server/workload";

export type StartOperationRequest = {
  headers: Headers;
  signal: AbortSignal;
  /** Supplied only by the authenticated HTTP adapter, never request JSON. */
  apiContext?: AuthenticatedStartOperationContext;
  verifiedContext?: AuthenticatedStartOperationContext;
};

export type AuthenticatedStartOperationContext = ReturnType<
  typeof requireActor
>;

export type OperationStage =
  | "context"
  | "input"
  | "run"
  | "output"
  | "dispatch";

type ObservedStartResult<Output> = {
  result: StartOperationResult<Output>;
  observedError?: StartOperationFailureCause;
};

type StartOperationFailureCause = ObservedFailure;

type NormalizedStartOperationError = {
  publicError: PublicStartOperationError;
  observedError: StartOperationFailureCause;
};

type StartOperationInspection = {
  error?: StartOperationFailureCause;
  workload: Workload;
  reported?: boolean;
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

const isValidationPathPrimitive = (
  part: PropertyKey,
): part is string | number =>
  typeof part === "string" || typeof part === "number";

function normalizePublicError<TError>(
  error: TError,
  stage: OperationStage,
  requestId?: string,
): NormalizedStartOperationError {
  const failure = parseObservedFailure(error);
  if (stage === "input" && failure instanceof SyntaxError) {
    const publicError: PublicStartOperationError = {
      code: "BAD_REQUEST",
      reason: "INVALID_INPUT",
      message: "Invalid request input",
    };
    if (requestId) publicError.requestId = requestId;
    return { publicError, observedError: publicError };
  }
  if (stage === "input" && failure instanceof z.ZodError) {
    const publicError: PublicStartOperationError = {
      code: "BAD_REQUEST",
      reason: "INVALID_INPUT",
      message: validationMessage(failure),
      validationIssues: failure.issues.map((issue) => ({
        code: issue.code,
        path: issue.path.map((part) =>
          isValidationPathPrimitive(part) ? part : String(part),
        ),
        message: issue.message,
      })),
    };
    if (requestId) publicError.requestId = requestId;
    return {
      publicError,
      observedError: parseObservedFailure(publicError),
    };
  }

  const knownError =
    translateDatabaseError(failure) ?? appErrorFromUnknown(failure);
  if (knownError) {
    const payload = toPublicErrorPayload(knownError);
    const { code, ...details } = payload;
    const publicError: PublicStartOperationError = {
      code:
        code ??
        (payload.blockers && payload.blockers.length > 0
          ? "PRECONDITION_FAILED"
          : "BAD_REQUEST"),
      message: knownError.message || "The operation could not be completed",
      ...details,
    };
    if (requestId) publicError.requestId = requestId;
    return {
      publicError,
      observedError: knownError,
    };
  }

  const publicError: PublicStartOperationError = {
    code: "INTERNAL_SERVER_ERROR",
    reason: stage === "output" ? "INVALID_OUTPUT" : "UNKNOWN_ERROR",
    message: "The operation could not be completed",
  };
  if (requestId) publicError.requestId = requestId;
  return {
    publicError,
    observedError: failure,
  };
}

export type OperationFailureContext = {
  operation: string;
  authenticated: boolean;
  entity?: string;
  headers?: Headers;
  batchIndex?: number;
};

function unauthenticatedErrorMessage(
  code: string,
  stage: OperationStage,
): string {
  if (code === "UNAUTHORIZED") return "Please sign in to continue";
  if (code === "FORBIDDEN") return "Access denied";
  return stage === "input"
    ? "Invalid request input"
    : "The operation could not be completed";
}

export function normalizeStartOperationError<TError>(
  error: TError,
  stage: OperationStage,
  requestId?: string,
  context?: OperationFailureContext,
): NormalizedStartOperationError {
  const normalized = normalizePublicError(error, stage, requestId);
  if (!context) return normalized;
  const { publicError } = normalized;
  const eventId = reportOperationFailure(error, normalized.observedError, {
    operation: context.operation,
    stage,
    requestId,
    batchIndex: context.batchIndex,
  });
  const cfRayId = context.headers?.get("cf-ray") ?? undefined;
  const chain = context.authenticated
    ? describeErrorCauses(error)
    : { causes: [] };
  publicError.message = scrubErrorMessage(publicError.message);
  if (!context.authenticated) {
    publicError.message = unauthenticatedErrorMessage(publicError.code, stage);
    delete publicError.blockers;
    delete publicError.validationIssues;
  }
  if (context.authenticated && publicError.reason === "UNKNOWN_ERROR") {
    publicError.message =
      (error instanceof AggregateError
        ? chain.causes[0]?.message
        : chain.causes.at(-1)?.message) ?? publicError.message;
  }
  if (publicError.validationIssues) {
    publicError.validationIssues = publicError.validationIssues.map(
      (issue) => ({
        ...issue,
        message: scrubErrorMessage(issue.message),
      }),
    );
  }
  publicError.diagnostics = {
    origin: "server",
    operation: context.operation,
    stage,
    ...chain,
  };
  if (context.authenticated && context.entity)
    publicError.diagnostics.entity = context.entity;
  if (context.batchIndex !== undefined)
    publicError.diagnostics.batchIndex = context.batchIndex;
  if (eventId) {
    publicError.diagnostics.sentryEventId = eventId;
    publicError.diagnostics.sentryUrl = sentryEventUrl(eventId);
  }
  if (cfRayId) {
    publicError.diagnostics.cfRayId = cfRayId;
    publicError.diagnostics.cloudflareUrl = CLOUDFLARE_OBSERVABILITY_URL;
  }
  return normalized;
}

function reportOperationFailure<TError>(
  original: TError,
  classified: ObservedFailure,
  context: Parameters<typeof reportServerError>[1],
) {
  if (isExpectedAppError(classified)) return undefined;
  return reportServerError(original, context);
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

export interface StartOperationRuntime {
  authenticate(
    headers: Headers,
    span: AppSpan,
  ): Promise<AuthenticatedStartOperationContext>;
  observe<Result>(
    definition: StartOperationDefinition,
    observation: OperationObservation<Result>,
    run: (span: AppSpan) => Promise<Result>,
  ): Promise<Result>;
  markCalendarDirty(
    context: AuthenticatedStartOperationContext,
    headers: Headers,
    operation: StartOperationId,
  ): void;
  /** Best-effort post-write notification; failures never alter the response. */
  recordDatabaseWrite?(operation: StartOperationId): Promise<void>;
}

type OutputSchemaResolver<
  InputSchema extends z.ZodType,
  OutputSchema extends z.ZodType,
> = (input: z.output<InputSchema>) => OutputSchema;

function isOutputSchemaResolver<
  InputSchema extends z.ZodType,
  OutputSchema extends z.ZodType,
>(
  schema: OutputSchema | OutputSchemaResolver<InputSchema, OutputSchema>,
): schema is OutputSchemaResolver<InputSchema, OutputSchema> {
  return typeof schema === "function";
}

const operationEntityInputSchema = z.object({ entity: z.string() });

export type RunStartOperationOptions<
  InputSchema extends z.ZodType,
  OutputSchema extends z.ZodType,
> = {
  operation: StartOperationId;
  type: "query" | "mutation" | "subscription";
  input: z.input<z.ZodUnknown>;
  inputSchema: InputSchema;
  outputSchema: OutputSchema | OutputSchemaResolver<InputSchema, OutputSchema>;
  request: StartOperationRequest;
  readPolicy?: ReadPolicy;
  workload?: Workload;
  run: (
    context: AuthenticatedStartOperationContext,
    input: z.output<InputSchema>,
  ) => Promise<z.input<OutputSchema>>;
};

export function createStartOperationRunner(runtime: StartOperationRuntime) {
  return async function runStartOperation<
    InputSchema extends z.ZodType,
    OutputSchema extends z.ZodType,
  >(
    options: RunStartOperationOptions<InputSchema, OutputSchema>,
  ): Promise<StartOperationResult<z.output<OutputSchema>>> {
    const workload =
      options.workload ?? (options.request.apiContext ? "other" : "ui");
    const definition = startOperationDefinitionFor(options.operation);
    if (!definition || definition.kind !== options.type) {
      throw new Error(
        `Unregistered Start operation: ${options.operation} (${options.type})`,
      );
    }
    return await withErrorReporting(async () => {
      const observed = await runtime.observe<
        ObservedStartResult<z.output<OutputSchema>>
      >(
        definition,
        {
          origin: options.request.apiContext ? "api" : "ui",
          workload,
          inspectResult: (result) => {
            const inspection: StartOperationInspection = {
              workload,
            };
            if (result.observedError) {
              inspection.error = result.observedError;
              inspection.reported = true;
            }
            return inspection;
          },
        },
        async (span) => {
          span.setAttribute("cubby.authenticated", false);
          let stage: OperationStage = "context";
          let mutationStarted = false;
          let actorVerified = false;
          let entity: string | undefined;
          try {
            throwIfStartOperationAborted(options.request.signal);
            const authenticated =
              options.request.apiContext ??
              options.request.verifiedContext ??
              (await runtime.authenticate(options.request.headers, span));
            actorVerified = true;
            span.setAttribute("cubby.authenticated", true);
            const readPolicy =
              options.type !== "query"
                ? "strong"
                : (options.readPolicy ??
                  readPolicyFor(options.operation, "query"));
            const context = await selectOperationContext(
              authenticated,
              readPolicy,
            );
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
            const entityInput = operationEntityInputSchema.safeParse(input);
            entity =
              entityInput.success &&
              isStartOperationEntity(definition.id, entityInput.data.entity)
                ? entityInput.data.entity
                : undefined;
            if (entity) span.setAttribute("cubby.entity", entity);
            throwIfStartOperationAborted(options.request.signal);

            stage = "run";
            mutationStarted =
              options.type === "mutation" &&
              mutationChangesHouseholdData(options.operation);
            const rawOutput = await options.run(context, input);
            throwIfStartOperationAborted(options.request.signal);

            stage = "output";
            const outputSchema = isOutputSchemaResolver(options.outputSchema)
              ? options.outputSchema(input)
              : options.outputSchema;
            const data = outputSchema.parse(rawOutput);
            throwIfStartOperationAborted(options.request.signal);
            if (mutationStarted) {
              runtime.markCalendarDirty(
                context,
                options.request.headers,
                options.operation,
              );
            }
            const result: StartOperationResult<z.output<OutputSchema>> = {
              ok: true,
              data,
            };
            return { result };
          } catch (error) {
            if (options.request.signal.aborted)
              throw abortError(options.request.signal);
            const requestId = getRequestId(options.request.headers);
            const normalized = normalizeStartOperationError(
              error,
              stage,
              requestId,
              {
                operation: options.operation,
                authenticated: actorVerified,
                entity,
                headers: options.request.headers,
              },
            );
            if (normalized.publicError.code === "INTERNAL_SERVER_ERROR") {
              console.error(
                "[start-operation.failure]",
                {
                  operation: options.operation,
                  stage,
                  requestId,
                  cfRayId: options.request.headers.get("cf-ray") ?? undefined,
                },
                normalized.observedError,
              );
            }
            const result: StartOperationResult<z.output<OutputSchema>> = {
              ok: false,
              error: normalized.publicError,
            };
            return {
              result,
              observedError: normalized.observedError,
            };
          } finally {
            if (mutationStarted) {
              await (runtime.recordDatabaseWrite ?? recordDatabaseWrite)(
                options.operation,
              );
            }
          }
        },
      );
      return observed.result;
    });
  };
}

const productionStartOperationRuntime = {
  authenticate: authenticateStartOperation,
  observe: observeOperation,
  markCalendarDirty: (context, headers, operation) => {
    const headerOrigin = headers.get("origin");
    const host = headers.get("host");
    const origin = headerOrigin
      ? new URL(headerOrigin).origin
      : host
        ? `${headers.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https")}://${host}`
        : undefined;
    scheduleCalendarFeedDirty(
      `${context.requestOrigin === "api" ? "api" : "browser"}.${operation}`,
      {
        origin,
      },
    );
  },
  recordDatabaseWrite,
} satisfies StartOperationRuntime;

export const runStartOperation = createStartOperationRunner(
  productionStartOperationRuntime,
);
