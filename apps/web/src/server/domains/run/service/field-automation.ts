import type { FieldAutomationCause } from "@cubby/schemas/ai-evaluation";
import { systemActor } from "@cubby/schemas/context";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import {
  type ShortcodeEntity,
  shortcodeEntities,
} from "@cubby/schemas/entity-manifest";
import { suggestApplyPolicy } from "@cubby/schemas/field-suggestion-policy";
import { createLogger } from "@cubby/worker-tracing";
import { sql } from "drizzle-orm";
import { z } from "zod";

import { scrubErrorMessage } from "~/lib/error-diagnostics";
import {
  AI_DISCOVERY_SETTINGS_ID,
  readAiDiscoveryCursor,
  saveAiDiscoveryCursor,
} from "~/server/ai/repo/ai-refresh";
import type { Database } from "~/server/db";
import {
  captureFieldCorrection,
  claimAutomationRows,
  correctionRecheckRecords,
  type PendingAuditRow,
  POLICY_PAGE,
  policyPassSlots,
} from "~/server/domains/run/repo/field-automation";
import { fieldEvaluationScheduler } from "~/server/domains/run/service/ai-refresh";
import type { BackgroundDrain } from "~/server/generic/background/drains";
import { fieldAuthority } from "~/server/generic/suggestions/repo/field-authority";

const log = createLogger("field-automation");
const shortcodeEntity = z.enum(shortcodeEntities);

type AutomatedField = {
  key: string;
  /** Keys whose change can move this field's answer. */
  inputs: ReadonlySet<string>;
};

/** Fields Cubby evaluates on its own: filled answers it saves or offers. */
const automatedFields = (entity: string): readonly AutomatedField[] => {
  const known = shortcodeEntity.safeParse(entity);
  if (!known.success) return [];
  return entityFieldModels[known.data].fields.flatMap((field) => {
    const suggest = field.control?.suggest;
    if (!suggest || suggest.mode !== "fill") return [];
    if (suggestApplyPolicy(known.data, field.key) === "review") return [];
    const backed =
      "backedBy" in suggest && Array.isArray(suggest.backedBy)
        ? suggest.backedBy.map((source: { column: string }) => source.column)
        : [];
    return [{ key: field.key, inputs: new Set([...suggest.basis, ...backed]) }];
  });
};

type Schedule = ReturnType<typeof fieldEvaluationScheduler>;

/** Evaluate a field only while nobody but Cubby holds it. */
async function scheduleField(
  db: Database,
  schedule: Schedule,
  entity: ShortcodeEntity,
  recordId: string,
  field: string,
  cause: FieldAutomationCause,
) {
  const authority = await fieldAuthority(db, entity, recordId, field);
  if (authority.holder === "person") return "unchanged";
  return schedule(
    { kind: "field", entity, recordId, field, suggestionIds: [], cause },
    { populated: authority.holder === "cubby" },
  );
}

/** Why a write owes evaluation: an import's Run, a hand-back, a new record or new evidence. */
function writeCause(row: PendingAuditRow, field: string): FieldAutomationCause {
  if (row.authority === "released" && row.changes && field in row.changes)
    return { kind: "released" };
  if (row.userId === systemActor().userId && row.runId)
    return { kind: "import" };
  return { kind: row.action === "create" ? "new_record" : "evidence_changed" };
}

async function processRow(db: Database, row: PendingAuditRow) {
  const entity = shortcodeEntity.parse(row.entityKind);
  const fields = automatedFields(entity);
  const changed = new Set(Object.keys(row.changes ?? {}));
  const targets: {
    recordId: string;
    field: string;
    cause: FieldAutomationCause;
  }[] = [];
  if (row.action === "update" && row.authority === null)
    for (const field of fields) {
      if (!changed.has(field.key)) continue;
      const corrected = await captureFieldCorrection(db, row, field.key);
      if (!corrected) continue;
      for (const recordId of await correctionRecheckRecords(
        db,
        row,
        field.key,
        corrected.wrongValue,
      ))
        targets.push({
          recordId,
          field: field.key,
          cause: { kind: "correction" },
        });
    }
  for (const field of fields) {
    const owed =
      row.action === "create" ||
      [...changed].some((key) => key !== field.key && field.inputs.has(key)) ||
      (row.authority === "released" && changed.has(field.key));
    if (owed)
      targets.push({
        recordId: row.entityId,
        field: field.key,
        cause: writeCause(row, field.key),
      });
  }
  return targets;
}

async function eventsPage(db: Database) {
  const page = await claimAutomationRows(db, async (tx, row) => {
    const schedule = fieldEvaluationScheduler(tx, []);
    for (const target of await processRow(tx, row)) {
      const result = await scheduleField(
        tx,
        schedule,
        shortcodeEntity.parse(row.entityKind),
        target.recordId,
        target.field,
        target.cause,
      );
      if (result === "deferred") return "deferred";
    }
    return "finished";
  });
  return page.deferred && page.finished === 0
    ? { claimed: 0, outcome: "deferred" as const }
    : { claimed: page.finished };
}

/**
 * After a model, prompt or policy revision: re-ask every open guess and every
 * value Cubby still holds. The activation resets this cursor on each revision.
 */
async function policyPage(db: Database) {
  const cursor = await readAiDiscoveryCursor(db);
  if (cursor.fieldDone) return { claimed: 0 };
  const rows = await policyPassSlots(db, cursor.field);
  const schedule = fieldEvaluationScheduler(db, []);
  let last = cursor.field;
  let deferred = false;
  let advanced = 0;
  for (const row of rows) {
    const entity = shortcodeEntity.parse(row.entity);
    if (automatedFields(entity).some((field) => field.key === row.field)) {
      const result = await scheduleField(
        db,
        schedule,
        entity,
        row.recordId,
        row.field,
        { kind: "policy_revision", ref: String(cursor.revision) },
      );
      if (result === "deferred") {
        deferred = true;
        break;
      }
    }
    last = row;
    advanced += 1;
  }
  await saveAiDiscoveryCursor(db, {
    ...cursor,
    field: last,
    fieldDone: !deferred && rows.length < POLICY_PAGE,
  });
  if (deferred && advanced === 0)
    return { claimed: 0, outcome: "deferred" as const };
  return { claimed: Math.max(1, advanced) };
}

/**
 * The only automatic trigger for field work: audited writes (creates, input
 * changes, corrections, hand-backs) and policy revisions. Page views schedule
 * nothing, and no periodic pass exists.
 */
export const fieldAutomationDrain: BackgroundDrain = {
  name: "field-automation",
  due: () => sql`
    SELECT ${"events"}::text AS unit, false AS demand, min("createdAt")::timestamp AS since
    FROM "AuditLog" WHERE "automationPending"
    HAVING count(*) > 0
    UNION ALL
    SELECT ${"policy"}::text, false, now()::timestamp
    FROM "AppSettings"
    WHERE id = ${AI_DISCOVERY_SETTINGS_ID}::uuid
      AND NOT COALESCE((metadata->>${"fieldDone"})::boolean, false)
  `,
  // Owed audit rows are claimable at once; the policy pass waits for its wake.
  next: () =>
    sql`SELECT min("createdAt")::timestamp FROM "AuditLog" WHERE "automationPending"`,
  async page(db, unit) {
    try {
      return unit === "policy" ? await policyPage(db) : await eventsPage(db);
    } catch (error) {
      log.warn("Field automation page failed", {
        unit,
        error: scrubErrorMessage(String(error)),
      });
      throw error;
    }
  },
};
