// flue-blueprint: tooling/sentry@1
//
// The runtime-free half of the purchase agent's Sentry integration, ported
// from Flue's official tooling/sentry blueprint (withastro/flue,
// blueprints/tooling--sentry.md): the shared SDK options and the observe
// bridge that turns Flue's event stream into Sentry issues, breadcrumbs, and
// logs. `sentry.ts` wires it into the Worker; this module imports nothing
// that needs workerd, so the unit test can drive it with a fake reporter.
import { CUBBY_SENTRY_DSN } from "@cubby/worker-tracing/sentry-dsn";
import type { FlueObservation } from "@flue/runtime";
import type * as Sentry from "@sentry/cloudflare";
import { z } from "zod";

export interface SentryAgentEnv {
  SENTRY_ENVIRONMENT?: string;
  SENTRY_TRACES_SAMPLE_RATE?: string;
}

type LogAttributes = NonNullable<Parameters<typeof Sentry.logger.info>[1]>;

export interface SentryScopeLike {
  setTags(tags: CorrelationTags): void;
  setLevel(level: "error"): void;
  setContext(name: string, context: TerminalFailureContext): void;
}

/**
 * The Sentry surface the bridge uses. `sentry.ts` passes the real SDK
 * namespace; the unit test passes a fake with the same shape.
 */
export interface SentryReporter {
  captureException(error: Error): string;
  withScope(callback: (scope: SentryScopeLike) => void): void;
  addBreadcrumb(breadcrumb: Sentry.Breadcrumb): void;
  logger: Record<
    "info" | "warn" | "error",
    (message: string, attributes?: LogAttributes) => void
  >;
}

// Type aliases, not interfaces: Sentry's `Context` and tag dictionaries are
// index-signature types, which only object-literal aliases are assignable to.
type TerminalFailureContext = {
  durationMs: number;
  operationKind: string;
};

// Sentry ships integrations that patch AI provider SDKs directly. Flue's
// instrumentation already emits one `chat` span per model turn, so those
// integrations would double-count every model call.
const SENTRY_AI_PROVIDER_INTEGRATIONS = new Set([
  "Anthropic_AI",
  "OpenAI",
  "Google_GenAI",
  "LangChain",
  "LangGraph",
  "VercelAI",
]);

/** The Sentry options shared by the agent Durable Object and the queue consumer. */
export function purchaseAgentSentryOptions(
  bindings: SentryAgentEnv,
  tracesSampleRate: number,
): Sentry.CloudflareOptions {
  return {
    dsn: CUBBY_SENTRY_DSN,
    // "test" is what the workerd harness sets; every SDK call becomes a no-op.
    enabled: bindings.SENTRY_ENVIRONMENT !== "test",
    environment: bindings.SENTRY_ENVIRONMENT,
    sendDefaultPii: false,
    tracesSampleRate,
    initialScope: { tags: { service: "purchase-agent" } },
    integrations: (defaults) =>
      defaults.filter(
        (integration) => !SENTRY_AI_PROVIDER_INTEGRATIONS.has(integration.name),
      ),
  };
}

/** A `0`–`1` sample rate from a Worker var; anything else becomes `fallback`. */
export function clampRate(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1
    ? parsed
    : fallback;
}

/**
 * The observe half of the bridge.
 *
 * Issues are limited to terminal failures: a failed top-level agent operation
 * or a failed durable submission settlement. A failed submission emits a rich
 * `operation` failure first (the original error, with the throw-site stack on
 * the live `errorInfo`) and then a `submission_settled` whose durable `error`
 * collapses non-Flue causes to a generic internal-error payload. Capture the
 * operation and remember its submissionId so the settlement is skipped; a
 * settlement with no captured operation (reconciled after a crash) is captured
 * from its own `errorInfo`. Recovered errors an agent logs and moves past
 * arrive in Sentry Logs, not as issues.
 */
export function createSentryObservation(
  reporter: SentryReporter,
): (event: FlueObservation) => void {
  const capturedFailedSubmissions = new Set<string>();

  function captureTerminalFailure(
    error: Error,
    tags: CorrelationTags,
    context?: TerminalFailureContext,
  ): void {
    reporter.withScope((scope) => {
      scope.setTags(tags);
      scope.setLevel("error");
      if (context) scope.setContext("flue.incident", context);
      reporter.captureException(error);
    });
  }

  return (event) => {
    if (event.type === "operation" && event.isError) {
      captureTerminalFailure(terminalError(event), correlationTags(event), {
        durationMs: event.durationMs,
        operationKind: event.operationKind,
      });
      if (event.submissionId) capturedFailedSubmissions.add(event.submissionId);
      return;
    }
    if (event.type === "submission_settled") {
      const alreadyCaptured = capturedFailedSubmissions.delete(
        event.submissionId,
      );
      if (event.outcome === "failed" && !alreadyCaptured) {
        captureTerminalFailure(terminalError(event), correlationTags(event));
      }
      return;
    }
    if (event.type === "submission_recovery") {
      reporter.addBreadcrumb(recoveryBreadcrumb(event));
      return;
    }
    if (event.type === "log") {
      reporter.logger[event.level](event.message, logAttributes(event));
    }
  };
}

// A coordinator retrying or reconciling a stuck submission — not yet a
// terminal outcome, and 'deferred'/'agent_unavailable' recur on every retry
// wake, so this stays a breadcrumb rather than a captured issue. The one
// terminal outcome, 'terminated', always co-occurs with a `submission_settled`
// outcome:'failed' event that the bridge already captures; recording it here
// too would duplicate that issue.
function recoveryBreadcrumb(
  event: Extract<FlueObservation, { type: "submission_recovery" }>,
): Sentry.Breadcrumb {
  const data: Sentry.Breadcrumb["data"] = {
    ...correlationTags(event),
    "flue.recovery.operation": event.operation,
    "flue.recovery.outcome": event.outcome,
  };
  if (event.attemptCount !== undefined) {
    data["flue.recovery.attempt_count"] = event.attemptCount;
  }
  if (event.maxAttempts !== undefined) {
    data["flue.recovery.max_attempts"] = event.maxAttempts;
  }
  if (event.errorInfo) data["error.type"] = event.errorInfo.type;
  return {
    category: "flue.submission_recovery",
    level: event.outcome === "terminated" ? "error" : "warning",
    message: `${event.operation}: ${event.outcome}`,
    data,
  };
}

// Flue's live `errorInfo` carries the throw-site stack; the durable
// `submission_settled.error` and a raw thrown value are the fallbacks.
const errorInfoSchema = z.object({
  name: z.string().optional(),
  message: z.string().optional(),
  stack: z.string().optional(),
});

const terminalErrorSchema = z.union([
  z.instanceof(Error),
  errorInfoSchema.transform((info) => {
    const error = new Error(info.message ?? info.name ?? "Flue failure");
    if (info.name) error.name = info.name;
    if (info.stack) error.stack = info.stack;
    return error;
  }),
  z.string().transform((message) => new Error(message)),
]);

function terminalError(
  event: Extract<
    FlueObservation,
    { type: "operation" } | { type: "submission_settled" }
  >,
): Error {
  const parsed = terminalErrorSchema.safeParse(event.errorInfo ?? event.error);
  return parsed.success
    ? parsed.data
    : new Error(`${event.type} failed without a decodable error`);
}

// Tag keys use the `flue.*` prefix — the same names the trace spans carry —
// so pivoting on `flue.instance.id` in Sentry's search finds every issue,
// log, and span from a single agent instance.
type CorrelationTags = {
  "flue.instance.id"?: string;
  "flue.agent.name"?: string;
  "flue.conversation.id"?: string;
  "flue.submission.id"?: string;
  "flue.harness"?: string;
  "flue.session"?: string;
  "flue.parent_session"?: string;
  "flue.operation.id"?: string;
  "flue.task.id"?: string;
};

function correlationTags(event: FlueObservation): CorrelationTags {
  const tags: CorrelationTags = {};
  if (event.instanceId) tags["flue.instance.id"] = event.instanceId;
  if (event.agentName) tags["flue.agent.name"] = event.agentName;
  if (event.conversationId) tags["flue.conversation.id"] = event.conversationId;
  if (event.submissionId) tags["flue.submission.id"] = event.submissionId;
  if (event.harness) tags["flue.harness"] = event.harness;
  if (event.session) tags["flue.session"] = event.session;
  if (event.parentSession) tags["flue.parent_session"] = event.parentSession;
  if (event.operationId) tags["flue.operation.id"] = event.operationId;
  if (event.taskId) tags["flue.task.id"] = event.taskId;
  return tags;
}

const SENSITIVE_KEY =
  /api[-_]?key|authorization|cookie|dsn|password|secret|token/i;
const REDACTED = "[redacted]";

const logAttributeSchema = z.union([z.string(), z.number(), z.boolean()]);

// Every log attribute reaches Sentry as a primitive: primitives pass through,
// anything structured is JSON-serialized with sensitive keys redacted at
// every depth. `Error` values keep their name and message only.
function logAttributes(
  event: Extract<FlueObservation, { type: "log" }>,
): LogAttributes {
  const attributes: LogAttributes = { ...correlationTags(event) };
  for (const [key, value] of Object.entries(event.attributes ?? {})) {
    const attribute = `flue.log.${key}`;
    if (SENSITIVE_KEY.test(key)) {
      attributes[attribute] = REDACTED;
      continue;
    }
    const primitive = logAttributeSchema.safeParse(value);
    attributes[attribute] = primitive.success
      ? primitive.data
      : serializeStructured(value);
  }
  return attributes;
}

function serializeStructured(
  value: NonNullable<
    Extract<FlueObservation, { type: "log" }>["attributes"]
  >[string],
): string {
  const subject =
    value instanceof Error
      ? { name: value.name, message: value.message }
      : value;
  try {
    return (
      JSON.stringify(subject, (key, nested) =>
        SENSITIVE_KEY.test(key) ? REDACTED : nested,
      ) ?? String(subject)
    );
  } catch {
    return "[unserializable]";
  }
}
