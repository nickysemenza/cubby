import { STRONG_QUERY_OPERATIONS } from "~/lib/generated/start-operation-registry.gen";
import type { StartOperationId } from "~/lib/start-operation-observability";
import type { Database } from "~/server/db";

export type ReadPolicy = "context" | "strong";

/**
 * Queries declare `readPolicy: "strong"` on their contract member; the
 * generator collects them. Everything else uses the request-selected adapter;
 * mutations and workflow streams are strong.
 */
const strongQueryOperations = new Set<StartOperationId>(
  STRONG_QUERY_OPERATIONS,
);

export function readPolicyFor(
  operation: StartOperationId,
  kind: "query" | "mutation",
): ReadPolicy {
  return kind === "mutation" || strongQueryOperations.has(operation)
    ? "strong"
    : "context";
}

/** This maintenance request changes only its strong-read cooldown claim. */
export function mutationChangesHouseholdData(
  operation: StartOperationId,
): boolean {
  return operation !== "maintenance.requestCatchUp";
}

/**
 * Give an operation exactly one database adapter. This prevents a handler from
 * bypassing the selected policy by reaching for the other request handle.
 */
export function applyReadPolicy<
  Context extends { db: Database; readDb: Database },
>(context: Context, policy: ReadPolicy) {
  const selected = policy === "strong" ? context.db : context.readDb;
  return context.db === selected && context.readDb === selected
    ? context
    : { ...context, db: selected, readDb: selected };
}
