/**
 * Evidence appends (ADR 0029 sections 1 and 5). Rows are insert-only; a
 * correction or withdrawal is a new row. An append takes the gate with the
 * revisions it raises; the evidence table's unique constraints on source
 * identity decide a race between two writers of the same observation, and the
 * loser inserts nothing.
 * In the same transaction it records the rows' fact keys and dirties every
 * scope they discover or that read one of their keys.
 */
import { generateShortcode } from "@cubby/shared";
import { getTableColumns, getTableName, inArray } from "drizzle-orm";

import type { Database } from "~/server/db/database";
import { entityIdentity } from "~/server/db/entity-identity-schema";
import {
  repositoryQueries,
  repositorySavepoint,
  repositoryTransactionDatabase,
} from "~/server/db/repository-access.boundary";
import { isEntityShortcodeCollision } from "~/server/entity-kernel/repo/entity-identity-writer";

import type {
  ColumnValues,
  EvidenceKind,
  EvidenceRow,
  FactRef,
  Key,
  ScopeRef,
} from "./define";
import { insertFactKeys, markDirty } from "./dirty";
import { tableKey, columnKey } from "./keys";
import type { KernelRegistry } from "./registry";

/** A losing source-identity race must discard its unused Entity reservation. */
async function insertEvidence(
  db: Database,
  evidence: EvidenceKind,
  values: ColumnValues[],
): Promise<ColumnValues[]> {
  if (!evidence.entity) {
    // SAFETY: evidenceRow checked the insert model for this same table.
    return (await repositoryQueries(db)
      .insert(evidence.table)
      .values(values as never[])
      .onConflictDoNothing()
      .returning()) as ColumnValues[];
  }
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      return await repositorySavepoint(db, async (q) => {
        const entity = evidence.entity;
        const rows = entity
          ? values.map((row) => ({
              ...row,
              id: row.id ?? crypto.randomUUID(),
              shortcode: row.shortcode ?? generateShortcode(entity),
            }))
          : values;
        const reserved = entity
          ? await q
              .insert(entityIdentity)
              .values(
                rows.map((row) => ({
                  id: String(row.id),
                  shortcode: String(row.shortcode),
                  kind: entity,
                })),
              )
              .onConflictDoNothing({ target: entityIdentity.id })
              .returning({ id: entityIdentity.id })
          : [];
        // SAFETY: `evidenceRow` typed these values as this table's insert model;
        // returning() selects that same table's rows.
        const inserted = (await q
          .insert(evidence.table)
          .values(rows as never[])
          .onConflictDoNothing()
          .returning()) as ColumnValues[];
        const accepted = new Set(inserted.map((row) => String(row.id)));
        const unused = reserved
          .filter((row) => !accepted.has(row.id))
          .map((row) => row.id);
        if (unused.length)
          await q
            .delete(entityIdentity)
            .where(inArray(entityIdentity.id, unused));
        return inserted;
      });
    } catch (error) {
      if (
        !evidence.entity ||
        !isEntityShortcodeCollision(error, getTableName(evidence.table)) ||
        attempt === 9
      )
        throw error;
    }
  }
  throw new Error("Failed to reserve evidence identities");
}

export async function append(
  db: Database,
  registry: KernelRegistry,
  rows: readonly EvidenceRow[],
  options: { runId?: string | null } = {},
): Promise<FactRef[]> {
  if (!rows.length) return [];
  const groups = new Map<
    string,
    { evidence: EvidenceKind; values: ColumnValues[] }
  >();
  for (const row of rows) {
    const group = groups.get(row.evidence.kind) ?? {
      evidence: row.evidence,
      values: [],
    };
    group.values.push(row.values);
    groups.set(row.evidence.kind, group);
  }
  return repositoryTransactionDatabase(db, async (tx) => {
    const q = repositoryQueries(tx);
    const facts: { kind: string; id: string; keys: Key[] }[] = [];
    const discovers: ScopeRef[] = [];
    for (const { evidence, values } of groups.values()) {
      const hasRun = "runId" in getTableColumns(evidence.table);
      const insertValues = values.map((value) =>
        hasRun && options.runId && value.runId === undefined
          ? { ...value, runId: options.runId }
          : value,
      );
      const inserted = await insertEvidence(tx, evidence, insertValues);
      for (const row of inserted) {
        // SAFETY: returned rows are this evidence table's select model.
        const typed = row as Parameters<EvidenceKind["keys"]>[0];
        facts.push({
          kind: evidence.kind,
          id: String(row.id),
          keys: evidence.keys(typed),
        });
        discovers.push(...evidence.discovers(typed));
      }
    }
    await insertFactKeys(q, facts);
    await markDirty(q, registry, {
      keys: [
        ...new Set([
          ...facts.flatMap((fact) => fact.keys),
          ...[...groups.values()]
            .filter(({ evidence }) =>
              facts.some((fact) => fact.kind === evidence.kind),
            )
            .flatMap(({ evidence }) => [
              tableKey(getTableName(evidence.table)),
              ...registry
                .readers(getTableName(evidence.table))
                .flatMap((reader) =>
                  reader.columns.map((column) =>
                    columnKey(getTableName(evidence.table), column),
                  ),
                ),
            ]),
        ]),
      ],
      discovers,
      reason: `evidence:${[...groups.keys()].join(",")}`,
    });
    return facts.map((fact) => ({ kind: fact.kind, id: fact.id }));
  });
}
