import { z } from "zod";
import type { UserId } from "./identifiers";

/**
 * The closed set of sources the application itself writes.
 *
 * `csv_import` / `sheets_import` are no longer produced by any code path, but
 * `sheets_import` still labels 1322 historical rows from the Notion migration —
 * they stay because this schema has to *read* what the table already contains.
 */
export const APPLICATION_AUDIT_SOURCES = [
  "ui",
  "csv_import",
  "sheets_import",
  "epub_import",
  "api",
  "mcp",
  "caldav",
] as const;

/**
 * Source of an action for audit logging.
 *
 * Open-ended on purpose: a one-off maintenance script is a legitimate actor, and
 * a closed enum turned that into an outage. 567 rows written by out-of-band
 * scripts during the 2026-07-28 expense-import work (`script:url-cleanup-…`,
 * `script:home-depot-export-…`, …) sat outside the enum, so `auditLog.list`
 * failed **output** validation — and because one bad row rejects the whole
 * array, the activity feed and the home page rendered an error rather than
 * dropping a single entry.
 *
 * Widening the read schema rather than normalizing those rows is deliberate:
 * provenance is the entire job of this column, and "which script touched this"
 * is worth more than enum tidiness. The `script:` prefix keeps the value
 * self-describing and keeps the type a template literal rather than a bare
 * `string`, so a future `switch` can still branch on the application sources
 * and treat `script:*` as one fallback arm.
 */
export const auditSourceSchema = z.union([
  z.enum(APPLICATION_AUDIT_SOURCES),
  // Non-empty slug: bare "script:" carries no provenance, so it is not valid.
  z.templateLiteral(["script:", z.string().min(1)]),
]);
export type AuditSource = z.infer<typeof auditSourceSchema>;

export function isScriptAuditSource(
  source: AuditSource,
): source is `script:${string}` {
  return source.startsWith("script:");
}

export interface ActorContext {
  userId: UserId;
  source: AuditSource;
}

export function buildActorContext(
  userId: UserId,
  source: AuditSource = "ui",
): ActorContext {
  return { userId, source };
}
