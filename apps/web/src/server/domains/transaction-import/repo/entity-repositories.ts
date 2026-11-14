import type { ActorContext } from "@cubby/schemas/context";
import { sourceTransactionRecordUpdateData } from "@cubby/schemas/entities/sourceTransactionRecord";
import { sourceTransactionRecordRawOut as rawSourceTransactionRecordOut } from "@cubby/schemas/entity-contracts/sourceTransactionRecord";
import type { ShortcodeFor } from "@cubby/schemas/identifiers";
import { minorToMoney } from "@cubby/shared";
import { getTableColumns, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import {
  sourceTransactionRecordRepositoryReadSchema,
  sourceTransactionRecordSchemaBindings,
} from "~/entity/generated/entity-schema-bindings.sourceTransactionRecord.gen";
import type { Database, DrizzleTransaction } from "~/server/db";
import { sourceTransactionSettlements } from "~/server/db/computed/source-transaction-settlement-sql";
import { DECLARED_EDGE_DELETE_POLICIES } from "~/server/db/generated/declared-edges.gen";
import { DECLARED_EDGE_DELETE_HOOKS } from "~/server/db/generated/declared-edges.gen";
import { unwrapDb, withTransactionOn } from "~/server/db/helpers";
import { sourceTransactionRecord } from "~/server/db/schema";
import { sourceTransactionRecordSearch } from "~/server/domains/transaction-import/repo/search-read-source-transaction-record";
import {
  sourceObservations,
  sourceObservationFacts,
  sourceObservationsForPage,
  sourceObservationField,
  sourceObservationColumns,
} from "~/server/domains/transaction-import/repo/source-observation-state";
import {
  merchantVendorInferences,
  normalizeMerchant,
} from "~/server/domains/vendor/repo/merchant-vendor-inference";
import {
  asActor,
  createEntityReader,
  defineMutationWriter,
  type MutationReceipt,
  defineRepository,
} from "~/server/entity-kernel/repo/repository";
import { listScaffold } from "~/server/generic/list/repo/list";
import { type ListReadOptions } from "~/server/generic/list/repo/list-projection";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";

import { updateSourceObservationJudgments } from "./source-occurrence";
import { retireDeletedLegacyOwners } from "./source-transaction-record-lifecycle";

type ReaderDb = Database | DrizzleTransaction;
type SourceRow = Pick<
  typeof sourceTransactionRecord.$inferSelect,
  "id" | "merchant" | "rawDescription" | "accountDescriptor"
>;

const initialFingerprint = sql`(SELECT i.fingerprint FROM "TransactionImport" i WHERE i.id = "SourceTransactionRecord"."batchId")`;

const sourceRead = {
  media: true,
  references: {
    source: { kind: "public" },
    occurrenceId: { kind: "lookup", missing: "null", includeDeleted: true },
    accountId: { kind: "lookup", missing: "null", includeDeleted: true },
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
          {
            matchState: unknown;
            transactionId: unknown;
            historicalTransactionIds: unknown;
          }
        >();
      const result = await unwrapDb(db)
        .select({
          id: sourceObservationColumns.id,
          matchState: sourceObservationColumns.matchState,
          transactionId: sourceObservationColumns.transactionShortcode,
          historicalTransactionIds:
            sourceObservationColumns.historicalTransactionIds,
        })
        .from(
          sql`${sourceObservationsForPage(rows.map((row) => row.id))} "SourceTransactionRecord"`,
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
          >`(SELECT successor.value FROM "FinancialEvidenceAlias" successor WHERE successor."observationId" = ${sourceObservationField("supersededByRowId")} AND successor.kind = 'externalId')`,
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
          historicalTransactionIds: true,
        }),
        (row, loaded) => ({
          historicalTransactionIds:
            rawSourceTransactionRecordOut.shape.historicalTransactionIds.parse(
              loaded.get(row.id)?.historicalTransactionIds ?? [],
            ),
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
    ];
  },
} satisfies ListReadOptions<SourceRow>;

export const sourceTransactionRecordScaffold = listScaffold<
  "sourceTransactionRecord",
  typeof sourceTransactionRecord,
  SourceRow
>("sourceTransactionRecord", sourceTransactionRecord, {
  readSchema: sourceTransactionRecordRepositoryReadSchema,
  rows: {
    reconciliation: sql`SELECT r.id AS owner, r."accountId" AS account, r."withdrawalImportId" AS withdrawal, r."supersededByRowId" AS successor FROM ${sourceObservationFacts} r`,
    acceptedTransactions: sql`SELECT "record" AS "owner", "transaction" FROM (${sourceTransactionSettlements}) accepted`,
  },
  derived: {
    matchState: {
      value: sourceObservationField("matchState"),
      // Fence the complete state set before filters or import membership
      // can turn its history join into a parameterized nested loop.
      set: sql`WITH match_states AS MATERIALIZED (
          SELECT observed.id, observed."matchState" AS value FROM ${sourceObservations} observed
        ) SELECT id, value FROM match_states`,
    },
    externalId: sourceObservationField("externalId"),
    legacyExternalId: sourceObservationField("legacyExternalId"),
    chargeKey: sourceObservationField("chargeKey"),
    current: sourceObservationField("current"),
    withdrawnAt: sourceObservationField("withdrawnAt"),
    lastObservedAt: sourceObservationField("lastObservedAt"),
    updatedAt: sourceObservationField("updatedAt"),
    notes: sourceObservationField("notes"),
    dispositionNote: sourceObservationField("dispositionNote"),
    disposition: sourceObservationField("disposition"),
    dispositionReason: sourceObservationField("dispositionReason"),
  },
  read: {
    ...sourceRead,
    // Bind facts to one selected record; flattening can scan the whole population.
    // Raw timestamps and minor-unit money keep the plain reader's decoders.
    load: async (db, where) =>
      unwrapDb(db)
        .select({
          ...getTableColumns(sourceTransactionRecord),
          amount: sql<string>`${sourceTransactionRecord.amount}::text`.mapWith(
            (value) => minorToMoney(BigInt(value)),
          ),
          providerAmount:
            sql<string>`${sourceTransactionRecord.providerAmount}::text`.mapWith(
              (value) => minorToMoney(BigInt(value)),
            ),
          accountName: sql`(SELECT account.name FROM "FinancialAccount" account WHERE account.id=source_read_facts."accountId")`,
          externalId: sql`source_read_facts."externalId"`,
          legacyExternalId: sql`source_read_facts."legacyExternalId"`,
          chargeKey: sql`source_read_facts."chargeKey"`,
          current: sql`source_read_facts."current"`,
          withdrawnAt: sql`source_read_facts."withdrawnAt"`,
          lastObservedAt: sql`source_read_facts."lastObservedAt"`,
          updatedAt: sql`source_read_facts."updatedAt"`,
          notes: sql`source_read_facts."notes"`,
          dispositionNote: sql`source_read_facts."dispositionNote"`,
          disposition: sql`source_read_facts."disposition"`,
          dispositionReason: sql`source_read_facts."dispositionReason"`,
          accountId: sql`source_read_facts."accountId"`,
          withdrawalImportId: sql`source_read_facts."withdrawalImportId"`,
          supersededByRowId: sql`source_read_facts."supersededByRowId"`,
        })
        .from(sourceTransactionRecord)
        .leftJoinLateral(
          sql`(SELECT facts.* FROM ${sourceObservationFacts} facts WHERE facts.id=${sourceTransactionRecord.id} OFFSET 0) source_read_facts`,
          sql`true`,
        )
        .where(where),
    title: sql`${sourceTransactionRecord.rawDescription}`,
    search: sourceTransactionRecordSearch,
  },
});

const sourceReader = createEntityReader<
  unknown,
  z.output<typeof rawSourceTransactionRecordOut>,
  "sourceTransactionRecord",
  ReaderDb
>({
  entity: "sourceTransactionRecord",
  scaffold: sourceTransactionRecordScaffold,
  output: rawSourceTransactionRecordOut,
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
      if (data.identityResolution) {
        const { resolveSourceIdentity } =
          await import("~/server/domains/transaction-import/repo/source-identity-resolution");
        await resolveSourceIdentity(tx, id, data.identityResolution, actor);
      }
      await updateSourceObservationJudgments(
        tx,
        [id],
        {
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
        },
        actor,
      );
      return readOutput({ entityId: id, shortcode: code });
    });
  },
});

export const sourceTransactionRecordRepository = defineRepository(
  "sourceTransactionRecord",
  {
    schemas: sourceTransactionRecordSchemaBindings,
    lifecycle: {
      delete: DECLARED_EDGE_DELETE_POLICIES.sourceTransactionRecord,
    },
    deleteHooks: DECLARED_EDGE_DELETE_HOOKS.sourceTransactionRecord,
    afterDelete: (ctx, ids) =>
      retireDeletedLegacyOwners(ctx.db, ids, ctx.actorContext),
    scaffold: sourceTransactionRecordScaffold,
    update: asActor(updateSource),
  },
);
