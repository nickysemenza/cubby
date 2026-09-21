import type { FlueObservation } from "@flue/runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  clampRate,
  createSentryObservation,
  purchaseAgentSentryOptions,
  type SentryReporter,
  type SentryScopeLike,
} from "./sentry-bridge";

const scope: SentryScopeLike = {
  setTags: vi.fn(),
  setLevel: vi.fn(),
  setContext: vi.fn(),
};
const captureException = vi.fn<SentryReporter["captureException"]>();
const addBreadcrumb = vi.fn<SentryReporter["addBreadcrumb"]>();
const logger: SentryReporter["logger"] = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

const reporter: SentryReporter = {
  captureException,
  addBreadcrumb,
  logger,
  withScope: (callback) => callback(scope),
};

const observe = createSentryObservation(reporter);

const base = {
  v: 3,
  eventIndex: 1,
  timestamp: "2026-09-21T00:00:00.000Z",
  instanceId: "import-run:run-1",
  agentName: "PurchaseImportRun",
  conversationId: "conversation-1",
} as const;

function observation(event: Partial<FlueObservation>): FlueObservation {
  // SAFETY: each test supplies a complete variant of the discriminated union;
  // the cast only spares repeating the shared event envelope per case.
  return { ...base, ...event } as FlueObservation;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("purchase-agent Sentry bridge", () => {
  it("captures a failed operation once and skips its settlement duplicate", () => {
    const failure = new Error("tool exploded");
    observe(
      observation({
        type: "operation",
        operationId: "op-1",
        operationKind: "prompt",
        durationMs: 1200,
        isError: true,
        error: failure,
        submissionId: "submission-1",
      }),
    );
    observe(
      observation({
        type: "submission_settled",
        submissionId: "submission-1",
        outcome: "failed",
        error: { message: "internal error" },
      }),
    );

    expect(captureException).toHaveBeenCalledOnce();
    expect(captureException).toHaveBeenCalledWith(failure);
    expect(scope.setTags).toHaveBeenCalledWith({
      "flue.instance.id": "import-run:run-1",
      "flue.agent.name": "PurchaseImportRun",
      "flue.conversation.id": "conversation-1",
      "flue.submission.id": "submission-1",
      "flue.operation.id": "op-1",
    });
    expect(scope.setContext).toHaveBeenCalledWith("flue.incident", {
      durationMs: 1200,
      operationKind: "prompt",
    });
  });

  it("captures a failed settlement that had no live operation failure", () => {
    observe(
      observation({
        type: "submission_settled",
        submissionId: "submission-2",
        outcome: "failed",
        errorInfo: {
          type: "SubmissionTimeoutError",
          name: "SubmissionTimeoutError",
          message: "deadline exceeded",
        },
      }),
    );

    expect(captureException).toHaveBeenCalledOnce();
    const captured = captureException.mock.calls[0]?.[0];
    expect(captured).toBeInstanceOf(Error);
    expect(captured).toMatchObject({
      name: "SubmissionTimeoutError",
      message: "deadline exceeded",
    });
  });

  it("ignores completed settlements", () => {
    observe(
      observation({
        type: "submission_settled",
        submissionId: "submission-3",
        outcome: "completed",
      }),
    );
    expect(captureException).not.toHaveBeenCalled();
  });

  it("records coordinator recovery as a breadcrumb, not an issue", () => {
    observe(
      observation({
        type: "submission_recovery",
        submissionId: "submission-4",
        operation: "process_submission",
        outcome: "agent_unavailable",
        attemptCount: 2,
        maxAttempts: 5,
      }),
    );

    expect(captureException).not.toHaveBeenCalled();
    expect(addBreadcrumb).toHaveBeenCalledWith({
      category: "flue.submission_recovery",
      level: "warning",
      message: "process_submission: agent_unavailable",
      data: {
        "flue.instance.id": "import-run:run-1",
        "flue.agent.name": "PurchaseImportRun",
        "flue.conversation.id": "conversation-1",
        "flue.submission.id": "submission-4",
        "flue.recovery.operation": "process_submission",
        "flue.recovery.outcome": "agent_unavailable",
        "flue.recovery.attempt_count": 2,
        "flue.recovery.max_attempts": 5,
      },
    });
  });

  it("forwards logs at their level with scrubbed, prefixed attributes", () => {
    observe(
      observation({
        type: "log",
        level: "warn",
        message: "vendor sync slowed down",
        attributes: {
          vendor: "costco",
          retries: 2,
          token: "abc123",
          nested: { password: "hunter2", ok: true },
          cause: new Error("upstream timeout"),
        },
      }),
    );

    expect(logger.warn).toHaveBeenCalledWith("vendor sync slowed down", {
      "flue.instance.id": "import-run:run-1",
      "flue.agent.name": "PurchaseImportRun",
      "flue.conversation.id": "conversation-1",
      "flue.log.vendor": "costco",
      "flue.log.retries": 2,
      "flue.log.token": "[redacted]",
      "flue.log.nested": JSON.stringify({ password: "[redacted]", ok: true }),
      "flue.log.cause": JSON.stringify({
        name: "Error",
        message: "upstream timeout",
      }),
    });
    expect(captureException).not.toHaveBeenCalled();
  });

  it("disables reporting for the test environment and tags the service", () => {
    expect(
      purchaseAgentSentryOptions({ SENTRY_ENVIRONMENT: "test" }, 0),
    ).toMatchObject({ enabled: false, tracesSampleRate: 0 });
    expect(
      purchaseAgentSentryOptions({ SENTRY_ENVIRONMENT: "production" }, 1),
    ).toMatchObject({
      enabled: true,
      environment: "production",
      sendDefaultPii: false,
      initialScope: { tags: { service: "purchase-agent" } },
    });
  });

  it("clamps sample rates read from Worker vars", () => {
    expect(clampRate("1", 0)).toBe(1);
    expect(clampRate("0.25", 0)).toBe(0.25);
    expect(clampRate(undefined, 0)).toBe(0);
    expect(clampRate("2", 0)).toBe(0);
    expect(clampRate("nope", 0)).toBe(0);
  });
});
