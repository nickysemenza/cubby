const workloadKinds = ["ui", "mcp", "queue", "import-stream", "other"] as const;

export type Workload = (typeof workloadKinds)[number];
export type RequestOrigin = "ui" | "api" | "mcp" | "agent";

/**
 * Coarse workload for the Worker entry span. Procedure-level tRPC spans refine
 * streamed operations once their async-iterable result is available.
 */
export function classifyHttpWorkload(pathname: string): Workload {
  if (pathname === "/api/mcp") return "mcp";
  if (pathname.startsWith("/api/debug/")) return "other";
  return "ui";
}

const isAsyncIterable = (value: unknown): boolean =>
  value !== null &&
  typeof value === "object" &&
  Symbol.asyncIterator in value &&
  typeof value[Symbol.asyncIterator] === "function";

/** Normalize tRPC caller identity and streamed output into one dashboard key. */
export function classifyTrpcWorkload(
  origin: RequestOrigin,
  output?: unknown,
): Workload {
  if (origin === "mcp") return "mcp";
  if (isAsyncIterable(output)) return "import-stream";
  if (origin === "ui") return "ui";
  return "other";
}
