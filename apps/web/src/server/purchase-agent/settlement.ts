import type { AgentConversationSettlement } from "@cubby/schemas/agent-conversation";
import type { reconcileSettledRunInput } from "@cubby/schemas/purchase-agent-services";
import type { PiHarness, PiOperationResult } from "agents/harness/pi";
import type { z } from "zod";

import type { RunServices } from "./environment";

export type SettlementReport =
  | { kind: "reconcile" }
  | {
      kind: "fail";
      failureCode: "agent_failed" | "agent_aborted";
      detail: string;
    };

/**
 * A finished submission is not a finished run: the coordinator may simply have
 * stopped calling tools, so an answered one goes to the server's reconcile,
 * which knows whether a browser command is still in flight or the run needs
 * review. An unanswered one fails the run, behind the same wake fence.
 */
export function settlementReport(result: PiOperationResult): SettlementReport {
  if (result.status === "done") return { kind: "reconcile" };
  if (result.reason === "aborted")
    return {
      kind: "fail",
      failureCode: "agent_aborted",
      detail: "Coordinator aborted",
    };
  return {
    kind: "fail",
    failureCode: "agent_failed",
    detail: `Coordinator unanswered: ${result.reason ?? "unknown"}`,
  };
}

/** What the run's Durable Object knows about its own submissions. */
export type SubmissionLedger = {
  /** The operation id of the newest accepted submission. */
  latest(): string | undefined;
  /** Every queue event id this agent has received for its run. */
  receivedEventIds(): string[];
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
  const settled: AgentConversationSettlement = {
    operationId,
    outcome: result.status,
  };
  if (result.reason) settled.reason = result.reason;
  deps.onSettled(settled);
  if (deps.submissions.latest() !== operationId) return "done";
  if (pending.length > 0) return "retry";
  const outcome = settlementReport(result);
  const settledId = `submission-settled:${operationId}`;
  // Both outcomes pass the server's wake fence: a run with a wake still
  // queued for this agent is neither reviewed nor failed by this report.
  const input: z.input<typeof reconcileSettledRunInput> = {
    operationId: settledId,
    receivedEventIds: deps.submissions.receivedEventIds(),
  };
  if (outcome.kind === "fail")
    input.failure = {
      failureCode: outcome.failureCode,
      detail: outcome.detail,
    };
  try {
    const reconciled = await deps.services.reconcileSettledRun(input);
    if (outcome.kind === "fail" && reconciled.reconciled)
      await deps.services.updateAgentProgress({
        eventId: settledId,
        phase: "review",
        detail: outcome.detail,
      });
  } catch (error) {
    // The report failed (a database or network fault); try again.
    deps.report(error);
    return "retry";
  }
  return "done";
}
