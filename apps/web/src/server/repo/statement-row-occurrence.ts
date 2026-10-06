import { and, asc, inArray, sql } from "drizzle-orm";
import { uniq } from "es-toolkit";

import type { Database } from "~/server/db";
import { statementImport, statementRow } from "~/server/db/schema";
import { notDeleted, unwrapDb } from "~/server/repo/database-helpers";

import { statementRowOccurrenceId } from "./statement-row-identity";

/** One physical row of one statement file. */
export type StatementFileOccurrence = {
  source: string;
  fingerprint: string;
  rowPosition: number;
  statementDate: string;
  /** `statementRowExternalId` of the row: the frozen v1 content hash. */
  legacyExternalId: string;
};

export type ResolvedStatementOccurrence = {
  /** The stored row that records this occurrence, else its own positional id. */
  externalId: string;
  recordedBy: "this-file" | "another-export" | null;
};

/**
 * The one overlap rule shared by `recordStatementRows` and the statement
 * preview. Provider exports are cumulative (each Monarch CSV is the full
 * history), so a later file repeats every charge an earlier file recorded.
 *
 * A row is recorded by this file when its positional id is stored. Otherwise,
 * per (source, frozen v1 hash), the k-th such row in the file is the k-th live
 * row with that hash recorded by ANOTHER export, oldest first; rows beyond
 * that count are new. Counting occurrences, not hashes, keeps two identical
 * same-day charges in one export as two rows and still matches both when the
 * next export repeats them. Rows recorded before positions existed carry the
 * v1 hash as `externalId` and no `legacyExternalId`, so both columns count.
 *
 * Callers that write must serialize per source first (`recordStatementRows`).
 */
export async function resolveStatementOccurrences(
  db: Database,
  rows: readonly StatementFileOccurrence[],
): Promise<ResolvedStatementOccurrence[]> {
  if (rows.length === 0) return [];
  const positionalIds = await Promise.all(
    rows.map((row) =>
      statementRowOccurrenceId(row.source, row.fingerprint, row.rowPosition),
    ),
  );
  const sources = uniq(rows.map((row) => row.source));
  const legacyHash = sql<string>`COALESCE(${statementRow.legacyExternalId}, ${statementRow.externalId})`;
  const [ownRows, candidates] = await Promise.all([
    unwrapDb(db)
      .select({ externalId: statementRow.externalId })
      .from(statementRow)
      .where(
        and(
          inArray(statementRow.source, sources),
          inArray(statementRow.externalId, positionalIds),
          notDeleted(statementRow),
        ),
      ),
    unwrapDb(db)
      .select({
        source: statementRow.source,
        externalId: statementRow.externalId,
        legacyExternalId: legacyHash,
        fingerprint: statementImport.fingerprint,
      })
      .from(statementRow)
      .innerJoin(
        statementImport,
        sql`${statementRow.batchId} = ${statementImport.id}`,
      )
      .where(
        and(
          inArray(statementRow.source, sources),
          // Served by the statementDate index; the hash covers the date.
          inArray(
            statementRow.statementDate,
            uniq(rows.map((row) => row.statementDate)),
          ),
          inArray(legacyHash, uniq(rows.map((row) => row.legacyExternalId))),
          notDeleted(statementRow),
        ),
      )
      .orderBy(
        asc(statementImport.createdAt),
        asc(statementRow.rowPosition),
        asc(statementRow.externalId),
      ),
  ]);

  const own = new Set(ownRows.map((row) => row.externalId));
  const files = new Set(rows.map((row) => `${row.source}\0${row.fingerprint}`));
  const queues = new Map<string, string[]>();
  for (const candidate of candidates) {
    if (files.has(`${candidate.source}\0${candidate.fingerprint}`)) continue;
    const key = `${candidate.source}\0${candidate.legacyExternalId}`;
    queues.set(key, [...(queues.get(key) ?? []), candidate.externalId]);
  }
  return rows.map((row, index) => {
    const positionalId = positionalIds[index]!;
    if (own.has(positionalId))
      return { externalId: positionalId, recordedBy: "this-file" };
    const earlier = queues
      .get(`${row.source}\0${row.legacyExternalId}`)
      ?.shift();
    return earlier
      ? { externalId: earlier, recordedBy: "another-export" }
      : { externalId: positionalId, recordedBy: null };
  });
}
