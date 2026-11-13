/**
 * Evidence appends (ADR 0029 sections 1 and 5). Rows are insert-only; a
 * correction or withdrawal is a new row. An append takes no gate: the
 * evidence table's unique constraints on source identity decide a race
 * between two writers of the same observation, and the loser inserts nothing.
 * In the same transaction it records the rows' fact keys and dirties every
 * scope they discover or that read one of their keys.
 */
import { getTableColumns } from "drizzle-orm";

import type { Database } from "~/server/db/database";
import {
  repositoryQueries,
  repositoryTransactionDatabase,
} from "~/server/db/repository-access.boundary";

import type {
  ColumnValues,
  EvidenceKind,
  EvidenceRow,
  FactRef,
  Key,
  ScopeRef,
} from "./define";
import { insertFactKeys, markDirty } from "./dirty";
import type { KernelRegistry } from "./registry";

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
      // A duplicate observation inserts nothing: the first writer's row stands.
      // SAFETY: `evidenceRow` typed each value as this table's insert model,
      // and `returning()` yields rows of the same table.
      const inserted = (await q
        .insert(evidence.table)
        .values(insertValues as never[])
        .onConflictDoNothing()
        .returning()) as ColumnValues[];
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
      keys: [...new Set(facts.flatMap((fact) => fact.keys))],
      discovers,
      reason: `evidence:${[...groups.keys()].join(",")}`,
    });
    return facts.map((fact) => ({ kind: fact.kind, id: fact.id }));
  });
}
