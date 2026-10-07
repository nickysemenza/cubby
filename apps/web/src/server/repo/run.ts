import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import type { PaginationParams, SortParams } from "@cubby/schemas/pagination";
import type { RunFilters, RunOut } from "@cubby/schemas/run";
import { runOut } from "@cubby/schemas/run";
import { runWorkLabel } from "@cubby/schemas/run-fields";
import { and, eq } from "drizzle-orm";

import { formatDuration } from "~/lib/format-duration";
import type { Database, DrizzleTransaction } from "~/server/db";
import { run as runTable } from "~/server/db/schema";
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

// includes-deleted: a run is immutable history, so it keeps naming the
// account, vendor and party it ran for after they are tombstoned.
const hydrate = async (
  db: Database | DrizzleTransaction,
  rows: RunRow[],
): Promise<RunOut[]> => {
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
      rows.map((row) => row.predecessorRunId),
    ),
  ]);
  const at = <V>(map: Map<string, V>, id: string | null) =>
    id === null ? undefined : map.get(id);
  return rows.map((row) => {
    const account = at(accounts, row.vendorAccountId);
    const vendor = at(vendors, row.vendorId);
    const party = at(parties, row.ledgerPartyId);
    return runOut.parse({
      ...row,
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
      predecessorRunId: at(predecessors, row.predecessorRunId)?.id ?? null,
    });
  });
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
 * The kernel's progressive list read. Run declares no deferred list groups
 * (`presentation.list.read`), so every projection hydrates the full row; the
 * shared list hydration adds the display images every list item carries.
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
            const hydrated = await hydrate(db, rows);
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
