import type { ActorContext } from "@cubby/schemas/context";

import type { Database, DrizzleTransaction } from "~/server/db";
import {
  logAuditEntries,
  type AuditChangeMap,
  type AuditEntryInput,
} from "~/server/generic/audit-log/repo/audit-log";
import { canonicalJson, jsonSnapshot } from "~/server/lib/canonical-json";

/** Compare stored values, including JSON evidence and observation timestamps. */
export function evidenceChanges<T extends object>(
  before: T | undefined,
  after: T,
): AuditChangeMap | undefined {
  const previous = new Map(Object.entries(before ?? {}));
  const changes: AuditChangeMap = {};
  for (const [key, value] of Object.entries(after)) {
    if (key === "id") continue;
    if (
      canonicalJson(jsonSnapshot.parse(previous.get(key))) !==
      canonicalJson(jsonSnapshot.parse(value))
    )
      changes[key] = { from: previous.get(key) ?? null, to: value };
  }
  return Object.keys(changes).length ? changes : undefined;
}

export async function auditEvidenceRows<T extends { id: string }>(
  db: Database | DrizzleTransaction,
  actor: ActorContext,
  entityKind: "sourceTransactionRecord" | "transactionImport",
  before: readonly T[],
  after: readonly T[],
) {
  const previous = new Map(before.map((row) => [row.id, row]));
  const entries: AuditEntryInput[] = [];
  for (const row of after) {
    const prior = previous.get(row.id);
    const changes = evidenceChanges(prior, row);
    if (changes)
      entries.push({
        entityKind,
        entityId: row.id,
        action: prior ? "update" : "create",
        changes,
      });
  }
  await logAuditEntries(db, actor, entries);
}
