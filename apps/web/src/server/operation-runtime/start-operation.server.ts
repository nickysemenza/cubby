import { createLogger } from "@cubby/worker-tracing";
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
  type StartOperationKind,
  startOperationDefinitionFor,
} from "~/lib/start-operation-observability";
import { noteRequestOperation } from "~/server/db/db-observability";
import {
  recordDatabaseWrite,
  registerFreshnessMember,
  memberWriteCookie,
} from "~/server/db/freshness/member-marker";
import { runAfterCommit } from "~/server/db/helpers";
import {
  type ReadPolicy,
  mutationChangesHouseholdData,
  readPolicyFor,
} from "~/server/db/read-policy";
import { scheduleCalendarFeedDirty } from "~/server/domains/calendar/repo/client";
import {
  AppError,
  appErrorFromUnknown,
  createAppError,
  isExpectedAppError,
  toPublicErrorPayload,
} from "~/server/errors/app-error";
import { translateDatabaseError } from "~/server/errors/db-errors";
import {
  reportServerError,
  withErrorReporting,
} from "~/server/errors/report-error";
import { appleClientUpdateError } from "~/server/http/apple-client-gate";
import type {
  Channel,
  DeadlineBudget,
  DeadlineClass,
  Principal,
} from "~/server/http/authenticate";
import {
  actorSpanAttributes,
  type AuthenticatedRequestContext,
  selectOperationContext,
} from "~/server/http/request-context";
import type { RequestOrigin, Workload } from "~/server/http/workload";
import {
  type ObservedFailure,
  type OperationObservation,
  observeOperation,
  parseObservedFailure,
} from "~/server/observability/observed-request";
import {
  type AppSpan,
  cloudflareRayId,
  getRequestId,
} from "~/server/observability/tracing";
import type {
  PublicStartOperationError,
  StartOperationResult,
} from "~/server/operation-runtime/start-operation.contract";

const log = createLogger("start-operation");

export type StartOperationRequest = {
  /** Minted by `authenticate` before any request JSON is read. */
  principal: Principal;
  /** Correlation only (request id, ray); never authority. */
  headers: Headers;
  signal: AbortSignal;
  /** A read that may wait on a model runs against the principal's model-read budget. */
  modelBacked?: boolean;
};

export type AuthenticatedStartOperationContext = AuthenticatedRequestContext;

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

/** What a deadline answer reports about the call it abandoned. */
type RunState = {
  stage: OperationStage;
  mutationStarted: boolean;
  entity: string | undefined;
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

const validationIssues = (error: z.ZodError) =>
  error.issues.map((issue) => ({
    code: issue.code,
    path: issue.path.map((part) =>
      isValidationPathPrimitive(part) ? part : String(part),
    ),
    message: issue.message,
  }));

function normalizePublicError<TError>(
  error: TError,
  stage: OperationStage,
  requestId?: string,
): NormalizedStartOperationError {
  const failure = parseObservedFailure(error);
  if (stage === "output" && failure instanceof z.ZodError) {
    // A handler's result drifted from its declared output: name the path so
    // the caller (often an MCP agent) can report the exact field.
    const publicError: PublicStartOperationError = {
      code: "INTERNAL_SERVER_ERROR",
      reason: "INVALID_OUTPUT",
      message: `Output does not match its schema: ${validationMessage(failure)}`,
      validationIssues: validationIssues(failure),
    };
    if (requestId) publicError.requestId = requestId;
    return { publicError, observedError: failure };
  }
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
      validationIssues: validationIssues(failure),
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

  // A legacy refusal carrier (`{ code, cause: { reason, blockers } }`) with
  // an expected refusal code keeps its classification, as Sentry already
  // does; an infrastructure error's own `code` (`ECONNRESET`) does not.
  const carried = toPublicErrorPayload(failure);
  if (carried.code && failure instanceof Error && isExpectedAppError(failure)) {
    const { code, ...details } = carried;
    const publicError: PublicStartOperationError = {
      code,
      message: failure.message || "The operation could not be completed",
      ...details,
    };
    if (requestId) publicError.requestId = requestId;
    return { publicError, observedError: failure };
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
  const cfRayId = cloudflareRayId(context.headers);
  const chain = context.authenticated
    ? describeErrorCauses(error, { includeStacks: true })
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
 * An outdated Apple build keeps its reads, so one changed shape fails one
 * screen, not the app; a write or a stream could carry a field whose meaning
 * changed, so it is refused with the actionable update message.
 */
export function assertClientMayWrite(principal: Principal): void {
  const outdated = principal.client?.updateRequired;
  if (outdated)
    throw createAppError(
      "CLIENT_UPDATE_REQUIRED",
      appleClientUpdateError(outdated).message,
    );
}

const EXPIRED = Symbol("deadline expired");

const deadlineClassOf = (
  kind: StartOperationKind,
  modelBacked?: boolean,
): DeadlineClass =>
  kind === "mutation" ? "write" : modelBacked ? "modelRead" : "read";

/** The refusal a call that outlived its budget answers with. */
const deadlineExceededError = (name: string, budgetMs: number) =>
  new AppError({
    code: "INTERNAL_SERVER_ERROR",
    reason: "MCP_TOOL_DEADLINE_EXCEEDED",
    message: `${name} did not finish within ${budgetMs / 1000}s`,
  });

/**
 * Race `work` against the principal's budget. On expiry the work's signal
 * aborts and `expired` answers instead; only work that reads the signal stops
 * (AI and upstream fetches), and Postgres work runs on until it finishes or
 * the request ends. A null budget runs `work` unbounded.
 *
 * Work that holds a transaction open must sit inside one budget, never race
 * one from within the transaction: answering early from inside it would roll
 * back under work still using the connection.
 */
async function withinBudget<T>(
  budget: DeadlineBudget | null,
  deadlineClass: DeadlineClass,
  signal: AbortSignal,
  work: (signal: AbortSignal) => Promise<T>,
  expired: (budgetMs: number) => Promise<T>,
): Promise<T> {
  if (!budget) return work(signal);
  const budgetMs = budget.ms[deadlineClass];
  const deadline = new AbortController();
  const pending = work(AbortSignal.any([signal, deadline.signal]));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof EXPIRED>((resolve) => {
    timer = setTimeout(() => resolve(EXPIRED), budgetMs);
  });
  try {
    const settled = await Promise.race([pending, timeout]);
    if (settled !== EXPIRED) return settled;
  } finally {
    clearTimeout(timer);
  }
  deadline.abort(
    new DOMException(`exceeded its ${budgetMs} ms deadline`, "TimeoutError"),
  );
  // SILENT: the abandoned work settles only after the abort above, and its
  // outcome no longer reaches anyone.
  void pending.catch(() => undefined);
  return expired(budgetMs);
}

/**
 * One budget around a composite unit (an MCP batch, a delegated
 * transaction) whose inner calls run through the runner under an unbudgeted
 * principal. On expiry the possible write is recorded here, as the runner's
 * own overrun does, before `expired` answers with the deadline error.
 */
export function withinCompositeBudget<T>(options: {
  principal: Principal;
  name: string;
  kind: "query" | "mutation";
  modelBacked?: boolean;
  signal: AbortSignal;
  work: (unbudgeted: Principal, signal: AbortSignal) => Promise<T>;
  expired: (error: AppError) => T;
  recordWrite?: (operation: string) => Promise<void>;
}): Promise<T> {
  const unbudgeted: Principal = { ...options.principal, budget: null };
  return withinBudget(
    options.principal.budget,
    deadlineClassOf(options.kind, options.modelBacked),
    options.signal,
    (signal) => options.work(unbudgeted, signal),
    async (budgetMs) => {
      log.warn("operation deadline exceeded", {
        operation: options.name,
        budgetMs,
      });
      if (options.kind === "mutation")
        await (options.recordWrite ?? recordDatabaseWrite)(options.name);
      return options.expired(deadlineExceededError(options.name, budgetMs));
    },
  );
}

/** How each client family is observed and names its calendar dirty marks. */
const CHANNEL_OBSERVATION = {
  browser: { origin: "ui", workload: "ui", source: "browser" },
  native: { origin: "api", workload: "other", source: "api" },
  cli: { origin: "api", workload: "other", source: "api" },
  mcp: { origin: "mcp", workload: "mcp", source: "mcp" },
  system: { origin: "api", workload: "other", source: "system" },
} as const satisfies Record<
  Channel,
  { origin: RequestOrigin; workload: Workload; source: string }
>;

export interface StartOperationRuntime {
  observe<Result>(
    definition: { readonly id: string; readonly kind: StartOperationKind },
    observation: OperationObservation<Result>,
    run: (span: AppSpan) => Promise<Result>,
  ): Promise<Result>;
  markCalendarDirty(reason: string, headers: Headers): void;
  /** Best-effort post-write notification; failures never alter the response. */
  recordDatabaseWrite?(operation: string): Promise<void>;
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
const reportSlotInputSchema = z.object({ slot: z.string() });
const reportSlotsInputSchema = z.object({ slots: z.array(z.string()) });

/**
 * An operation outside the generated registry that still runs the whole
 * pipeline: MCP's entity-kernel verbs, named by their tool action
 * (`entity.create`), and test handlers. Its id never shadows a registry id.
 */
export type AdHocOperation = {
  readonly id: string;
  readonly kind: "query" | "mutation";
};

export type RunStartOperationOptions<
  InputSchema extends z.ZodType,
  OutputSchema extends z.ZodType,
> = {
  operation: StartOperationId | AdHocOperation;
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
    /** The request's signal, also aborted when the principal's budget runs out. */
    signal: AbortSignal,
  ) => Promise<z.input<OutputSchema>>;
};

function runnerDefinition(operation: StartOperationId | AdHocOperation) {
  if (typeof operation === "string") {
    const registered = startOperationDefinitionFor(operation);
    return registered && { ...registered, registered: operation };
  }
  if (startOperationDefinitionFor(operation.id))
    throw new Error(`Ad hoc operation ${operation.id} shadows a registry id`);
  return { id: operation.id, kind: operation.kind, registered: undefined };
}

export function createStartOperationRunner(runtime: StartOperationRuntime) {
  const recordWrite = runtime.recordDatabaseWrite ?? recordDatabaseWrite;
  return async function runStartOperation<
    InputSchema extends z.ZodType,
    OutputSchema extends z.ZodType,
  >(
    options: RunStartOperationOptions<InputSchema, OutputSchema>,
  ): Promise<StartOperationResult<z.output<OutputSchema>>> {
    const { principal } = options.request;
    const channel = CHANNEL_OBSERVATION[principal.channel];
    const workload = options.workload ?? channel.workload;
    const definition = runnerDefinition(options.operation);
    if (!definition || definition.kind !== options.type) {
      throw new Error(
        `Unregistered Start operation: ${definition?.id ?? String(options.operation)} (${options.type})`,
      );
    }
    const requestId = getRequestId(options.request.headers);
    const state: RunState = {
      stage: "context",
      mutationStarted: false,
      entity: undefined,
    };
    const failureContext = (): OperationFailureContext => ({
      operation: definition.id,
      authenticated: true,
      entity: state.entity,
      headers: options.request.headers,
    });

    const execute = async (
      span: AppSpan,
      signal: AbortSignal,
    ): Promise<ObservedStartResult<z.output<OutputSchema>>> => {
      try {
        // Client cancellation, not the budget: work that finishes past its
        // deadline still parses its output and schedules its side effects.
        throwIfStartOperationAborted(options.request.signal);
        const authenticated = principal.context;
        registerFreshnessMember(authenticated.auth);
        span.setAttributes({
          "cubby.authenticated": true,
          ...actorSpanAttributes(
            authenticated.auth.sessionId,
            authenticated.actorContext,
          ),
        });
        if (options.type !== "query") assertClientMayWrite(principal);
        state.stage = "input";
        const input = options.inputSchema.parse(options.input);
        const entityInput = operationEntityInputSchema.safeParse(input);
        state.entity =
          entityInput.success &&
          (!definition.registered ||
            isStartOperationEntity(
              definition.registered,
              entityInput.data.entity,
            ))
            ? entityInput.data.entity
            : undefined;
        if (state.entity) span.setAttribute("cubby.entity", state.entity);
        const reportSlot = reportSlotInputSchema.safeParse(input);
        const reportSlots = reportSlotsInputSchema.safeParse(input);
        const slots = reportSlot.success
          ? [reportSlot.data.slot]
          : reportSlots.success
            ? reportSlots.data.slots
            : [];
        const readPolicy =
          options.type !== "query"
            ? "strong"
            : options.readPolicy === "strong"
              ? "strong"
              : readPolicyFor(definition.id, "query", state.entity, slots);
        const context = await selectOperationContext(authenticated, readPolicy);
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

        noteRequestOperation(definition.id, state.entity);
        throwIfStartOperationAborted(options.request.signal);

        state.stage = "run";
        state.mutationStarted =
          options.type === "mutation" &&
          mutationChangesHouseholdData(definition.id);
        const rawOutput = await options.run(context, input, signal);
        throwIfStartOperationAborted(options.request.signal);

        state.stage = "output";
        const outputSchema = isOutputSchemaResolver(options.outputSchema)
          ? options.outputSchema(input)
          : options.outputSchema;
        const data = outputSchema.parse(rawOutput);
        throwIfStartOperationAborted(options.request.signal);
        if (state.mutationStarted) {
          // Inside a delegated transaction the mark waits for the outer
          // commit; marked earlier, the calendar alarm could publish and clear
          // a snapshot that lacks this write.
          await runAfterCommit(context.db, async () => {
            runtime.markCalendarDirty(
              `${channel.source}.${definition.id}`,
              options.request.headers,
            );
          });
        }
        const result: StartOperationResult<z.output<OutputSchema>> = {
          ok: true,
          data,
        };
        return { result };
      } catch (error) {
        if (options.request.signal.aborted)
          throw abortError(options.request.signal);
        // Past its deadline the caller already has its answer; the abandoned
        // work's own late failure is not a second error to report. The span
        // records the overrun (already reported) instead.
        if (signal.aborted)
          return {
            result: {
              ok: false,
              error: {
                code: "INTERNAL_SERVER_ERROR",
                reason: "MCP_TOOL_DEADLINE_EXCEEDED",
                message: "Abandoned after its deadline",
              },
            },
            observedError: parseObservedFailure(signal.reason),
          };
        const normalized = normalizeStartOperationError(
          error,
          state.stage,
          requestId,
          failureContext(),
        );
        // Keep public failure classification outside the native error object,
        // whose boolean error flag can obscure nested diagnostic attributes.
        span.setAttributes({
          "cubby.failure.stage": state.stage,
          "cubby.failure.code": normalized.publicError.code,
          "cubby.failure.reason": normalized.publicError.reason,
        });
        if (normalized.publicError.code === "INTERNAL_SERVER_ERROR") {
          log.error("failure", {
            operation: definition.id,
            stage: state.stage,
            requestId,
            cfRayId: cloudflareRayId(options.request.headers),
            error: normalized.observedError,
          });
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
        if (state.mutationStarted) await recordWrite(definition.id);
      }
    };

    return await withErrorReporting(async () => {
      const observed = await withinBudget(
        principal.budget,
        deadlineClassOf(options.type, options.request.modelBacked),
        options.request.signal,
        (signal) =>
          runtime.observe<ObservedStartResult<z.output<OutputSchema>>>(
            definition,
            {
              origin: channel.origin,
              workload,
              requestId,
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
            (span) => execute(span, signal),
          ),
        async (budgetMs) => {
          log.warn("operation deadline exceeded", {
            operation: definition.id,
            stage: state.stage,
            budgetMs,
            requestId,
          });
          // The work may commit after this answer: keep this member strong
          // for that possible write now; the work records again when it ends.
          if (state.mutationStarted) await recordWrite(definition.id);
          return {
            result: {
              ok: false as const,
              error: normalizeStartOperationError(
                deadlineExceededError(definition.id, budgetMs),
                state.stage,
                requestId,
                failureContext(),
              ).publicError,
            },
          };
        },
      );
      const readMarker = await memberWriteCookie();
      if (readMarker) observed.result.readMarker = readMarker;
      return observed.result;
    });
  };
}

const productionStartOperationRuntime = {
  observe: observeOperation,
  markCalendarDirty: (reason, headers) => {
    const headerOrigin = headers.get("origin");
    const host = headers.get("host");
    const origin = headerOrigin
      ? new URL(headerOrigin).origin
      : host
        ? `${headers.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https")}://${host}`
        : undefined;
    scheduleCalendarFeedDirty(reason, { origin });
  },
  recordDatabaseWrite,
} satisfies StartOperationRuntime;

export const runStartOperation = createStartOperationRunner(
  productionStartOperationRuntime,
);
