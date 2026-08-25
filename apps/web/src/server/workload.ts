const workloadKinds = ["ui", "mcp", "queue", "import-stream", "other"] as const;

export type Workload = (typeof workloadKinds)[number];
export type RequestOrigin = "ui" | "api" | "mcp" | "agent";

/** Coarse workload for the Worker entry span. */
export function classifyHttpWorkload(
  pathname: string,
  headers?: Pick<Headers, "get">,
): Workload {
  if (pathname === "/api/mcp") return "mcp";
  if (pathname.startsWith("/_serverFn/")) return "ui";
  if (pathname.startsWith("/api/")) return "other";
  const accept = headers?.get("accept") ?? "";
  const fetchMode = headers?.get("sec-fetch-mode") ?? "";
  // Static assets and arbitrary non-browser fetches must not inflate browser
  // latency. A real document request advertises HTML and/or navigation mode.
  return accept.includes("text/html") || fetchMode === "navigate"
    ? "ui"
    : "other";
}
