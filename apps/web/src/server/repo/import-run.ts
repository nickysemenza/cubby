import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import type { ImportRunFilters, ImportRunOut } from "@cubby/schemas/import-run";
import { importRunOut } from "@cubby/schemas/import-run";
import {
  importRunPurpose,
  type ImportRunPurpose,
} from "@cubby/schemas/import-run-fields";
import type { PaginationParams, SortParams } from "@cubby/schemas/pagination";
import { and, eq, sql } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import { importRun } from "~/server/db/schema";
import {
  countWhere,
  executeListQueryWithCount,
  getDb,
  notDeleted,
  shortcodeSetCondition,
  unwrapDb,
} from "~/server/repo/database-helpers";
import { createEntityReader } from "~/server/repo/entity-crud-factory";
import { listScaffold } from "~/server/repo/list-scaffold";

/**
 * The manifest read side of an import run. Writes stay in
 * `purchase-import/run-service.ts`; this file only projects the row.
 */
const columns = {
  id: importRun.id,
  shortcode: importRun.shortcode,
  status: importRun.status,
  purpose: importRun.purpose,
  trigger: importRun.trigger,
  vendorAccountShortcode: sql<
    string | null
  >`(SELECT shortcode FROM "VendorAccount" WHERE id = "ImportRun"."vendorAccountId")`,
  vendorAccountLabel: sql<
    string | null
  >`(SELECT label FROM "VendorAccount" WHERE id = "ImportRun"."vendorAccountId")`,
  vendorShortcode: sql<
    string | null
  >`(SELECT shortcode FROM "Vendor" WHERE id = "ImportRun"."vendorId")`,
  vendorName: sql<
    string | null
  >`(SELECT name FROM "Vendor" WHERE id = "ImportRun"."vendorId")`,
  ledgerPartyShortcode: sql<string>`(SELECT shortcode FROM "LedgerParty" WHERE id = "ImportRun"."ledgerPartyId")`,
  ledgerPartyName: sql<string>`(SELECT name FROM "LedgerParty" WHERE id = "ImportRun"."ledgerPartyId")`,
  predecessorShortcode: sql<
    string | null
  >`(SELECT shortcode FROM "ImportRun" p WHERE p.id = "ImportRun"."predecessorRunId")`,
  actorName: importRun.actorName,
  startedAt: importRun.startedAt,
  endedAt: importRun.endedAt,
  ordersSeen: importRun.ordersSeen,
  imported: importRun.imported,
  updated: importRun.updated,
  skipped: importRun.skipped,
  failureCode: importRun.failureCode,
  notes: importRun.notes,
  coordinatorModel: importRun.coordinatorModel,
  skillRevision: importRun.skillRevision,
  runtimeRevision: importRun.runtimeRevision,
  decisionRevision: importRun.decisionRevision,
  dispatchAttempts: importRun.dispatchAttempts,
  dispatchError: importRun.dispatchError,
  coordinatorStartedAt: importRun.coordinatorStartedAt,
  auditedAt: importRun.auditedAt,
  createdAt: importRun.createdAt,
  updatedAt: importRun.updatedAt,
} as const;

type ImportRunRow = {
  id: string;
  shortcode: string;
  status: string;
  purpose: string;
  trigger: string;
  vendorAccountShortcode: string | null;
  vendorAccountLabel: string | null;
  vendorShortcode: string | null;
  vendorName: string | null;
  ledgerPartyShortcode: string;
  ledgerPartyName: string;
  predecessorShortcode: string | null;
  actorName: string;
  startedAt: Date;
  endedAt: Date | null;
  ordersSeen: number;
  imported: number;
  updated: number;
  skipped: number;
  failureCode: string | null;
  notes: string | null;
  coordinatorModel: string;
  skillRevision: string;
  runtimeRevision: string;
  decisionRevision: number;
  dispatchAttempts: number;
  dispatchError: string | null;
  coordinatorStartedAt: Date | null;
  auditedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

const PURPOSE_LABEL = {
  account_sync: "Account sync",
  purchase_validation: "Purchase validation",
  product_enrichment: "Product enrichment",
  photo_inventory: "Photo inventory",
} satisfies Record<ImportRunPurpose, string>;

const toOut = (row: ImportRunRow): ImportRunOut =>
  importRunOut.parse({
    ...row,
    id: parseShortcodeFor("importRun", String(row.shortcode)),
    displayName: `${row.vendorName ?? row.ledgerPartyName} · ${PURPOSE_LABEL[importRunPurpose.parse(row.purpose)]}`,
    vendorAccountId: row.vendorAccountShortcode
      ? parseShortcodeFor("vendorAccount", row.vendorAccountShortcode)
      : null,
    vendorId: row.vendorShortcode
      ? parseShortcodeFor("vendor", row.vendorShortcode)
      : null,
    ledgerPartyId: parseShortcodeFor("ledgerParty", row.ledgerPartyShortcode),
    predecessorRunId: row.predecessorShortcode
      ? parseShortcodeFor("importRun", row.predecessorShortcode)
      : null,
  });

const scaffold = listScaffold("importRun", importRun);

const buildWhere = (filters: ImportRunFilters) =>
  scaffold.where(filters, [
    shortcodeSetCondition(
      sql`(SELECT shortcode FROM "VendorAccount" WHERE id = "ImportRun"."vendorAccountId")`,
      filters.vendorAccountId,
    ),
    shortcodeSetCondition(
      sql`(SELECT shortcode FROM "Vendor" WHERE id = "ImportRun"."vendorId")`,
      filters.vendorId,
    ),
    shortcodeSetCondition(
      sql`(SELECT shortcode FROM "LedgerParty" WHERE id = "ImportRun"."ledgerPartyId")`,
      filters.ledgerPartyId,
    ),
  ]);

export async function listImportRuns(
  db: Database,
  filters: ImportRunFilters,
  sorts: SortParams[],
  pagination: PaginationParams,
) {
  const where = buildWhere(filters);
  const { take, skip } = scaffold.page(pagination);
  const { data, count } = await executeListQueryWithCount(
    getDb(db)
      .select(columns)
      .from(importRun)
      .where(where)
      .orderBy(...scaffold.orderBy(sorts, {}, filters))
      .limit(take)
      .offset(skip),
    countWhere(db, importRun, where),
  );
  return { data: data.map((row) => toOut(row)), count };
}

const reader = createEntityReader<
  ImportRunRow,
  ImportRunOut,
  "importRun",
  Database | DrizzleTransaction
>({
  entity: "importRun",
  fetchById: async (db, id) => {
    const [row] = await unwrapDb(db)
      .select(columns)
      .from(importRun)
      .where(and(eq(importRun.id, id), notDeleted(importRun)))
      .limit(1);
    return row;
  },
  fromDB: (_db, row) => toOut(row),
});

export const getImportRunByShortcode = reader.getByShortcode;
