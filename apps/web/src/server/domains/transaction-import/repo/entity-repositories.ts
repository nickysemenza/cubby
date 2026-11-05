import type { ActorContext } from "@cubby/schemas/context";
import { sourceTransactionRecordUpdateData } from "@cubby/schemas/entities/sourceTransactionRecord";
import { sourceTransactionRecordRawOut as rawSourceTransactionRecordOut } from "@cubby/schemas/entity-contracts/sourceTransactionRecord";
import type { ShortcodeFor } from "@cubby/schemas/identifiers";
import { inArray, sql } from "drizzle-orm";
import { z } from "zod";

import type { Database, DrizzleTransaction } from "~/server/db";
import { sourceTransactionSettlements } from "~/server/db/computed/source-transaction-settlement-sql";
import { unwrapDb, withTransactionOn } from "~/server/db/helpers";
import { sourceTransactionRecord } from "~/server/db/schema";
import { runStepInputListRows } from "~/server/domains/run/repo/run-step-input";
import { sourceTransactionRecordSearch } from "~/server/domains/transaction-import/repo/search-read-source-transaction-record";
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

import {
  sourceObservations,
  sourceObservationField,
} from "./source-observation-state";
import { updateSourceObservationJudgments } from "./source-occurrence";
import {
  lockSourceObservationRemoval,
  assertSourceTransactionRecordDeletionAllowed,
} from "./source-transaction-record-lifecycle";

type ReaderDb = Database | DrizzleTransaction;
type SourceRow = typeof sourceTransactionRecord.$inferSelect;

const chargeState = sourceObservationField("matchState");
const initialFingerprint = sql`(SELECT i.fingerprint FROM "TransactionImport" i WHERE i.id = "SourceTransactionRecord"."batchId")`;
const transactionCode = sourceObservationField("transactionShortcode");

const sourceRead = {
  media: true,
  references: {
    source: { kind: "public" },
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
          >`(SELECT successor."externalId" FROM ${sourceObservations} successor WHERE successor.id = ${sourceObservationField("supersededByRowId")})`,
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
    ];
  },
} satisfies ListReadOptions<SourceRow>;

export const sourceTransactionRecordScaffold = listScaffold(
  "sourceTransactionRecord",
  sourceTransactionRecord,
  {
    rows: {
      runStepInputs: runStepInputListRows("sourceTransactionRecord"),
      reconciliation: sql`SELECT r.id AS owner, r."accountId" AS account, r."withdrawalImportId" AS withdrawal, r."supersededByRowId" AS successor FROM ${sourceObservations} r`,
      acceptedTransactions: sql`SELECT "record" AS "owner", "transaction" FROM (${sourceTransactionSettlements}) accepted`,
    },
    derived: {
      matchState: chargeState,
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
      columns: {
        accountName: sql`(SELECT account.name FROM "FinancialAccount" account WHERE account.id=${sourceObservationField("accountId")})`,
        ...Object.fromEntries(
          (
            [
              "externalId",
              "legacyExternalId",
              "chargeKey",
              "current",
              "withdrawnAt",
              "lastObservedAt",
              "updatedAt",
              "notes",
              "dispositionNote",
              "disposition",
              "dispositionReason",
              "accountId",
              "withdrawalImportId",
              "supersededByRowId",
            ] as const
          ).map((key) => [key, sourceObservationField(key)]),
        ),
      },
      title: sql`${sourceTransactionRecord.rawDescription}`,
      search: sourceTransactionRecordSearch,
    },
  },
);

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

const SOURCE_TRANSACTION_RECORD_DELETE_POLICY = {
  "SourceOccurrence.currentObservationId": {
    code: "retain-occurrence-head",
    effect: "preserve",
    description:
      "Occurrence head evidence remains reserved through an observation tombstone.",
  },
  "SourceOccurrence.replacementObservationId": {
    code: "retain-replacement-proof",
    effect: "preserve",
    description:
      "Explicit replacement evidence is retained; the deletion hook protects live decisions.",
  },
  "SourceObservationAnnotation.observationId": {
    code: "retain-observation-judgments",
    effect: "preserve",
    description:
      "Observation annotations and unresolved decisions remain retained.",
  },
  "SourceObservationAnnotation.supersededByObservationId": {
    code: "retain-replacement-history",
    effect: "preserve",
    description:
      "The deletion hook protects live replacement decisions; historical choices remain.",
  },
  "FinancialEvidenceAlias.observationId": {
    code: "retain-source-aliases",
    effect: "preserve",
    description:
      "Original aliases remain explainable through observation tombstones.",
  },
  "TransactionImportRecord.statementRowId": {
    code: "retain-import-membership",
    effect: "preserve",
    description: "Imports retain original and subsequent memberships.",
  },
} as const;
export const sourceTransactionRecordRepository = defineRepository(
  "sourceTransactionRecord",
  {
    lifecycle: { delete: SOURCE_TRANSACTION_RECORD_DELETE_POLICY },
    deleteHooks: {
      beforeLock: lockSourceObservationRemoval,
      beforeDelete: assertSourceTransactionRecordDeletionAllowed,
    },
    scaffold: sourceTransactionRecordScaffold,
    update: asActor(updateSource),
  },
);
