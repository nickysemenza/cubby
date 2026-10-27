import type { ActorContext } from "@cubby/schemas/context";
import type { ShortcodeFor } from "@cubby/schemas/identifiers";
import type { PaginationParams, SortParams } from "@cubby/schemas/pagination";
import { sourceTransactionRecordUpdateData } from "@cubby/schemas/source-transaction-record";
import {
  sourceTransactionRecordMatchState,
  type SourceTransactionRecordFilters,
} from "@cubby/schemas/source-transaction-record";
import {
  rawSourceTransactionRecordOut,
  type RawSourceTransactionRecordOut,
} from "@cubby/schemas/source-transaction-record-raw-read";
import { type TransactionImportFilters } from "@cubby/schemas/transaction-import";
import {
  rawTransactionImportOut,
  type RawTransactionImportOut,
} from "@cubby/schemas/transaction-import-raw-read";
import { and, eq, getTableColumns, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import type { Database, DrizzleTransaction } from "~/server/db";
import { sourceTransactionSettlements } from "~/server/db/computed/source-transaction-settlement-sql";
import { notDeleted, unwrapDb, withTransactionOn } from "~/server/db/helpers";
import type { ListReadIntent } from "~/server/db/helpers/query";
import { sourceTransactionRecord, transactionImport } from "~/server/db/schema";
import { runStepInputListRows } from "~/server/domains/run/repo/run-step-input";
import {
  merchantVendorInferences,
  normalizeMerchant,
} from "~/server/domains/vendor/repo/merchant-vendor-inference";
import type { EntityKernelContext } from "~/server/entity-kernel/adapter";
import {
  asActor,
  createEntityReader,
  createEntityRowFetcher,
  defineMutationWriter,
  type MutationReceipt,
  defineRepository,
} from "~/server/entity-kernel/repo/repository";
import { createAppError } from "~/server/errors/app-error";
import { listScaffold } from "~/server/generic/list/repo/list";
import type { ListProjection } from "~/server/generic/list/repo/list-contracts";
import {
  listReadPlan,
  type ListReadOptions,
} from "~/server/generic/list/repo/list-projection";
import { completeListReader } from "~/server/generic/list/repo/list-read-adapters";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";

import { auditEvidenceRows } from "./intake-audit";
import {
  assertSourceTransactionRecordDeletionAllowed,
  assertSourceTransactionRecordSupersessionAllowed,
} from "./source-transaction-record-lifecycle";
import { CHARGE_STATE } from "./statement-charge";

type ReaderDb = Database | DrizzleTransaction;
type SourceRow = typeof sourceTransactionRecord.$inferSelect;
type ImportRow = typeof transactionImport.$inferSelect;

// Charge state is authoritative over every live observation, independent of the page.
const chargeState = sql`(SELECT CASE WHEN cs.ignored THEN ${sourceTransactionRecordMatchState.enum.ignored} WHEN cs.superseded THEN ${sourceTransactionRecordMatchState.enum.superseded}
  WHEN cs.shortcode IS NOT NULL THEN ${sourceTransactionRecordMatchState.enum.matched} ELSE ${sourceTransactionRecordMatchState.enum.unmatched} END FROM ${CHARGE_STATE} cs
  WHERE cs.source = "SourceTransactionRecord".source AND cs."chargeKey" = "SourceTransactionRecord"."chargeKey")`;
const initialFingerprint = sql`(SELECT i.fingerprint FROM "TransactionImport" i
  WHERE i.id = "SourceTransactionRecord"."batchId")`;
const transactionCode = sql`(SELECT cs.shortcode FROM ${CHARGE_STATE} cs
  WHERE cs.source = "SourceTransactionRecord".source AND cs."chargeKey" = "SourceTransactionRecord"."chargeKey")`;
const storedCount = sql<number>`(SELECT count(*)::int FROM "TransactionImportRecord" m
  JOIN "SourceTransactionRecord" r ON r.id = m."statementRowId" AND r."deletedAt" IS NULL
  WHERE m."importId" = "TransactionImport".id)`;
const sourceScaffold = listScaffold(
  "sourceTransactionRecord",
  sourceTransactionRecord,
  {
    rows: {
      runStepInputs: runStepInputListRows("sourceTransactionRecord"),
      acceptedTransactions: sql`SELECT "record" AS "owner", "transaction" FROM (${sourceTransactionSettlements}) accepted`,
    },
    derived: {
      matchState: chargeState,
    },
  },
);
const importScaffold = listScaffold("transactionImport", transactionImport, {
  derived: { rowCountStored: storedCount },
});

export const buildSourceTransactionRecordWhere = async (
  db: ReaderDb,
  filters: SourceTransactionRecordFilters = {},
) =>
  sourceScaffold.where(filters, {
    context: await sourceScaffold.context(db, {
      filters,
      readIntent: "count",
    }),
  });
export const buildTransactionImportWhere = (
  filters: TransactionImportFilters = {},
) => importScaffold.where(filters);

const sourceRead = {
  media: true,
  references: {
    source: { kind: "public" },
    batchId: { kind: "lookup", missing: "error", includeDeleted: true },
    withdrawalImportId: {
      kind: "lookup",
      missing: "null",
      includeDeleted: true,
    },
    supersededByRowId: {
      kind: "lookup",
      missing: "null",
      includeDeleted: true,
    },
  },
  bindings: (bind) => {
    const state = bind.batch(async ({ db, rows }) => {
      if (!rows.length)
        return new Map<
          string,
          { matchState: unknown; transactionId: unknown }
        >();
      const result = await unwrapDb(db)
        .select({
          id: sourceTransactionRecord.id,
          matchState: chargeState,
          transactionId: transactionCode,
        })
        .from(sourceTransactionRecord)
        .where(
          inArray(
            sourceTransactionRecord.id,
            rows.map((row) => row.id),
          ),
        );
      return new Map(result.map((row) => [row.id, row]));
    });
    const related = bind.batch(async ({ db, rows }) => {
      if (!rows.length)
        return new Map<
          string,
          { importFingerprint: string; supersededBy: string | null }
        >();
      const result = await unwrapDb(db)
        .select({
          id: sourceTransactionRecord.id,
          importFingerprint: sql<string>`${initialFingerprint}`,
          supersededBy: sql<
            string | null
          >`(SELECT r."externalId" FROM "SourceTransactionRecord" r WHERE r.id = "SourceTransactionRecord"."supersededByRowId")`,
        })
        .from(sourceTransactionRecord)
        .where(
          inArray(
            sourceTransactionRecord.id,
            rows.map((row) => row.id),
          ),
        );
      return new Map(result.map((row) => [row.id, row]));
    });
    const inference = bind.batch(async (page) => {
      const { db, rows } = page;
      const states = await state.load(page);
      const merchants = rows.flatMap((row) =>
        states.get(row.id)?.matchState === "unmatched" && row.merchant
          ? [row.merchant]
          : [],
      );
      return {
        states,
        inferences: await merchantVendorInferences(db, merchants),
      };
    });
    const provider = bind.batch(async ({ db, rows }) => {
      if (!rows.length) return new Map<string, SourceRow["providerData"]>();
      const result = await unwrapDb(db)
        .select({
          id: sourceTransactionRecord.id,
          providerData: sourceTransactionRecord.providerData,
        })
        .from(sourceTransactionRecord)
        .where(
          inArray(
            sourceTransactionRecord.id,
            rows.map((row) => row.id),
          ),
        );
      return new Map(result.map((row) => [row.id, row.providerData]));
    });
    return [
      bind(
        rawSourceTransactionRecordOut.pick({ displayName: true }),
        (row) => ({
          displayName:
            row.rawDescription ||
            row.merchant ||
            row.accountDescriptor ||
            "Source transaction record",
        }),
      ),
      state.fields(
        rawSourceTransactionRecordOut.pick({
          matchState: true,
          transactionId: true,
        }),
        (row, loaded) => ({
          matchState: rawSourceTransactionRecordOut.shape.matchState.parse(
            loaded.get(row.id)?.matchState,
          ),
          transactionId:
            rawSourceTransactionRecordOut.shape.transactionId.parse(
              loaded.get(row.id)?.transactionId ?? null,
            ),
        }),
      ),
      related.fields(
        rawSourceTransactionRecordOut.pick({
          importFingerprint: true,
          supersededBy: true,
        }),
        (row, loaded) => ({
          importFingerprint: loaded.get(row.id)?.importFingerprint ?? "",
          supersededBy: loaded.get(row.id)?.supersededBy ?? null,
        }),
      ),
      inference.fields(
        rawSourceTransactionRecordOut.pick({ vendorInference: true }),
        (row, loaded) => ({
          vendorInference:
            loaded.states.get(row.id)?.matchState === "unmatched" &&
            row.merchant
              ? rawSourceTransactionRecordOut.shape.vendorInference.parse(
                  loaded.inferences.get(normalizeMerchant(row.merchant)) ?? {
                    status: "none",
                    candidates: [],
                  },
                )
              : null,
        }),
      ),
      provider.fields(
        rawSourceTransactionRecordOut.pick({ providerData: true }),
        (row, loaded) => ({
          providerData: rawSourceTransactionRecordOut.shape.providerData.parse(
            loaded.get(row.id) ?? null,
          ),
        }),
      ),
    ];
  },
} satisfies ListReadOptions<SourceRow>;

const importRead = {
  media: true,
  references: { source: { kind: "public" } },
  bindings: (bind) => {
    const counts = bind.batch(async ({ db, rows }) => {
      if (!rows.length) return new Map<string, number>();
      const result = await unwrapDb(db)
        .select({ id: transactionImport.id, count: storedCount })
        .from(transactionImport)
        .where(
          inArray(
            transactionImport.id,
            rows.map((row) => row.id),
          ),
        );
      return new Map(result.map((row) => [row.id, row.count]));
    });
    return [
      counts.fields(
        rawTransactionImportOut.pick({ rowCountStored: true }),
        (row, loaded) => ({ rowCountStored: loaded.get(row.id) ?? 0 }),
      ),
    ];
  },
} satisfies ListReadOptions<ImportRow>;

export const listSourceTransactionRecordsRead = (
  db: ReaderDb,
  filters: SourceTransactionRecordFilters,
  sorts: SortParams[],
  pagination: PaginationParams,
  projection: ListProjection = { kind: "full" },
  readIntent: ListReadIntent = "page",
) =>
  sourceScaffold.read(
    db,
    { filters, sorts, pagination, projection, readIntent },
    {
      read: sourceRead,
      select: async (page) => {
        const { providerData: _providerData, ...columns } = getTableColumns(
          sourceTransactionRecord,
        );
        return unwrapDb(db)
          .select({
            ...columns,
            providerData: sql<SourceRow["providerData"]>`NULL::jsonb`,
          })
          .from(sourceTransactionRecord)
          .where(page.where)
          .orderBy(...page.orderBy)
          .limit(page.limit)
          .offset(page.offset);
      },
    },
  );
const listSources = completeListReader(
  rawSourceTransactionRecordOut,
  listSourceTransactionRecordsRead,
);
export const listTransactionImportsRead = (
  db: ReaderDb,
  filters: TransactionImportFilters,
  sorts: SortParams[],
  pagination: PaginationParams,
  projection: ListProjection = { kind: "full" },
  readIntent: ListReadIntent = "page",
) =>
  importScaffold.read(
    db,
    { filters, sorts, pagination, projection, readIntent },
    { read: importRead },
  );
const listImports = completeListReader(
  rawTransactionImportOut,
  listTransactionImportsRead,
);

const sourceReader = createEntityReader<
  SourceRow,
  RawSourceTransactionRecordOut,
  "sourceTransactionRecord",
  ReaderDb
>({
  entity: "sourceTransactionRecord",
  fetchById: createEntityRowFetcher(sourceTransactionRecord),
  fromDB: async (db, row) =>
    rawSourceTransactionRecordOut.parse(
      (
        await listReadPlan<SourceRow>(
          "sourceTransactionRecord",
          sourceRead,
        ).read(db, [row], { kind: "full" })
      )[0],
    ),
});
const importReader = createEntityReader<
  ImportRow,
  RawTransactionImportOut,
  "transactionImport",
  ReaderDb
>({
  entity: "transactionImport",
  fetchById: createEntityRowFetcher(transactionImport),
  fromDB: async (db, row) =>
    rawTransactionImportOut.parse(
      (
        await listReadPlan<ImportRow>("transactionImport", importRead).read(
          db,
          [row],
          { kind: "full" },
        )
      )[0],
    ),
});

const updateSource = defineMutationWriter({
  entity: "sourceTransactionRecord",
  read: async (
    receipt: MutationReceipt<"sourceTransactionRecord">,
    db: ReaderDb,
    _code: ShortcodeFor<"sourceTransactionRecord">,
    _data: z.infer<typeof sourceTransactionRecordUpdateData>,
    _actor: ActorContext,
  ) => ({
    output: await sourceReader.getByID(db, receipt.entityId),
    entityId: receipt.entityId,
  }),
  write: async (
    readOutput,
    db: ReaderDb,
    code: ShortcodeFor<"sourceTransactionRecord">,
    input: z.infer<typeof sourceTransactionRecordUpdateData>,
    actor: ActorContext,
  ) => {
    const data = sourceTransactionRecordUpdateData.strict().parse(input);
    const id = await resolveOrThrow(db, "sourceTransactionRecord", code);
    return withTransactionOn(db, async (tx) => {
      const [before] = await tx
        .select()
        .from(sourceTransactionRecord)
        .where(
          and(
            eq(sourceTransactionRecord.id, id),
            notDeleted(sourceTransactionRecord),
          ),
        )
        .limit(1);
      if (!before)
        throw createAppError(
          "REFERENCED_RECORD_MISSING",
          `Source record ${code} was not found`,
        );
      const values = {
        disposition: data.disposition,
        dispositionReason: data.dispositionReason,
        dispositionNote: data.dispositionNote,
        notes: data.notes,
        accountId:
          data.accountId === undefined
            ? undefined
            : data.accountId === null
              ? null
              : await resolveOrThrow(tx, "financialAccount", data.accountId),
        supersededByRowId:
          data.supersededByRowId === undefined
            ? undefined
            : data.supersededByRowId === null
              ? null
              : await resolveOrThrow(
                  tx,
                  "sourceTransactionRecord",
                  data.supersededByRowId,
                ),
      };
      if (values.supersededByRowId)
        await assertSourceTransactionRecordSupersessionAllowed(
          tx,
          before,
          values.supersededByRowId,
        );
      const changed = Object.entries(values).some(
        ([key, value]) =>
          value !== undefined &&
          new Map(Object.entries(before)).get(key) !== value,
      );
      if (changed) {
        const updated = await tx
          .update(sourceTransactionRecord)
          .set(values)
          .where(eq(sourceTransactionRecord.id, id))
          .returning();
        await auditEvidenceRows(
          tx,
          actor,
          "sourceTransactionRecord",
          [before],
          updated,
        );
      }
      return readOutput({ entityId: id, shortcode: code });
    });
  },
});

const SOURCE_TRANSACTION_RECORD_DELETE_POLICY = {
  "SourceTransactionRecord.supersededByRowId": {
    code: "block-live-predecessors",
    effect: "block",
    description: "Live superseding predecessors retain the source record.",
  },
  "TransactionImportRecord.statementRowId": {
    code: "retain-import-membership",
    effect: "preserve",
    description:
      "Imports retain membership history when a source record is deleted.",
  },
} as const;
export const sourceTransactionRecordRepository = defineRepository(
  "sourceTransactionRecord",
  {
    lifecycle: { delete: SOURCE_TRANSACTION_RECORD_DELETE_POLICY },
    deleteHooks: { beforeDelete: assertSourceTransactionRecordDeletionAllowed },
    get: (ctx: EntityKernelContext, code: string) =>
      sourceReader.getByShortcode(ctx.db, code),
    list: (
      ctx: EntityKernelContext,
      filters: SourceTransactionRecordFilters,
      sorts: SortParams[],
      pagination: PaginationParams,
    ) => listSources(ctx.db, filters, sorts, pagination),
    listRead: (
      ctx: EntityKernelContext,
      filters: SourceTransactionRecordFilters,
      sorts: SortParams[],
      pagination: PaginationParams,
      projection: ListProjection,
      readIntent: ListReadIntent = "page",
    ) =>
      listSourceTransactionRecordsRead(
        ctx.db,
        filters,
        sorts,
        pagination,
        projection,
        readIntent,
      ),
    update: asActor(updateSource),
  },
);
export const transactionImportRepository = defineRepository(
  "transactionImport",
  {
    get: (ctx: EntityKernelContext, code: string) =>
      importReader.getByShortcode(ctx.db, code),
    list: (
      ctx: EntityKernelContext,
      filters: TransactionImportFilters,
      sorts: SortParams[],
      pagination: PaginationParams,
    ) => listImports(ctx.db, filters, sorts, pagination),
    listRead: (
      ctx: EntityKernelContext,
      filters: TransactionImportFilters,
      sorts: SortParams[],
      pagination: PaginationParams,
      projection: ListProjection,
      readIntent: ListReadIntent = "page",
    ) =>
      listTransactionImportsRead(
        ctx.db,
        filters,
        sorts,
        pagination,
        projection,
        readIntent,
      ),
  },
);
