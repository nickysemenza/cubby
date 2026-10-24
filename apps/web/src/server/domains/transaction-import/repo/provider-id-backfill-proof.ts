import {
  providerIdBackfillReceipt,
  sourceObservationProjection,
  type ProviderIdBackfillInput,
  type ProviderIdBackfillReceipt,
  type SourceTransactionRecordInput,
} from "@cubby/schemas/source-transaction-record";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import type { DrizzleTransaction } from "~/server/db";
import { unwrapDb } from "~/server/db/helpers";
import { auditLog, sourceTransactionRecord } from "~/server/db/schema";
import { createAppError } from "~/server/errors/app-error";
import { canonicalJson } from "~/server/lib/canonical-json";

import { sourceTransactionRecordExternalId } from "./source-transaction-record-identity";

export const observationProjection = (
  row:
    | SourceTransactionRecordInput
    | typeof sourceTransactionRecord.$inferSelect,
) =>
  sourceObservationProjection.parse({
    accountDescriptor: row.accountDescriptor,
    statementDate: row.statementDate,
    providerAmount: row.providerAmount,
    rawDescription: row.rawDescription,
    rowPosition: row.rowPosition ?? null,
    providerTransactionId: row.providerTransactionId ?? null,
    providerAccountId: row.providerAccountId ?? null,
    providerData: row.providerData ?? null,
    merchant: row.merchant,
    sourceCategory: row.sourceCategory,
    providerStatus: row.providerStatus,
    providerNotes: row.providerNotes,
  });

/** Validate the supported parser's default Monarch projection, not arbitrary caller normalization. */
export function checkOriginalCsv(input: ProviderIdBackfillInput) {
  const { originalRow: row, sourceProof: proof } = input;
  const { fields, csv } = row.providerData;
  const optional = (key: string) => fields[key]?.trim() || null;
  const rawDate = fields.Date?.trim();
  const dateParts = rawDate?.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  const day = dateParts
    ? `${dateParts[3]}-${dateParts[1]?.padStart(2, "0")}-${dateParts[2]?.padStart(2, "0")}`
    : rawDate;
  const rawAmount = fields.Amount?.trim() ?? "";
  const numeric = rawAmount.replace(/[$,()\s]/g, "");
  const amount =
    Number(numeric) *
    (rawAmount.startsWith("(") && rawAmount.endsWith(")") ? -1 : 1);
  const status = optional("Status")?.toLowerCase();
  requireBackfillProof(
    ["Date", "Merchant", "Account", "Original Statement", "Amount", "Id"].every(
      (key) => key in fields,
    ) &&
      fields.Id === input.providerTransactionId &&
      row.providerTransactionId === input.providerTransactionId &&
      csv.fileSha256 === input.fingerprint &&
      csv.sourceAmount === fields.Amount &&
      canonicalJson(proof.identityPositions) ===
        canonicalJson([row.rowPosition]) &&
      canonicalJson(proof.providerIdPositions) ===
        canonicalJson([row.rowPosition]) &&
      /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(numeric) &&
      row.providerAmount === amount &&
      row.statementDate === day &&
      row.accountDescriptor === optional("Account") &&
      row.merchant === optional("Merchant") &&
      row.rawDescription ===
        (optional("Original Statement") ?? optional("Merchant") ?? "") &&
      row.sourceCategory === optional("Category") &&
      row.providerNotes === optional("Notes") &&
      row.providerStatus ===
        (status === "pending" || status === "posted" ? status : null) &&
      row.providerAccountId === null,
    "Backfill requires one unique original occurrence from the complete authorized default Monarch CSV parser output.",
  );
}

const receiptChanges = z.object({
  providerTransactionId: z.object({ from: z.null(), to: z.string() }),
  providerIdBackfill: z.object({
    from: z.null(),
    to: providerIdBackfillReceipt,
  }),
});

export function requireBackfillProof(
  condition: unknown,
  message: string,
): asserts condition {
  if (!condition) throw createAppError("CONSTRAINT_VIOLATION", message);
}

/** Read only this command's typed receipt; malformed/duplicate history fails closed. */
export async function readProviderIdBackfillReceipts(
  tx: DrizzleTransaction,
  records: readonly Pick<
    typeof sourceTransactionRecord.$inferSelect,
    "id" | "shortcode"
  >[],
) {
  const receipts = new Map<string, ProviderIdBackfillReceipt>();
  if (!records.length) return receipts;
  const audits = await unwrapDb(tx)
    .select({ entityId: auditLog.entityId, changes: auditLog.changes })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.entityKind, "sourceTransactionRecord"),
        inArray(
          auditLog.entityId,
          records.map((record) => record.id),
        ),
        sql`${auditLog.changes} ? 'providerIdBackfill'`,
      ),
    );
  for (const audit of audits) {
    const parsed = receiptChanges.safeParse(audit.changes);
    requireBackfillProof(
      parsed.success,
      "The provider ID backfill audit proof is malformed.",
    );
    const receipt = parsed.data.providerIdBackfill.to;
    checkOriginalCsv(receipt.input);
    const frozen = await sourceTransactionRecordExternalId({
      source: receipt.input.source,
      account: receipt.input.originalRow.accountDescriptor,
      date: receipt.input.originalRow.statementDate,
      amount: receipt.input.originalRow.providerAmount,
      originalStatement: receipt.input.originalRow.rawDescription,
    });
    requireBackfillProof(
      !receipts.has(audit.entityId) &&
        receipt.before.providerTransactionId === null &&
        receipt.before.rowPosition === null &&
        receipt.legacyExternalId === null &&
        receipt.externalId === frozen &&
        receipt.input.providerTransactionId ===
          parsed.data.providerTransactionId.to &&
        records.some(
          (record) =>
            record.id === audit.entityId &&
            record.shortcode === receipt.input.recordId,
        ),
      "The provider ID backfill audit proof is contradictory.",
    );
    receipts.set(audit.entityId, receipt);
  }
  return receipts;
}

export function receiptMatchesRecord(
  receipt: ProviderIdBackfillReceipt,
  record: typeof sourceTransactionRecord.$inferSelect,
) {
  return (
    record.shortcode === receipt.input.recordId &&
    record.source === receipt.input.source &&
    record.externalId === receipt.externalId &&
    record.chargeKey === receipt.chargeKey &&
    record.legacyExternalId === receipt.legacyExternalId &&
    record.legacyReference === receipt.legacyReference &&
    canonicalJson(observationProjection(record)) ===
      canonicalJson({
        ...receipt.before,
        providerTransactionId: receipt.input.providerTransactionId,
      })
  );
}

/** Only two complete projections can recover a frozen occurrence, never partial field wildcards. */
export function receiptMatchesReplay(
  receipt: ProviderIdBackfillReceipt,
  row: SourceTransactionRecordInput,
) {
  const projection = canonicalJson(observationProjection(row));
  return (
    projection === canonicalJson(receipt.before) ||
    projection ===
      canonicalJson(observationProjection(receipt.input.originalRow))
  );
}
