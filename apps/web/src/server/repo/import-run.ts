import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import type { ImportRunFilters, ImportRunOut } from "@cubby/schemas/import-run";
import { importRunOut } from "@cubby/schemas/import-run";
import {
  importRunPurpose,
  type ImportRunPurpose,
} from "@cubby/schemas/import-run-fields";
import type { PaginationParams, SortParams } from "@cubby/schemas/pagination";
import { and, eq } from "drizzle-orm";

import { formatDuration } from "~/lib/format-duration";
import type { Database, DrizzleTransaction } from "~/server/db";
import { importRun } from "~/server/db/schema";
import { entityRepository } from "~/server/entity-kernel/adapter";
import { notDeleted, unwrapDb } from "~/server/repo/database-helpers";
import { createEntityReader } from "~/server/repo/entity-crud-factory";
import { listScaffold } from "~/server/repo/list-scaffold";
import { lookupEntityReferences } from "~/server/repo/shortcode-resolver";

/**
 * The manifest read side of an import run. Writes stay in
 * `purchase-import/run-service.ts`; this file only projects the row.
 */
type ImportRunRow = typeof importRun.$inferSelect;

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
} satisfies Record<ImportRunPurpose, string>;

// includes-deleted: a run is immutable history, so it keeps naming the
// account, vendor and party it ran for after they are tombstoned.
const hydrate = async (
  db: Database | DrizzleTransaction,
  rows: ImportRunRow[],
): Promise<ImportRunOut[]> => {
  const refs = <
    E extends "vendorAccount" | "vendor" | "ledgerParty" | "importRun",
  >(
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
      "importRun",
      rows.map((row) => row.predecessorRunId),
    ),
  ]);
  const at = <V>(map: Map<string, V>, id: string | null) =>
    id === null ? undefined : map.get(id);
  return rows.map((row) => {
    const account = at(accounts, row.vendorAccountId);
    const vendor = at(vendors, row.vendorId);
    const party = at(parties, row.ledgerPartyId);
    return importRunOut.parse({
      ...row,
      id: parseShortcodeFor("importRun", row.shortcode),
      displayName: `${vendor?.name ?? party?.name ?? row.actorName} · ${PURPOSE_LABEL[importRunPurpose.parse(row.purpose)]}`,
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

const scaffold = listScaffold("importRun", importRun);

export const listImportRuns = (
  db: Database,
  filters: ImportRunFilters,
  sorts: SortParams[],
  pagination: PaginationParams,
) =>
  scaffold.list(
    db,
    { filters, sorts, pagination },
    { hydrate: (rows) => hydrate(db, rows) },
  );

const reader = createEntityReader<
  ImportRunRow,
  ImportRunOut,
  "importRun",
  Database | DrizzleTransaction
>({
  entity: "importRun",
  fetchById: async (db, id) => {
    const [row] = await unwrapDb(db)
      .select()
      .from(importRun)
      .where(and(eq(importRun.id, id), notDeleted(importRun)))
      .limit(1);
    return row;
  },
  fromDB: async (db, row) => (await hydrate(db, [row]))[0]!,
});

export const getImportRunByShortcode = reader.getByShortcode;

/**
 * Read-only: the run service and the import writer own every write, and the
 * manifest declares `delete: null`, so the generated adapter refuses one.
 */
export const importRunRepository = entityRepository({
  lifecycle: { delete: {} },
  get: getImportRunByShortcode,
  list: listImportRuns,
});
