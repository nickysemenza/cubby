import type { AgentConversationSettlement } from "@cubby/schemas/agent-conversation";
import type {
  AgentFailureCode,
  reconcileSettledRunInput,
} from "@cubby/schemas/purchase-agent-services";
import type { RunProgressStamp } from "@cubby/schemas/run-fields";
import type { PiHarness, PiOperationResult } from "agents/harness/pi";
import type { z } from "zod";

import type { RunServices } from "./environment";

export type SettlementReport =
  | { kind: "reconcile" }
  | { kind: "fail"; failureCode: AgentFailureCode; detail: string };

/**
 * Harness stops that a fresh conversation outlives. `restart_limit` is pi
 * parking a task that crashes, evictions or resets cut off five times in a
 * row; a deploy did this to six Runs at once (2026-11-09). `interrupted` is a
 * restart cutting off a turn or tool call mid-run. The per-revision attempt
 * bound still caps a task that crashes every time.
 */
const TRANSIENT_HARNESS_REASONS = new Set([
  "stale",
  "reset",
  "restart_limit",
  "interrupted",
]);
/**
 * Provider, gateway and database faults a later attempt can outlive: retryable
 * HTTP statuses (as `classifyJobFailure` treats provider capacity), deadlines,
 * egress and overload, and connection or serialization faults. Anything else,
 * such as a tool-validation loop or a refused tool call, recurs on retry.
 */
const TRANSIENT_ERROR =
  /^\s*(?:error:?\s*)?(?:408|409|425|429|5\d\d)\b|\((?:408|409|425|429|5\d\d)\)|\b(?:status|HTTP)(?: code)?\s*[:=]?\s*(?:408|409|425|429|5\d\d)\b|\b(?:408|409|425|429|5\d\d) status\b|\b(?:deadline|time(?:d)? ?out|timeout|egress|overload(?:ed)?|(?:temporarily|service) unavailable|bad gateway|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|socket hang up|network|connection (?:reset|refused|closed|terminated|error)|terminating connection|too many connections|deadlock|could not serialize|SQLSTATE (?:08|40|53|57))/iu;

/**
 * An explicit authentication or authorization refusal (401/403) recurs until
 * someone changes a credential or grant, whatever transient wording it carries
 * ("HTTP 403: network access denied"), as a gateway configuration stop does.
 */
const AUTHORIZATION_ERROR =
  /^\s*(?:error:?\s*)?(?:401|403)\b|\b(?:status|HTTP)(?: code)?\s*[:=]?\s*(?:401|403)\b|\b(?:401|403) (?:status|unauthori[sz]ed|forbidden)\b|\bunauthori[sz]ed\b|\bforbidden\b/iu;

const DETAIL_ERROR_MAX = 2_000;

/**
 * Which retry policy a failed coordinator gets. A funding stop is classified
 * before this (`fundingUnavailable`) and pauses instead; an authorization
 * refusal wins over every transient signal.
 */
function coordinatorFailureCode(
  reason: string | undefined,
  lastError: string | undefined,
): Exclude<AgentFailureCode, "agent_aborted"> {
  if (lastError !== undefined && AUTHORIZATION_ERROR.test(lastError))
    return "agent_failed";
  return (reason && TRANSIENT_HARNESS_REASONS.has(reason)) ||
    (lastError !== undefined && TRANSIENT_ERROR.test(lastError))
    ? "agent_transient"
    : "agent_failed";
}

/**
 * Research's yield hook continues runnable work before a normal answer settles.
 * A finished submission still passes the server's browser/wake fences; failures,
 * aborts and exhausted execution bounds retain this reconciliation backstop.
 * A failure names its class, Pi's reason and the last model or tool error the
 * submission recorded, verbatim (raw diagnostics).
 */
export function settlementReport(
  result: PiOperationResult,
  lastError?: string,
): SettlementReport {
  if (result.status === "done") return { kind: "reconcile" };
  if (result.reason === "aborted")
    return {
      kind: "fail",
      failureCode: "agent_aborted",
      detail: "Coordinator aborted",
    };
  const failureCode = coordinatorFailureCode(result.reason, lastError);
  const error = lastError?.trim()
    ? lastError.trim().slice(0, DETAIL_ERROR_MAX)
    : "no model or tool error recorded";
  return {
    kind: "fail",
    failureCode,
    detail: `Coordinator ${failureCode === "agent_transient" ? "transient" : "deterministic"} failure (${result.reason ?? "unknown"}): ${error}`,
  };
}

/** What the run's Durable Object knows about its own submissions. */
export type SubmissionLedger = {
  /** The operation id of the newest accepted submission. */
  latest(): string | undefined;
  progressStamp(operationId: string): RunProgressStamp;
  /** Every queue event id this agent has received for its run. */
  receivedEventIds(): string[];
  /** A host generation allowance stopped research; unfinished work needs review. */
  reviewDetail?(): string | undefined;
  /** This submission's own last model turn found no paid funding. */
  fundingUnavailable?(operationId: string): boolean;
  /** The last model error or failed tool result this submission recorded. */
  lastFailure?(operationId: string): string | undefined;
};

/**
 * Report one settled submission, or say it must be checked again.
 *
 * Only the newest submission speaks for the run, and only once the
 * conversation is idle: an older one reports nothing, and the newest waits
 * for older work still unwinding. The report lists every event the agent has
 * received, so the server can tell a stop from a wake still in its queue.
 */
export async function reportSettlement(
  deps: {
    harness: Pick<PiHarness, "pending" | "wait">;
    services: Pick<RunServices, "reconcileSettledRun" | "updateAgentProgress">;
    submissions: SubmissionLedger;
    onSettled: (settled: AgentConversationSettlement) => void;
    report: <TError>(error: TError) => void;
  },
  operationId: string,
): Promise<"retry" | "done"> {
  const pending = await deps.harness.pending();
  if (pending.some((operation) => operation.operationId === operationId))
    return "retry";
  const result = await deps.harness.wait(operationId);
  // An operation receipt can be done while the host has stopped a later
  // generation. Retain the durable stop reason across either SDK outcome.
  const reviewDetail =
    result.reason !== "aborted" ? deps.submissions.reviewDetail?.() : undefined;
  const settled: AgentConversationSettlement = {
    operationId,
    outcome: result.status,
  };
  if (reviewDetail) settled.reason = reviewDetail;
  else if (result.reason) settled.reason = result.reason;
  deps.onSettled(settled);
  if (deps.submissions.latest() !== operationId) return "done";
  if (pending.length > 0) return "retry";
  const outcome = settlementReport(
    result,
    deps.submissions.lastFailure?.(operationId),
  );
  const settledId = `submission-settled:${operationId}`;
  // Both outcomes pass the server's wake fence: a run with a wake still
  // queued for this agent is neither reviewed nor failed by this report.
  try {
    const stamp = deps.submissions.progressStamp(operationId);
    const input: z.input<typeof reconcileSettledRunInput> = {
      ...stamp,
      operationId: settledId,
      receivedEventIds: deps.submissions.receivedEventIds(),
    };
    if (reviewDetail) input.detail = reviewDetail;
    else if (outcome.kind === "fail") {
      input.failure = {
        failureCode: outcome.failureCode,
        detail: outcome.detail,
      };
      if (
        outcome.failureCode !== "agent_aborted" &&
        deps.submissions.fundingUnavailable?.(operationId)
      )
        input.fundingUnavailable = true;
    }
    const reconciled = await deps.services.reconcileSettledRun(input);
    if (reconciled.reconciled && (reviewDetail || outcome.kind === "fail"))
      await deps.services.updateAgentProgress({
        eventId: settledId,
        ...stamp,
        phase: "review",
        detail:
          reviewDetail ??
          (outcome.kind === "fail" ? outcome.detail : undefined),
      });
  } catch (error) {
    // The report failed (a database or network fault); try again.
    deps.report(error);
    return "retry";
  }
  return "done";
}
