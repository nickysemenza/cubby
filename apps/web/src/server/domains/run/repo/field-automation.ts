import { suggestionStatus } from "@cubby/schemas/ai";
import { auditLogActionSchema } from "@cubby/schemas/audit";
import { SYSTEM_USER_ID } from "@cubby/schemas/context";
import {
  feedbackAuthority,
  feedbackVerdict,
  suggestionFamily,
} from "@cubby/schemas/suggestion";
import { sql } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import { getDb, withTransactionDatabase } from "~/server/db/helpers";
import { uuidArrayParam } from "~/server/db/helpers/query";
import { recordFeedback } from "~/server/generic/suggestions/repo/suggestion";
import { transitionSuggestionState } from "~/server/generic/suggestions/repo/suggestion-state";

const FIELD = suggestionFamily.enum.field;
const APPLIED = suggestionStatus.enum.applied;
const PENDING = suggestionStatus.enum.pending;
const UPDATE = auditLogActionSchema.enum.update;
const MEMBER = feedbackAuthority.enum.member;
const CORRECT = feedbackVerdict.enum.correct;

type JsonValue = z.infer<ReturnType<typeof z.json>>;

/** Audit rows one events page reads. */
const EVENTS_PAGE = 100;
/** Similar Cubby-held values one member correction rechecks. */
const CORRECTION_RECHECK_CAP = 25;
/** Field slots one policy page schedules. */
export const POLICY_PAGE = 100;

export const pendingAuditRow = z.object({
  id: z.string(),
  entityKind: z.string(),
  entityId: z.string(),
  action: z.string(),
  changes: z.record(z.string(), z.unknown()).nullable(),
  authority: z.enum(["automatic", "released"]).nullable(),
  userId: z.string(),
  createdAt: z.coerce.date(),
});
export type PendingAuditRow = z.infer<typeof pendingAuditRow>;

const changedTo = (row: PendingAuditRow, field: string) =>
  z.object({ to: z.unknown() }).safeParse(row.changes?.[field]).data?.to;

/**
 * A person's write over a value Cubby set records Cubby's Miss with the
 * right value. Replay-safe: the operation id names the audit row.
 */
export async function captureFieldCorrection(
  db: Database,
  row: PendingAuditRow,
  field: string,
): Promise<{ suggestionId: string; wrongValue: JsonValue | null } | null> {
  // The newest earlier write to this field decides: only a value Cubby set,
  // and nobody kept, can be Cubby's Miss.
  const [previous] = z
    .array(
      z.object({
        authority: z.string().nullable(),
        suggestionId: z.string().nullable(),
        wrongValue: z.json().nullable(),
        kept: z.boolean().nullable(),
      }),
    )
    .parse(
      (
        await getDb(db).execute<{
          authority: string | null;
          suggestionId: string | null;
          wrongValue: unknown;
          kept: boolean | null;
        }>(sql`
          SELECT a.authority, s.id::text AS "suggestionId",
            s."suggestedValue" AS "wrongValue",
            EXISTS (SELECT 1 FROM jsonb_to_recordset(s.decisions)
              member(authority text, verdict text)
              WHERE member.authority = ${MEMBER} AND member.verdict = ${CORRECT}) AS kept
          FROM "AuditLog" a
          LEFT JOIN "Suggestion" s ON s.family = ${FIELD}
            AND s.entity = a."entityKind" AND s."recordId" = a."entityId"
            AND s.field = ${field} AND s.status = ${APPLIED}
            AND s."acceptanceReceipt"->'auditIds' ? a.id::text
          WHERE a."entityKind" = ${row.entityKind}
            AND a."entityId" = ${row.entityId}::uuid
            AND a.action = ${UPDATE} AND a.changes ? ${field}
            AND (a."createdAt", a.id) < (${row.createdAt}, ${row.id}::uuid)
          ORDER BY a."createdAt" DESC, a.id DESC
          LIMIT 1
        `)
      ).rows,
    );
  if (
    previous?.authority !== "automatic" ||
    !previous.suggestionId ||
    previous.kept
  )
    return null;
  const suggestionId = previous.suggestionId;
  // An import or cron replacing Cubby's value is new evidence, not a grade
  // (system authority never grades); the write alone makes the value protected.
  if (row.userId === SYSTEM_USER_ID) return null;
  const correctValue = changedTo(row, field) ?? null;
  await recordFeedback(db, {
    suggestionId,
    operationId: `correction:${row.id}:${field}`,
    verdict: "wrong",
    authority: "member",
    actorUserId: row.userId,
    intent: "history",
    correction: { present: true, value: z.json().parse(correctValue) },
  });
  await transitionSuggestionState(db, suggestionId, {
    status: "rejected",
    correctValue,
  });
  return { suggestionId, wrongValue: previous.wrongValue };
}

/** Records whose field Cubby holds, nearest the corrected answer first. */
export async function correctionRecheckRecords(
  db: Database,
  row: PendingAuditRow,
  field: string,
  wrongValue: JsonValue | null,
) {
  const result = await getDb(db).execute<{
    recordId: string;
    same: boolean;
  }>(sql`
    SELECT DISTINCT ON (s."recordId") s."recordId"::text AS "recordId",
      (s."suggestedValue" = ${JSON.stringify(wrongValue)}::jsonb) AS same
    FROM "Suggestion" s
    WHERE s.family = ${FIELD} AND s.entity = ${row.entityKind}
      AND s.field = ${field} AND s.status = ${APPLIED}
      AND s."acceptanceReceipt"->>'mode' = ${feedbackAuthority.enum.automatic}
      AND s."recordId" <> ${row.entityId}::uuid
    ORDER BY s."recordId", s."createdAt" DESC
  `);
  return result.rows
    .sort((a, b) => Number(b.same) - Number(a.same))
    .slice(0, CORRECTION_RECHECK_CAP)
    .map((candidate) => candidate.recordId);
}

/**
 * Claim the oldest audit rows owed to field automation in one transaction.
 * `handle` returns the ids it finished; only those leave the queue, so a
 * deferral keeps the rest owed and a crash replays the page.
 */
export async function claimAutomationRows(
  db: Database,
  handle: (tx: Database, rows: PendingAuditRow[]) => Promise<string[]>,
) {
  return withTransactionDatabase(db, async (tx) => {
    const rows = z.array(pendingAuditRow).parse(
      (
        await getDb(tx).execute<z.input<typeof pendingAuditRow>>(sql`
          SELECT id::text, "entityKind", "entityId"::text, action, changes,
            authority, "userId", "createdAt"
          FROM "AuditLog"
          WHERE "automationPending"
          ORDER BY "createdAt", id
          LIMIT ${EVENTS_PAGE}
          FOR UPDATE SKIP LOCKED
        `)
      ).rows,
    );
    if (!rows.length) return 0;
    const finished = await handle(tx, rows);
    if (finished.length)
      await getDb(tx).execute(sql`
        UPDATE "AuditLog" SET "automationPending" = false
        WHERE id = ANY(${uuidArrayParam(finished)})
      `);
    return finished.length;
  });
}

/** Field slots a policy pass re-asks: open guesses and values Cubby still holds. */
export async function policyPassSlots(
  db: Database,
  after: { entity: string; recordId: string; field: string } | null,
) {
  return z
    .array(
      z.object({ entity: z.string(), recordId: z.string(), field: z.string() }),
    )
    .parse(
      (
        await getDb(db).execute<{
          entity: string;
          recordId: string;
          field: string;
        }>(sql`
          SELECT DISTINCT s.entity, s."recordId"::text AS "recordId", s.field
          FROM "Suggestion" s
          WHERE s.family = ${FIELD} AND s.active
            AND (s.status = ${PENDING}
              OR (s.status = ${APPLIED} AND s."acceptanceReceipt"->>'mode' = ${feedbackAuthority.enum.automatic}))
            ${after ? sql`AND (s.entity, s."recordId", s.field) > (${after.entity}, ${after.recordId}::uuid, ${after.field})` : sql``}
          ORDER BY s.entity, "recordId", s.field
          LIMIT ${POLICY_PAGE}
        `)
      ).rows,
    );
}
