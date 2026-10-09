import { activityIconEntity } from "@cubby/schemas/activity";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import type { PaginationParams, SortParams } from "@cubby/schemas/pagination";
import type { RunFilters, RunOut } from "@cubby/schemas/run";
import { runOut } from "@cubby/schemas/run";
import { runPurpose, runWorkLabel } from "@cubby/schemas/run-fields";
import { and, eq } from "drizzle-orm";

import { formatDuration } from "~/lib/format-duration";
import type { Database, DrizzleTransaction } from "~/server/db";
import { run as runTable } from "~/server/db/schema";
import { loadDataQualities } from "~/server/repo/data-quality/hydrate";
import { notDeleted, unwrapDb } from "~/server/repo/database-helpers";
import { listScaffold } from "~/server/repo/list";
import {
  hydrateListRead,
  type ListProjection,
} from "~/server/repo/list-projection";
import { defineRepository, listOn, onDb } from "~/server/repo/repository";
import { createEntityReader, listReadOn } from "~/server/repo/repository";
import { lookupEntityReferences } from "~/server/repo/shortcode-resolver";

/**
 * The manifest read side of an import run. Writes stay in
 * `purchase-import/run-service.ts`; this file only projects the row.
 */
type RunRow = typeof runTable.$inferSelect;
const runProjection = runOut.omit({ dataQuality: true });

// includes-deleted: a run is immutable history, so it keeps naming the
// account, vendor and party it ran for after they are tombstoned.
const hydrateProjection = async (
  db: Database | DrizzleTransaction,
  rows: RunRow[],
): Promise<Omit<RunOut, "dataQuality">[]> => {
  const refs = <E extends "vendorAccount" | "vendor" | "ledgerParty" | "run">(
    entity: E,
    ids: (string | null)[],
  ) => lookupEntityReferences(db, entity, ids, { includeDeleted: true });
  const [accounts, vendors, parties, predecessors] = await Promise.all([
    refs(
      "vendorAccount",
      rows.map((row) => row.vendorAccountId),
    ),
    refs(
      "vendor",
      rows.map((row) => row.vendorId),
    ),
    refs(
      "ledgerParty",
      rows.map((row) => row.ledgerPartyId),
    ),
    refs(
      "run",
      rows.flatMap((row) => [row.predecessorRunId, row.parentRunId]),
    ),
  ]);
  const at = <V>(map: Map<string, V>, id: string | null) =>
    id === null ? undefined : map.get(id);
  const runLinks = (row: RunRow) => ({
    predecessorRunId: at(predecessors, row.predecessorRunId)?.id ?? null,
    parentRunId: at(predecessors, row.parentRunId)?.id ?? null,
  });
  return rows.map((row) => {
    const account = at(accounts, row.vendorAccountId);
    const vendor = at(vendors, row.vendorId);
    const party = at(parties, row.ledgerPartyId);
    const projected = {
      ...row,
      purpose: runPurpose.parse(row.purpose),
      id: parseShortcodeFor("run", row.shortcode),
      displayName: `${vendor?.name ?? party?.name ?? row.actorName} · ${runWorkLabel(row)}`,
      wallTime: row.endedAt
        ? formatDuration(
            Math.max(0, row.endedAt.getTime() - row.startedAt.getTime()),
          )
        : "In progress",
      vendorAccountId: account?.id ?? null,
      vendorAccountLabel: account?.name ?? null,
      vendorId: vendor?.id ?? null,
      vendorName: vendor?.name ?? null,
      ledgerPartyId: party?.id ?? null,
      ledgerPartyName: party?.name ?? null,
      ...runLinks(row),
    };
    return runProjection.parse({
      ...projected,
      iconEntity: activityIconEntity({
        kind: projected.purpose,
        subjectId: projected.vendorId,
        ledgerPartyId: projected.ledgerPartyId,
      }),
    });
  });
};

const hydrate = async (
  db: Database | DrizzleTransaction,
  rows: RunRow[],
): Promise<RunOut[]> => {
  const [projected, qualities] = await Promise.all([
    hydrateProjection(db, rows),
    loadDataQualities(
      db,
      "run",
      rows.map((row) => row.id),
    ),
  ]);
  return projected.map((row, index) =>
    runOut.parse({ ...row, dataQuality: qualities.get(rows[index]!.id) }),
  );
};

const scaffold = listScaffold("run", runTable);

export const listRuns = (
  db: Database,
  filters: RunFilters,
  sorts: SortParams[],
  pagination: PaginationParams,
) =>
  scaffold.list(
    db,
    { filters, sorts, pagination },
    { hydrate: (rows) => hydrate(db, rows) },
  );

/**
 * Core identity is shared with canonical reads; the generic loader owns
 * the manifest's deferred quality and media groups.
 */
export const listRunsRead = (
  db: Database,
  filters: RunFilters,
  sorts: SortParams[],
  pagination: PaginationParams,
  projection: ListProjection,
) =>
  scaffold.list(
    db,
    { filters, sorts, pagination, projection },
    {
      hydrate: (rows, selected) =>
        hydrateListRead(db, "run", rows, selected, {
          media: true,
          load: async () => {
            const hydrated = await hydrateProjection(db, rows);
            return new Map(rows.map((row, index) => [row.id, hydrated[index]]));
          },
          mapRow: (row, { loaded }) => ({ ...loaded.get(row.id) }),
        }),
    },
  );

const reader = createEntityReader<
  RunRow,
  RunOut,
  "run",
  Database | DrizzleTransaction
>({
  entity: "run",
  fetchById: async (db, id) => {
    const [row] = await unwrapDb(db)
      .select()
      .from(runTable)
      .where(and(eq(runTable.id, id), notDeleted(runTable)))
      .limit(1);
    return row;
  },
  fromDB: async (db, row) => (await hydrate(db, [row]))[0]!,
});

export const getRunByShortcode = reader.getByShortcode;

/** Declared `lifecycle: "readOnly"`: the run service and importers own writes. */
export const runRepository = defineRepository("run", {
  get: onDb(getRunByShortcode),
  list: listOn(listRuns),
  listRead: listReadOn(listRunsRead),
});
