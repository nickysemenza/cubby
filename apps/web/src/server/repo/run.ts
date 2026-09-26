import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import type { PaginationParams, SortParams } from "@cubby/schemas/pagination";
import type { RunFilters, RunOut } from "@cubby/schemas/run";
import { runOut } from "@cubby/schemas/run";
import { runPurpose, type RunPurpose } from "@cubby/schemas/run-fields";
import { and, eq } from "drizzle-orm";

import { formatDuration } from "~/lib/format-duration";
import type { Database, DrizzleTransaction } from "~/server/db";
import { run as runTable } from "~/server/db/schema";
import { entityRepository } from "~/server/entity-kernel/adapter";
import { notDeleted, unwrapDb } from "~/server/repo/database-helpers";
import { createEntityReader } from "~/server/repo/entity-crud-factory";
import { listScaffold } from "~/server/repo/list-scaffold";
import { lookupEntityReferences } from "~/server/repo/shortcode-resolver";

/**
 * The manifest read side of an import run. Writes stay in
 * `purchase-import/run-service.ts`; this file only projects the row.
 */
type RunRow = typeof runTable.$inferSelect;

const PURPOSE_LABEL = {
  account_sync: "Account sync",
  purchase_validation: "Purchase validation",
  product_enrichment: "Product enrichment",
  photo_inventory: "Photo inventory",
  ai_suggest: "AI suggestions",
  ai_action: "AI action",
  background: "Background",
  file_import: "File import",
  legacy: "Legacy",
} satisfies Record<RunPurpose, string>;

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
      displayName: `${vendor?.name ?? party?.name ?? row.actorName} · ${PURPOSE_LABEL[runPurpose.parse(row.purpose)]}`,
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

/**
 * Read-only: the run service and the import writer own every write, and the
 * manifest declares `delete: null`, so the generated adapter refuses one.
 */
export const runRepository = entityRepository("run", {
  lifecycle: { delete: {} },
  get: getRunByShortcode,
  list: listRuns,
});
