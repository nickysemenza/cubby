import type { AuditLogListOut, auditLogListInput } from "@cubby/schemas/audit";
import { deviceId, runEntityId } from "@cubby/schemas/identifiers";
import type { z } from "zod";

import { auditLogContract } from "~/contracts/audit-log.contract";
import type { Database } from "~/server/db";
import { implementOperationDomain } from "~/server/operation-domain.server";
import { getAuditLog } from "~/server/repo/audit-log";
import { resolveShortcode } from "~/server/repo/shortcode-resolver";

type AuditInput = z.output<typeof auditLogListInput>;

/** Unknown or mismatched public subjects deliberately produce an empty log. */
export async function listAuditLog(
  db: Database,
  input: AuditInput,
): Promise<AuditLogListOut> {
  const entity = input.entityId
    ? await resolveShortcode(db, input.entityId)
    : null;
  const device = input.deviceId
    ? await resolveShortcode(db, input.deviceId)
    : null;
  const run = input.runId ? await resolveShortcode(db, input.runId) : null;
  const subjectUnresolved =
    (input.entityId &&
      (!entity || (input.entityKind && entity.entity !== input.entityKind))) ||
    (input.deviceId && !device) ||
    (input.runId && !run);
  if (subjectUnresolved) return { entries: [] };
  return getAuditLog(db, {
    entityKind: input.entityKind,
    entityId: entity?.id,
    channel: input.channel,
    oauthClientId: input.oauthClient,
    deviceId: device ? deviceId.parse(device.id) : undefined,
    runId: run ? runEntityId.parse(run.id) : undefined,
    createdAtFrom: input.createdAtFrom,
    createdAtTo: input.createdAtTo,
    limit: input.limit,
    cursor: input.cursor,
  });
}

export const auditLogHandlers = implementOperationDomain(auditLogContract, {
  list: (context, input) => listAuditLog(context.db, input),
});
