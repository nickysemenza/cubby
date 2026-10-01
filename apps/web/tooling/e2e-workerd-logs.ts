import type { TestHarness } from "wrangler";

import { scrubErrorMessage } from "../src/lib/error-diagnostics";

export type WorkerdLog = ReturnType<TestHarness["getLogs"]>[number];

/** Playwright attachment name carrying a failed test's sanitized workerd logs. */
export const WORKERD_LOGS_ATTACHMENT = "workerd-logs";
/** Annotation type carrying the harness explorer URL of a failed test. */
export const WORKERD_EXPLORER_ANNOTATION = "workerd-explorer";

/** Local explorer for bindings, Durable Objects, queues and R2 of a live harness. */
export function harnessExplorerUrl(origin: string): string {
  return `${origin}/cdn-cgi/local/explorer`;
}

/**
 * Run bundles are uploaded from CI, so only credential-shaped values are
 * redacted (the same rule as user-facing error surfaces) before logs leave the
 * runner. Each message is bounded by `scrubErrorMessage`.
 */
export function sanitizeWorkerdLogs(logs: readonly WorkerdLog[]): WorkerdLog[] {
  return logs.map((log) => ({
    ...log,
    message: scrubErrorMessage(log.message),
  }));
}
