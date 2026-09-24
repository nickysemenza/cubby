import {
  financialStatementImportPreviewInput,
  type FinancialStatementImportPreviewInput,
} from "@cubby/schemas/financial-transaction";
import {
  recordStatementRowsInput,
  type RecordStatementRowsInput,
} from "@cubby/schemas/statement-row";
import { parse } from "csv-parse/browser/esm/sync";
import { z } from "zod";

const monarchExportRow = z.object({
  Date: z.string().min(1),
  Merchant: z.string(),
  Category: z.string(),
  Account: z.string().min(1),
  "Original Statement": z.string(),
  Notes: z.string(),
  Amount: z.string().min(1),
  Id: z.string().optional(),
});

function plainDate(value: string): string {
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(trimmed);
  if (!match) throw new Error(`Unsupported Monarch date: ${value}`);
  return `${match[3]}-${match[1]!.padStart(2, "0")}-${match[2]!.padStart(2, "0")}`;
}

function amount(value: string): number {
  const trimmed = value.trim();
  const parenthesized = trimmed.startsWith("(") && trimmed.endsWith(")");
  const normalized = trimmed.replaceAll(/[$,()\s]/g, "");
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed === 0)
    throw new Error(`Invalid Monarch amount: ${value}`);
  return parenthesized ? -Math.abs(parsed) : parsed;
}

export type ParsedMonarchCsv = {
  preview: FinancialStatementImportPreviewInput;
  record: RecordStatementRowsInput;
};

export function parseMonarchCsv(
  text: string,
  label: string,
  fingerprint: string,
): ParsedMonarchCsv {
  const rows = z
    .array(monarchExportRow)
    .nonempty()
    .parse(parse(text, { columns: true, bom: true, skip_empty_lines: true }));
  const normalized = rows.map((row, index) => {
    const date = plainDate(row.Date);
    const providerAmount = amount(row.Amount);
    const merchant = row.Merchant.trim() || null;
    const rawDescription = row["Original Statement"].trim() || merchant;
    if (!rawDescription)
      throw new Error(`Row ${index + 1} has no statement description`);
    return {
      key: row.Id?.trim() || String(index + 1),
      account: row.Account.trim(),
      date,
      amount: providerAmount,
      merchant,
      originalStatement: rawDescription,
      category: row.Category.trim() || null,
      notes: row.Notes.trim() || null,
    };
  });
  return {
    preview: financialStatementImportPreviewInput.parse({
      rows: normalized.map((row) => ({ ...row, source: "monarch" })),
    }),
    record: recordStatementRowsInput.parse({
      import: {
        source: "monarch",
        label,
        fingerprint,
        dateKind: "posted",
        rowCountDeclared: normalized.length,
        notes: null,
      },
      rows: normalized.map((row) => ({
        accountDescriptor: row.account,
        statementDate: row.date,
        providerAmount: row.amount,
        merchant: row.merchant,
        rawDescription: row.originalStatement,
        sourceCategory: row.category,
        providerStatus: "posted",
        providerNotes: row.notes,
      })),
      dryRun: false,
    }),
  };
}

export async function fingerprintMonarchCsv(file: File): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    await file.arrayBuffer(),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
