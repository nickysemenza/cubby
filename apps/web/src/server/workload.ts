const workloadKinds = ["ui", "mcp", "queue", "import-stream", "other"] as const;

export type Workload = (typeof workloadKinds)[number];
export type RequestOrigin = "ui" | "api" | "mcp" | "agent";

/**
 * Coarse workload for the Worker entry span. Procedure-level tRPC spans refine
 * streamed operations once their async-iterable result is available.
 */
export function classifyHttpWorkload(
  pathname: string,
  headers?: Pick<Headers, "get">,
): Workload {
  if (pathname === "/api/mcp") return "mcp";
  // Only the browser tRPC client adds this header. Keeping API, agent, and
  // MCP callers out of UI aggregates makes request-duration SLOs actionable.
  if (pathname.startsWith("/api/trpc")) {
    return headers?.get("x-trpc-source") === "tanstack-start" ? "ui" : "other";
  }
  if (pathname.startsWith("/api/") || pathname.startsWith("/_serverFn/")) {
    return "other";
  }
  const accept = headers?.get("accept") ?? "";
  const fetchMode = headers?.get("sec-fetch-mode") ?? "";
  // Static assets and arbitrary non-browser fetches must not inflate browser
  // latency. A real document request advertises HTML and/or navigation mode.
  return accept.includes("text/html") || fetchMode === "navigate"
    ? "ui"
    : "other";
}

/** Every procedure that deliberately returns an async generator over JSONL. */
export const importStreamProcedures = new Set([
  "agent.askStream",
  "ai.backfillLocationDescriptions",
  "ai.precomputeEnrichmentProposals",
  "problems.pruneAllUnusedAliasesStream",
  "problems.reparseStale",
  "product.backfillUPCImages",
  "product.createMany",
  "product.markUsdaUnavailableMany",
  "recipe.importCookbookStream",
  "recipe.importNotionSyncStream",
  "recipe.recomputeAllDurable",
  "recipe.recomputeStaleDurable",
  "recipe.reprocessCookbook",
]);

const isAsyncIterable = (value: unknown): boolean =>
  value !== null &&
  typeof value === "object" &&
  Symbol.asyncIterator in value &&
  typeof value[Symbol.asyncIterator] === "function";

/** Normalize tRPC caller identity and streamed output into one dashboard key. */
export function classifyTrpcWorkload(
  origin: RequestOrigin,
  path?: string,
  output?: unknown,
): Workload {
  if (origin === "mcp") return "mcp";
  if (path && importStreamProcedures.has(path) && isAsyncIterable(output)) {
    return "import-stream";
  }
  if (origin === "ui") return "ui";
  return "other";
}
