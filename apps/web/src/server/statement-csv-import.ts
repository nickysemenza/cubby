import type { ActorContext } from "@cubby/schemas/context";
import {
  FINANCIAL_STATEMENT_IMPORT_MAX_ROWS,
  financialTransactionCreateInput,
  type FinancialStatementImportPreviewOut,
} from "@cubby/schemas/financial-transaction";
import {
  STATEMENT_ROW_RECORD_MAX_ROWS,
  type StatementCsvCommitInput,
  type StatementCsvFileInput,
} from "@cubby/schemas/statement-row";

import {
  parseMappedStatementCsv,
  parseStatementCsv,
  previewStatementBatch,
  recognizedStatementSource,
  recordStatementBatch,
  statementCsvHeaders,
} from "~/app/finance/statement-csv";
import type { Database } from "~/server/db";
import { previewFinancialStatementImport } from "~/server/repo/financial-statement-preview";
import { createFinancialTransaction } from "~/server/repo/financial-transaction";
import { recordStatementRows } from "~/server/repo/statement-row";

async function parseFile(input: StatementCsvFileInput) {
  const headers = statementCsvHeaders(input.text);
  const needsMapping = !input.mapping && !recognizedStatementSource(headers);
  if (needsMapping) return { headers, parsed: null };
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input.text),
  );
  const fingerprint = Array.from(new Uint8Array(hash), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  const parsed = input.mapping
    ? parseMappedStatementCsv(
        input.text,
        input.fileName,
        fingerprint,
        input.mapping,
      )
    : parseStatementCsv(input.text, input.fileName, fingerprint);
  return { headers, parsed };
}

export async function previewStatementCsv(
  db: Database,
  _actor: ActorContext,
  input: StatementCsvFileInput,
) {
  const { headers, parsed } = await parseFile(input);
  if (!parsed)
    return {
      headers,
      needsMapping: true,
      source: null,
      totalRows: 0,
      pendingRows: 0,
      zeroValueRows: 0,
      previewOffset: 0,
      hasMore: false,
      preview: null,
    };
  const offset = input.previewOffset ?? 0;
  const batch = previewStatementBatch(parsed, offset);
  const preview = batch
    ? await previewFinancialStatementImport(db, batch)
    : null;
  return {
    headers,
    needsMapping: false,
    source: parsed.source,
    totalRows: parsed.recordRows.length,
    pendingRows: parsed.pending,
    zeroValueRows: parsed.zeroValueRows,
    previewOffset: offset,
    hasMore: offset + (preview?.rows.length ?? 0) < parsed.rows.length,
    preview,
  };
}

export async function commitStatementCsv(
  db: Database,
  actor: ActorContext,
  input: StatementCsvCommitInput,
) {
  const { parsed } = await parseFile(input);
  if (!parsed)
    throw new Error("Map the CSV columns before confirming the import.");
  const selected = new Map(input.selected.map((row) => [row.key, row.kind]));
  if (selected.size !== input.selected.length)
    throw new Error("A statement row was selected more than once.");
  const previewRows: FinancialStatementImportPreviewOut["rows"] = [];
  for (
    let offset = 0;
    offset < parsed.rows.length;
    offset += FINANCIAL_STATEMENT_IMPORT_MAX_ROWS
  ) {
    const batch = previewStatementBatch(parsed, offset);
    if (!batch) continue;
    const preview = await previewFinancialStatementImport(db, batch);
    previewRows.push(...preview.rows);
  }
  for (const key of selected.keys()) {
    const row = previewRows.find((candidate) => candidate.key === key);
    if (!row)
      throw new Error(
        `Statement row ${key} is unavailable for transaction creation.`,
      );
    if (row.status !== "ready_to_create" && row.status !== "already_recorded")
      throw new Error(`Statement row ${key} needs review: ${row.status}.`);
  }
  let evidence = 0;
  for (
    let offset = 0;
    offset < parsed.recordRows.length;
    offset += STATEMENT_ROW_RECORD_MAX_ROWS
  ) {
    const result = await recordStatementRows(
      db,
      recordStatementBatch(parsed, offset),
      actor,
    );
    evidence += result.inserted;
  }
  let transactions = 0;
  for (const row of previewRows) {
    const kind = selected.get(row.key);
    if (!kind || row.status !== "ready_to_create") continue;
    if (!row.accountId)
      throw new Error(`No account for statement row ${row.key}.`);
    const proposed = row.proposed;
    await createFinancialTransaction(
      db,
      financialTransactionCreateInput.parse({
        accountId: row.accountId,
        purchaseId: null,
        kind,
        status: proposed.status,
        amount: proposed.amount,
        transactionDate: proposed.transactionDate,
        postedDate: proposed.postedDate,
        merchant: proposed.merchant,
        rawDescription: proposed.rawDescription,
        sourceCategory: proposed.sourceCategory,
        sourceRefs: [proposed.sourceRef],
        notes: proposed.notes,
      }),
      actor,
    );
    transactions++;
  }
  return {
    transactions,
    evidence,
    alreadyPresent: parsed.recordRows.length - evidence,
  };
}
