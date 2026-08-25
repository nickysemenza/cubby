import type { AuditLogListOut, auditLogListInput } from "@cubby/schemas/audit";
import type { z } from "zod";
import type { Database } from "~/server/db";
import { getAuditLog } from "~/server/repo/audit-log";
import { resolveShortcode } from "~/server/repo/shortcode-resolver";

/**
 * Shared audit-log workflow for browser Start and in-process callers.
 * Public id resolution stays here so both callers get identical empty-result
 * behavior for an unknown or mismatched shortcode.
 */
export async function listAuditLog(options: {
  db: Database;
  data: z.output<typeof auditLogListInput>;
}): Promise<AuditLogListOut> {
  const { db, data } = options;
  const resolved = data.entityId
    ? await resolveShortcode(db, data.entityId)
    : null;
  if (
    data.entityId &&
    (!resolved || (data.entityType && resolved.entity !== data.entityType))
  ) {
    return { entries: [] };
  }
  return await getAuditLog(db, {
    entityType: data.entityType,
    entityId: resolved?.id,
    source: data.source,
    createdAtFrom: data.createdAtFrom,
    createdAtTo: data.createdAtTo,
    limit: data.limit,
    cursor: data.cursor,
  });
}
