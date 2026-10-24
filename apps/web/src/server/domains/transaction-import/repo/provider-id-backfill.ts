import type { ActorContext } from "@cubby/schemas/context";
import { entitySchema } from "@cubby/schemas/entity-core";
import { financialAccountSourceAliases } from "@cubby/schemas/financial-account";
import {
  type ProviderIdBackfillInput,
  type ProviderIdBackfillReceipt,
  type applyProviderIdBackfillInput,
  type providerIdBackfillOut,
} from "@cubby/schemas/source-transaction-record";
import { sha256Hex } from "@cubby/shared/sha256";
import { and, eq, or, sql } from "drizzle-orm";
import type { z } from "zod";

import type { Database, DrizzleTransaction } from "~/server/db";
import { unwrapDb, withTransaction } from "~/server/db/helpers";
import {
  financialAccount,
  sourceTransactionRecord,
  transactionImport,
  transactionImportRecord,
} from "~/server/db/schema";
import { lockFinancialEvidenceKeys } from "~/server/domains/financial-transaction/repo/financial-evidence";
import { logAuditEntries } from "~/server/generic/audit-log/repo/audit-log";
import { canonicalJson, jsonSnapshot } from "~/server/lib/canonical-json";

import {
  checkOriginalCsv,
  observationProjection,
  readProviderIdBackfillReceipts,
  receiptMatchesRecord,
  requireBackfillProof,
} from "./provider-id-backfill-proof";
import { sourceTransactionRecordExternalId } from "./source-transaction-record-identity";

const canonical = (value: string) =>
  value.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
const same = (left: unknown, right: unknown) =>
  canonicalJson(jsonSnapshot.parse(left)) ===
  canonicalJson(jsonSnapshot.parse(right));

async function prepare(tx: DrizzleTransaction, input: ProviderIdBackfillInput) {
  checkOriginalCsv(input);
  const [record] = await unwrapDb(tx)
    .select()
    .from(sourceTransactionRecord)
    .where(eq(sourceTransactionRecord.shortcode, input.recordId));
  const [collection] = await unwrapDb(tx)
    .select({
      id: transactionImport.id,
      shortcode: transactionImport.shortcode,
      source: transactionImport.source,
      fingerprint: transactionImport.fingerprint,
      observedAt: transactionImport.observedAt,
      rowCountDeclared: transactionImport.rowCountDeclared,
      completedAt: transactionImport.completedAt,
      coverage: transactionImport.coverage,
      deletedAt: transactionImport.deletedAt,
      updatedAt: transactionImport.updatedAt,
    })
    .from(transactionImport)
    .where(eq(transactionImport.shortcode, input.collectionId));
  requireBackfillProof(
    record &&
      collection &&
      record.source === input.source &&
      collection.source === input.source &&
      collection.fingerprint === input.fingerprint &&
      collection.deletedAt === null &&
      (collection.rowCountDeclared === null ||
        collection.rowCountDeclared === input.sourceProof.rowCount),
    "The selected source collection or original file proof does not match.",
  );
  const members = await unwrapDb(tx)
    .select({
      id: sourceTransactionRecord.id,
      shortcode: sourceTransactionRecord.shortcode,
      externalId: sourceTransactionRecord.externalId,
      chargeKey: sourceTransactionRecord.chargeKey,
      rowPosition: sourceTransactionRecord.rowPosition,
      providerTransactionId: sourceTransactionRecord.providerTransactionId,
    })
    .from(transactionImportRecord)
    .innerJoin(
      sourceTransactionRecord,
      eq(sourceTransactionRecord.id, transactionImportRecord.statementRowId),
    )
    .where(eq(transactionImportRecord.importId, collection.id))
    .orderBy(sourceTransactionRecord.id);
  requireBackfillProof(
    members.some((member) => member.id === record.id) &&
      members.length === input.sourceProof.rowCount,
    "Backfill requires actual membership in the unchanged complete retained file collection.",
  );
  const frozen = await sourceTransactionRecordExternalId({
    source: input.source,
    account: input.originalRow.accountDescriptor,
    date: input.originalRow.statementDate,
    amount: input.originalRow.providerAmount,
    originalStatement: input.originalRow.rawDescription,
  });
  requireBackfillProof(
    record.externalId === frozen &&
      record.legacyExternalId === null &&
      record.rowPosition === null &&
      record.deletedAt === null &&
      record.current &&
      record.withdrawnAt === null &&
      record.withdrawalImportId === null &&
      record.supersededByRowId === null &&
      record.lastObservedAt >= collection.observedAt,
    "The selected frozen reference must be an unpositioned live current observation without withdrawal or supersession.",
  );
  const relevant = await unwrapDb(tx)
    .select()
    .from(sourceTransactionRecord)
    .where(
      and(
        eq(sourceTransactionRecord.source, input.source),
        or(
          eq(sourceTransactionRecord.chargeKey, record.chargeKey),
          eq(
            sourceTransactionRecord.providerTransactionId,
            input.providerTransactionId,
          ),
        ),
        // includes-deleted: retired evidence still owns its provider identity and chronology.
      ),
    )
    .orderBy(sourceTransactionRecord.id);
  requireBackfillProof(
    !relevant.some(
      (row) =>
        row.chargeKey !== record.chargeKey ||
        (row.providerTransactionId !== null &&
          row.providerTransactionId !== input.providerTransactionId) ||
        (row.id !== record.id &&
          (row.current ||
            row.lastObservedAt >= record.lastObservedAt ||
            row.supersededByRowId !== null ||
            row.withdrawnAt !== null)),
    ),
    "Another provider observation owns this ID or conflicts with the selected current chronology.",
  );
  requireBackfillProof(
    !members.some(
      (member) =>
        member.id !== record.id &&
        (member.providerTransactionId === input.providerTransactionId ||
          member.rowPosition === input.originalRow.rowPosition),
    ),
    "The retained collection already claims this provider ID or physical position.",
  );
  const receipts = await readProviderIdBackfillReceipts(tx, members);
  const existing = receipts.get(record.id);
  for (const [id, receipt] of receipts) {
    if (id === record.id) continue;
    requireBackfillProof(
      receipt.input.collectionId !== input.collectionId ||
        (receipt.input.originalRow.rowPosition !==
          input.originalRow.rowPosition &&
          receipt.input.providerTransactionId !== input.providerTransactionId),
      "Another committed backfill proof claims this file position or provider ID.",
    );
  }
  requireBackfillProof(
    record.providerTransactionId === null
      ? !existing
      : existing &&
          receiptMatchesRecord(existing, record) &&
          same(existing.input, input),
    "A filled provider ID requires the exact committed backfill proof; contradictory reuse is held.",
  );

  const accounts = await unwrapDb(tx)
    .select({
      id: financialAccount.id,
      aliases: financialAccount.sourceAliases,
      deletedAt: financialAccount.deletedAt,
    })
    .from(financialAccount)
    .orderBy(financialAccount.id);
  const knownIds = new Set(
    relevant.flatMap((row) =>
      row.providerAccountId ? [row.providerAccountId] : [],
    ),
  );
  requireBackfillProof(
    knownIds.size <= 1,
    "Retained provider account IDs conflict.",
  );
  const labels = new Set(
    [
      record.accountDescriptor,
      input.originalRow.accountDescriptor,
      ...relevant.map((row) => row.accountDescriptor),
    ].map(canonical),
  );
  const aliasAccounts = accounts.filter(
    (account) =>
      account.deletedAt === null &&
      financialAccountSourceAliases
        .parse(account.aliases)
        .some(
          (alias) =>
            alias.source === input.source &&
            (labels.has(canonical(alias.alias)) ||
              (alias.externalAccountId !== null &&
                knownIds.has(alias.externalAccountId))),
        ),
  );
  const claimedIds = new Set(
    aliasAccounts.flatMap((account) =>
      financialAccountSourceAliases
        .parse(account.aliases)
        .filter(
          (alias) =>
            alias.source === input.source && labels.has(canonical(alias.alias)),
        )
        .flatMap((alias) =>
          alias.externalAccountId ? [alias.externalAccountId] : [],
        ),
    ),
  );
  requireBackfillProof(
    new Set([...knownIds, ...claimedIds]).size <= 1,
    "Source aliases conflict with known provider account IDs.",
  );
  const refs = [
    ...new Set(
      relevant.flatMap((row) => [
        row.externalId,
        ...(row.legacyReference ? [row.legacyReference] : []),
      ]),
    ),
  ];
  const owners = await unwrapDb(tx).execute<{
    ownerId: string;
    accountId: string;
    externalId: string;
    transaction: unknown;
    reference: unknown;
  }>(sql`
    SELECT ft.id AS "ownerId", ft."accountId", fx."externalId", to_jsonb(ft) AS transaction, to_jsonb(fx) AS reference
    FROM "EntityExternalId" fx JOIN "FinancialTransaction" ft ON ft.id=fx."entityId"
    WHERE fx.source=${input.source} AND fx.kind='settlement_ref' AND fx."entityKind"=${entitySchema.enum.financialTransaction}
      AND fx."deletedAt" IS NULL AND ft."deletedAt" IS NULL
      AND fx."externalId" IN (${sql.join(
        [...refs, input.providerTransactionId].map((ref) => sql`${ref}`),
        sql`,`,
      )})
    ORDER BY fx.id`);
  const accepted = owners.rows.filter((owner) =>
    refs.includes(owner.externalId),
  );
  const acceptedIds = new Set(accepted.map((owner) => owner.ownerId));
  requireBackfillProof(
    acceptedIds.size <= 1 &&
      !owners.rows.some(
        (owner) =>
          !refs.includes(owner.externalId) && !acceptedIds.has(owner.ownerId),
      ),
    "Independent accepted settlement owners claim this charge or provider ID.",
  );
  const accountIds = new Set([
    ...relevant.flatMap((row) => (row.accountId ? [row.accountId] : [])),
    ...aliasAccounts.map((account) => account.id),
    ...accepted.map((owner) => owner.accountId),
  ]);
  requireBackfillProof(
    accountIds.size === 1 &&
      [...accountIds].every((id) =>
        accounts.some(
          (account) => account.id === id && account.deletedAt === null,
        ),
      ),
    "Backfill requires one proven live account across source aliases, observations and every accepted owner.",
  );
  // Reconstruct the pre-fill snapshot so an exact command repeat uses its committed guard.
  const guard = await sha256Hex(
    canonicalJson(
      jsonSnapshot.parse({
        input,
        record: { ...record, providerTransactionId: null },
        collection,
        members: members.map((member) =>
          member.id === record.id ||
          receipts.get(member.id)?.input.providerTransactionId ===
            member.providerTransactionId
            ? { ...member, providerTransactionId: null }
            : member,
        ),
        relevant: relevant.map((row) =>
          row.id === record.id ? { ...row, providerTransactionId: null } : row,
        ),
        accounts,
        owners: owners.rows,
      }),
    ),
  );
  requireBackfillProof(
    !existing || existing.guard === guard,
    "The collection, account, chronology or accepted ownership changed after the committed proof.",
  );
  return { record, guard, existing };
}

export async function previewProviderIdBackfill(
  db: Database,
  input: ProviderIdBackfillInput,
) {
  return withTransaction(
    db,
    async (tx) => {
      const { guard, existing } = await prepare(tx, input);
      return {
        recordId: input.recordId,
        collectionId: input.collectionId,
        guard,
        status: existing ? "unchanged" : "ready",
      } satisfies z.infer<typeof providerIdBackfillOut>;
    },
    { isolationLevel: "serializable" },
  );
}

export async function backfillProviderId(
  db: Database,
  input: z.infer<typeof applyProviderIdBackfillInput>,
  actor: ActorContext,
) {
  requireBackfillProof(
    actor.runId === null,
    "Provider ID backfill requires a member-authorized local CSV command outside a Run.",
  );
  const { expectedGuard, ...proof } = input;
  return withTransaction(
    db,
    async (tx) => {
      await lockFinancialEvidenceKeys(tx, "transaction-ref", [
        `intake:${input.source}`,
      ]);
      const { record, guard, existing } = await prepare(tx, proof);
      requireBackfillProof(
        expectedGuard === guard,
        "The provider ID backfill guard is stale; preview the original proof again.",
      );
      if (!existing) {
        await unwrapDb(tx)
          .update(sourceTransactionRecord)
          .set({
            providerTransactionId: input.providerTransactionId,
            updatedAt: record.updatedAt,
          })
          .where(eq(sourceTransactionRecord.id, record.id));
        const receipt: ProviderIdBackfillReceipt = {
          kind: "provider_id_backfill_v1",
          guard,
          input: proof,
          before: observationProjection(record),
          externalId: record.externalId,
          chargeKey: record.chargeKey,
          legacyExternalId: record.legacyExternalId,
          legacyReference: record.legacyReference,
        };
        await logAuditEntries(
          tx,
          actor,
          [
            {
              entityKind: "sourceTransactionRecord",
              entityId: record.id,
              action: "update",
              changes: {
                providerTransactionId: {
                  from: null,
                  to: input.providerTransactionId,
                },
                providerIdBackfill: { from: null, to: receipt },
              },
            },
          ],
          "provider-id-backfill",
        );
      }
      return {
        recordId: input.recordId,
        collectionId: input.collectionId,
        guard,
        status: existing ? "unchanged" : "applied",
      } satisfies z.infer<typeof providerIdBackfillOut>;
    },
    { isolationLevel: "serializable" },
  );
}
