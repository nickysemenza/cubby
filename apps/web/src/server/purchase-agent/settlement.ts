import type { PiOperationResult } from "agents/harness/pi";

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
 * review. An unanswered one terminalizes the run.
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
