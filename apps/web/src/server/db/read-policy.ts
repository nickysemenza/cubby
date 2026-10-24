import type { StartOperationId } from "~/lib/start-operation-observability";

export type ReadPolicy = "context" | "strong";

/**
 * Interactive operations read authoritative data without a freshness RPC.
 * Specialized snapshot/external-service readers select their own sources.
 */
export function readPolicyFor(
  _operation: string,
  _kind: "query" | "mutation",
): ReadPolicy {
  return "strong";
}

/** This maintenance request changes only its strong-read cooldown claim. */
export function mutationChangesHouseholdData(operation: string): boolean {
  return operation !== "maintenance.requestCatchUp";
}

const calendarMutationPolicies = new Map<StartOperationId, "publish" | "skip">([
  // Metadata repair still publishes reader hints, but changes no calendar input.
  ["sourceTransactionRecord.backfillProviderId", "skip"],
]);

export function calendarMutationPolicy(
  operation: StartOperationId | undefined,
): "publish" | "skip" {
  return operation
    ? (calendarMutationPolicies.get(operation) ?? "publish")
    : "publish";
}
