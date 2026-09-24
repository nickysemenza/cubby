import type { StartOperationIdOfKind } from "~/lib/generated/start-operation-registry.gen";
import type { StartOperationId } from "~/lib/start-operation-observability";
import type { Database } from "~/server/db";

export type ReadPolicy = "context" | "strong";

/**
 * Queries that require authoritative data or benefit from skipping the
 * freshness RPC before a bounded database read. Everything else uses the
 * request-selected adapter; mutations and workflow streams are strong.
 */
export const STRONG_QUERY_OPERATIONS = [
  // AI and externally hydrated food reads own authoritative database helpers.
  "ai.suggestFields",
  "ai.suggestExternalIdKind",
  "usda-food.alternateId",
  "usda-food.detail",
  "usda-food.list",
  // The shared list snapshot validates against the strong write revision.
  "entity.list",

  // Credentials and live operational state.
  "calendar.getCredential",
  "calendar.getFeed",
  "maintenance.awaitingWork",
  // The dashboard's local snapshot owns its write revision; a failed snapshot
  // falls back to a strong query without paying a separate freshness RPC.
  "dashboard.counts",
  // Audit activity reads live and bypasses the freshness RPC before PostgreSQL.
  "auditLog.list",
  // Home summaries are bounded, single-round-trip reads. Asking the freshness
  // Durable Object first adds another network hop before these short queries.
  "expense.monthlySummary",
  "location.valuationSummary",
  "meal.getNutrition",
  "meal.upcomingSummary",
  "task.todayBriefing",
  "calendar.inspectFeed",
  "oauth.countOrphanedClients",
  "oauth.listConnectedApps",
  "statementRow.imports",
  "statementRow.list",
  "statementRow.summary",

  // Interactive inventory work and integrity/repair diagnostics.
  "entity.inspectorHealth",
  "inventory.findDuplicates",
  "inventory.getByLocationIds",
  "problems.dryRunPruneAliases",
  "problems.dryRunReparse",
  "problems.getCounts",
  "problems.getMaintenanceCounts",
  "search.debug",

  // Reads that drive imports or delegate to modules owning a strong database.
  "recipe.dryRunRecomputeTotals",
  "recipe.explainCosting",
  "recipe.getCookbookDiff",
  "recipe.getCookbookSource",
  "recipe.previewNotionSync",
] as const satisfies readonly StartOperationIdOfKind<"query">[];

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
