import { auditLogActionSchema } from "@cubby/schemas/audit";
import { backgroundResultAlertEntities } from "@cubby/schemas/entity-roster";
import { runTrigger } from "@cubby/schemas/run-fields";
import { sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import {
  device,
  ledgerParty,
} from "~/server/db/generated/entity-table-definitions.gen";
import {
  textArrayParam,
  columnArrayParam,
} from "~/server/db/helpers/array-param";
import { notDeleted } from "~/server/db/helpers/predicates";
import {
  repositoryQueries,
  type RepositoryQueryInput,
} from "~/server/db/repository-access.boundary";

/** Admit committed creation receipts in the writer's transaction, never by a time cursor. */
export async function admitBackgroundAlerts(
  db: RepositoryQueryInput,
  auditIds: readonly string[],
): Promise<boolean> {
  if (!auditIds.length) return false;
  // includes-deleted: Run ancestry is immutable attribution even after a Run is retired.
  const admitted = await repositoryQueries(db).execute<{ id: string }>(sql`
    INSERT INTO "DeviceAlertDelivery" ("deviceId", "auditId", "creationKey", registration, "availableAt")
    SELECT d.id, a.id, a."entityKind" || ':' || a."entityId"::text, (d."pushRegistration"->>'generation')::uuid, now() + interval '2 minutes'
    FROM "AuditLog" a CROSS JOIN "Device" d
    JOIN "LedgerParty" owner ON owner.id = d."ledgerPartyId"
      AND owner."userId" = d."pushRegistration"->>'userId' AND ${notDeleted(alias(ledgerParty, "owner"))}
    JOIN "session" login ON login.id = d."pushRegistration"->>'sessionId'
      AND login.user_id = d."pushRegistration"->>'userId' AND login.expires_at > now()
    WHERE a.id = ANY(${columnArrayParam(auditIds)}) AND a.action = ${auditLogActionSchema.enum.create}
      AND a."entityKind" = ANY(${textArrayParam(backgroundResultAlertEntities)})
      AND ${notDeleted(alias(device, "d"))} AND d."backgroundAlerts" AND d."pushRegistration" IS NOT NULL
      AND (
        -- includes-deleted: Run ancestry retains attribution after retirement.
        a.provenance IS NULL AND EXISTS (
          WITH RECURSIVE lineage AS (
            SELECT id, trigger, "parentRunId", "predecessorRunId" FROM "Run" WHERE id = a."runId"
            UNION
            SELECT r.id, r.trigger, r."parentRunId", r."predecessorRunId" FROM "Run" r JOIN lineage l
              ON r.id = l."parentRunId" OR r.id = l."predecessorRunId"
          ) SELECT 1 FROM lineage
          HAVING bool_or(trigger IN (${runTrigger.enum.discovery}, ${runTrigger.enum.scheduled}))
            AND NOT bool_or(trigger IN (${runTrigger.enum.foreground}, ${runTrigger.enum.manual}, ${runTrigger.enum.backfill}))
        )
      )
    ON CONFLICT DO NOTHING RETURNING id`);
  return admitted.rows.length > 0;
}
