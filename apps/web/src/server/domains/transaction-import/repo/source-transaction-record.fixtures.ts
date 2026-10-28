import { transactionImportFiltersSchema as transactionImportFilters } from "@cubby/schemas/entities/transactionImport";
import type { PaginationParams, SortParams } from "@cubby/schemas/pagination";
import { recordSourceTransactionRecordsInput } from "@cubby/schemas/source-transaction-record";
import {
  sourceTransactionRecordFilters,
  type SourceTransactionRecordLegacyFilters,
} from "@cubby/schemas/source-transaction-record";
import { rawSourceTransactionRecordOut } from "@cubby/schemas/source-transaction-record-raw-read";
import { rawTransactionImportOut } from "@cubby/schemas/transaction-import-raw-read";
import { eq } from "drizzle-orm";
import { buildKernelContext } from "tooling/scenarios/context";
import { TEST_ACTOR } from "tooling/test-setup";

import type { Database } from "~/server/db";
import { getDb } from "~/server/db/helpers";
import { sourceTransactionRecord, transactionImport } from "~/server/db/schema";
import { ENTITY_KERNEL_BINDINGS } from "~/server/generated/entity-kernel-bindings.gen";

import { sourceTransactionRecordScaffold } from "./entity-repositories";
import { recordSourceTransactionRecords } from "./source-transaction-record";

export async function listSourceTransactionRecords(
  db: Database,
  filters: SourceTransactionRecordLegacyFilters,
  pagination: PaginationParams = { pageIndex: 0, pageSize: 50 },
  sort?: SortParams,
) {
  const page = await sourceTransactionRecordScaffold.read(db, {
    filters: sourceTransactionRecordFilters.parse({
      ...filters,
      statementDateFrom: filters.dateFrom,
      statementDateTo: filters.dateTo,
    }),
    sorts: sort ? [sort] : [],
    pagination,
  });
  return {
    ...page,
    data: page.data.map((row) => rawSourceTransactionRecordOut.parse(row)),
  };
}

export async function listTransactionImports(db: Database, source?: string) {
  const page =
    await ENTITY_KERNEL_BINDINGS.transactionImport.repository.listRead(
      buildKernelContext(db, TEST_ACTOR.userId),
      transactionImportFilters.parse({ source }),
      [{ orderBy: "createdAt", direction: "desc" }],
      { pageIndex: 0, pageSize: 50 },
    );
  return {
    ...page,
    data: page.data.map((row) => rawTransactionImportOut.parse(row)),
  };
}

/** Shared valid evidence graph for liveness fixtures that subsequently seed invalid references. */
export async function createFinancialEvidenceFixture(db: Database) {
  const receipt = await recordSourceTransactionRecords(
    db,
    recordSourceTransactionRecordsInput.parse({
      import: {
        source: "synthetic-liveness",
        label: "Synthetic source evidence",
        fingerprint: crypto.randomUUID(),
      },
      rows: [
        {
          rowPosition: 1,
          accountDescriptor: "Synthetic source account",
          statementDate: "2026-01-01",
          providerAmount: -1,
          rawDescription: "SYNTHETIC SOURCE EVIDENCE",
        },
      ],
    }),
    TEST_ACTOR,
  );
  if (!receipt.batchId) throw new Error("Synthetic evidence import missing");
  const record = await getDb(db).query.sourceTransactionRecord.findFirst({
    where: eq(sourceTransactionRecord.batchId, receipt.batchId),
  });
  const collection = await getDb(db).query.transactionImport.findFirst({
    where: eq(transactionImport.id, receipt.batchId),
  });
  if (!record || !collection)
    throw new Error("Synthetic evidence graph missing");
  return { record, collection };
}
