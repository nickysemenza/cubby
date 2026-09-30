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
import { createAppError } from "~/server/errors/app-error";
import { previewFinancialStatementImport } from "~/server/repo/financial-statement-preview";
import { createFinancialTransaction } from "~/server/repo/financial-transaction";
import {
  recordStatementRows,
  attachStatementObservation,
  updateStatementRows,
} from "~/server/repo/statement-row";

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

function validateDecisions(
  decisions: StatementCsvCommitInput["selected"],
  previewRows: FinancialStatementImportPreviewOut["rows"],
) {
  const selected = new Map(decisions.map((row) => [row.key, row]));
  if (selected.size !== decisions.length)
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      "A statement row was selected more than once.",
    );
  const attachTargets = decisions.flatMap((row) =>
    row.transactionId ? [row.transactionId] : [],
  );
  if (new Set(attachTargets).size !== attachTargets.length)
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      "Two occurrences in one file cannot attach to the same transaction. Review each purchase separately.",
    );
  for (const key of selected.keys()) {
    const row = previewRows.find((candidate) => candidate.key === key);
    if (!row)
      throw createAppError(
        "CONSTRAINT_VIOLATION",
        `Statement row ${key} is unavailable for transaction creation.`,
      );
    const decision = selected.get(key)!;
    if (decision.transactionId) {
      if (
        !row.existingTransactionIds.includes(decision.transactionId) ||
        (row.status !== "possible_existing" &&
          row.status !== "already_recorded")
      )
        throw createAppError(
          "CONSTRAINT_VIOLATION",
          `Statement row ${key} needs review: selected transaction is unavailable.`,
        );
    } else if (
      row.status !== "ready_to_create" &&
      row.status !== "already_recorded"
    ) {
      throw createAppError(
        "CONSTRAINT_VIOLATION",
        `Statement row ${key} needs review: ${row.status}.`,
      );
    } else if (row.status === "ready_to_create" && !decision.kind) {
      throw createAppError(
        "CONSTRAINT_VIOLATION",
        `Choose a transaction kind for statement row ${key}.`,
      );
    }
  }
  return selected;
}

async function commitPreviewRows(
  db: Database,
  actor: ActorContext,
  parsed: ReturnType<typeof parseStatementCsv>,
  previewRows: FinancialStatementImportPreviewOut["rows"],
  selected: Map<string, StatementCsvCommitInput["selected"][number]>,
) {
  let transactions = 0;
  let attached = 0;
  for (const row of previewRows) {
    const decision = selected.get(row.key);
    const observation = parsed.rows.find(
      (inputRow) => inputRow.key === row.key,
    );
    const target =
      decision?.transactionId ??
      (row.status === "already_recorded" &&
      row.existingTransactionIds.length === 1
        ? row.existingTransactionIds[0]
        : undefined);
    if (row.accountId && (target || decision?.kind)) {
      await updateStatementRows(
        db,
        {
          selector: {
            source: row.proposed.sourceRef.source,
            externalIds: [row.proposed.sourceRef.externalId],
          },
          data: { accountId: row.accountId },
        },
        actor,
      );
    }
    if (target && observation) {
      if (await attachStatementObservation(db, observation, target, actor))
        attached++;
      continue;
    }
    const kind = decision?.kind;
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
  return { transactions, attached };
}

export async function commitStatementCsv(
  db: Database,
  actor: ActorContext,
  input: StatementCsvCommitInput,
) {
  const { parsed } = await parseFile(input);
  if (!parsed)
    throw new Error("Map the CSV columns before confirming the import.");
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
  const selected = validateDecisions(input.selected, previewRows);
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
  const { transactions, attached } = await commitPreviewRows(
    db,
    actor,
    parsed,
    previewRows,
    selected,
  );
  return {
    transactions,
    attached,
    evidence,
    alreadyPresent: parsed.recordRows.length - evidence,
  };
}
