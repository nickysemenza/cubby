/**
 * Audit rows for a kernel apply: one create or update entry per changed
 * record of an auditable entity, written through the shared audit writer in
 * the apply transaction. The writer stamps each row with the apply's scope,
 * reconciler version and inputs; removals audit through the entity's removal
 * cascade, inside the same apply.
 */
import type { AuditFieldChange, AuditJsonValue } from "@cubby/schemas/audit";
import { systemActor } from "@cubby/schemas/context";
import { entitySchema } from "@cubby/schemas/entity-core";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import {
  isAuditableEntity,
  type AuditableEntity,
} from "@cubby/schemas/entity-manifest";
import { minorToMoney } from "@cubby/shared";

import type { Database } from "~/server/db/database";
import { withDatabaseOperationPhase } from "~/server/db/db-observability";
import {
  logAuditEntries,
  type AuditEntryInput,
} from "~/server/generic/audit-log/repo/audit-log";

import type { Difference } from "./diff";
import type { ColumnValues } from "./row";

/** A stored value as audit JSON; minor-unit money reads as dollars, as entity reads do. */
function auditValue(value: unknown, money: boolean): AuditJsonValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint")
    return money ? minorToMoney(value) : value.toString();
  if (value instanceof Date) return value.toISOString();
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
    return value;
  // SAFETY: JSON round-trip yields plain JSON for jsonb and array columns.
  return JSON.parse(JSON.stringify(value)) as AuditJsonValue;
}

/** The audit kind of a written table's entity, when it keeps an audit trail. */
function auditableEntity(entity: string | null): AuditableEntity | null {
  const parsed = entitySchema.safeParse(entity);
  return parsed.success && isAuditableEntity(parsed.data) ? parsed.data : null;
}

function changesOf(
  entity: AuditableEntity,
  before: ColumnValues | null,
  after: ColumnValues,
): Record<string, AuditFieldChange> {
  const money = new Set<string>(
    entityFieldModels[entity].storage
      .filter((field) => field.specialized === "minor-unit-money")
      .map((field) => field.key),
  );
  return Object.fromEntries(
    Object.entries(after).map(([column, value]) => [
      column,
      {
        from: before ? auditValue(before[column], money.has(column)) : null,
        to: auditValue(value, money.has(column)),
      },
    ]),
  );
}

export async function auditApply(
  tx: Database,
  diff: Difference,
): Promise<void> {
  const entries: AuditEntryInput[] = [];
  for (const insert of diff.inserts) {
    const entity = auditableEntity(insert.target.entity);
    if (!entity) continue;
    entries.push({
      entityKind: entity,
      entityId: insert.id,
      action: "create",
      changes: changesOf(entity, null, insert.values),
    });
  }
  for (const update of diff.updates) {
    const entity = auditableEntity(update.target.entity);
    if (!entity) continue;
    entries.push({
      entityKind: entity,
      entityId: update.id,
      action: "update",
      changes: changesOf(entity, update.seen, update.set),
    });
  }
  if (entries.length)
    await withDatabaseOperationPhase("audit", () =>
      logAuditEntries(tx, systemActor(), entries),
    );
}
