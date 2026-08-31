import type { StartOperationIdOfKind } from "~/lib/generated/start-operation-registry.gen";
import type { StartOperationId } from "~/lib/start-operation-observability";
import type { Database } from "~/server/db";

export type BrowserReadPolicy = "context" | "strong";

/**
 * Browser queries that cannot tolerate even the short bounded-stale window.
 * Everything else uses the request-selected adapter; mutations and workflow
 * streams are made strong independently of this registry.
 */
export const STRONG_BROWSER_QUERY_OPERATIONS = [
  // AI and externally hydrated food reads own authoritative database helpers.
  "ai.suggestCategory",
  "ai.suggestLocation",
  "ai.suggestLocationType",
  "ai.usageRecent",
  "ai.usageSummary",
  "usda-food.alternateId",
  "usda-food.detail",
  "usda-food.list",

  // Credentials, audit history, and live operational state.
  "auditLog.list",
  "background-batch.jobs",
  "background-batch.list",
  "background-batch.summary",
  "background-job.strandedCount",
  "calendar.getFeed",
  "mcp.listTools",
  "mcp.usageActivity",
  "mcp.usageDashboard",
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
  "problems.getByType",
  "problems.getCounts",
  "problems.getCoverage",
  "problems.getCoverageTotals",
  "problems.getFast",
  "problems.getMaintenanceCounts",
  "problems.getTracker",
  "problems.getUpc",
  "problems.getViews",
  "problems.recipeUsageByProduct",
  "search.debug",
  "search.documentHealth",

  // Reads that drive imports or delegate to modules owning a strong database.
  "meal.getShoppingList",
  "recipe.dryRunRecomputeTotals",
  "recipe.explainCosting",
  "recipe.getCookbookDiff",
  "recipe.getCookbookSource",
  "recipe.previewNotionSync",
  "suggestions.getMakeable",
  "suggestions.getRecipeAvailability",
] as const satisfies readonly StartOperationIdOfKind<"query">[];

const strongBrowserQueryOperations = new Set<StartOperationId>(
  STRONG_BROWSER_QUERY_OPERATIONS,
);

export function browserReadPolicyFor(
  operation: StartOperationId,
  kind: "query" | "mutation",
): BrowserReadPolicy {
  return kind === "mutation" || strongBrowserQueryOperations.has(operation)
    ? "strong"
    : "context";
}

/**
 * Give an operation exactly one database adapter. This prevents a handler from
 * bypassing the selected policy by reaching for the other request handle.
 */
export function applyBrowserReadPolicy<
  Context extends { db: Database; readDb: Database },
>(context: Context, policy: BrowserReadPolicy) {
  const selected = policy === "strong" ? context.db : context.readDb;
  return context.db === selected && context.readDb === selected
    ? context
    : { ...context, db: selected, readDb: selected };
}
