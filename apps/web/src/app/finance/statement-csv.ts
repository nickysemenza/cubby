import {
  FINANCIAL_STATEMENT_IMPORT_MAX_ROWS,
  financialStatementImportPreviewInput,
  type FinancialStatementImportRow,
  type FinancialStatementImportPreviewInput,
} from "@cubby/schemas/financial-transaction";
import {
  recordStatementRowsInput,
  STATEMENT_ROW_RECORD_MAX_ROWS,
  type RecordStatementRowsInput,
  type StatementRowInput,
} from "@cubby/schemas/statement-row";
import { parse } from "csv-parse/browser/esm/sync";
import { z } from "zod";

const monarchRow = z.object({
  Date: z.string().min(1),
  Merchant: z.string(),
  Category: z.string().optional().default(""),
  Account: z.string().min(1),
  "Original Statement": z.string(),
  Notes: z.string().optional().default(""),
  Amount: z.string().min(1),
  Id: z.string().optional(),
});

const mintRow = z.object({
  Date: z.string().min(1),
  Description: z.string(),
  "Original Description": z.string(),
  Amount: z.string().min(1),
  "Transaction Type": z.string().min(1),
  Category: z.string().optional().default(""),
  "Account Name": z.string().min(1),
  Notes: z.string().optional().default(""),
});

const copilotRow = z.object({
  date: z.string().min(1),
  name: z.string(),
  amount: z.string().min(1),
  status: z.string(),
  category: z.string().optional().default(""),
  type: z.string(),
  account: z.string().min(1),
  "account mask": z.string().optional().default(""),
  note: z.string().optional().default(""),
});

const appleCardRow = z.object({
  "Transaction Date": z.string().min(1),
  Description: z.string(),
  Merchant: z.string().optional().default(""),
  Category: z.string().optional().default(""),
  Type: z.string().optional().default(""),
  "Amount (USD)": z.string().min(1),
});

function plainDate(value: string): string {
  const trimmed = value.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  const slash = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(trimmed);
  if (!iso && !slash) throw new Error(`Unsupported statement date: ${value}`);
  const year = Number(iso?.[1] ?? slash?.[3]);
  const month = Number(iso?.[2] ?? slash?.[1]);
  const day = Number(iso?.[3] ?? slash?.[2]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() + 1 !== month ||
    date.getUTCDate() !== day
  )
    throw new Error(`Invalid statement date: ${value}`);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function amount(value: string): number {
  const trimmed = value.trim();
  const parenthesized = trimmed.startsWith("(") && trimmed.endsWith(")");
  const normalized = trimmed.replaceAll(/[$,()\s]/g, "");
  const parsed = Number(normalized);
  if (!trimmed || !Number.isFinite(parsed))
    throw new Error(`Invalid statement amount: ${value}`);
  return parenthesized ? -Math.abs(parsed) : parsed;
}

export type CsvColumnMapping = {
  source: string;
  account: string;
  accountColumn: string;
  date: string;
  amount: string;
  description: string;
  merchant: string;
  category: string;
  notes: string;
  direction: string;
  status: string;
  pendingValue: string;
  chargeValue: string;
  creditValue: string;
  sign: "charges-negative" | "charges-positive" | "direction-column";
};
export type ParsedStatementCsv = {
  source: string;
  label: string;
  fingerprint: string;
  rows: FinancialStatementImportRow[];
  recordRows: StatementRowInput[];
  pending: number;
  zeroValueRows: number;
  dateKind: "posted" | "transaction" | "unknown";
};

const requiredHeaders = {
  monarch: ["Date", "Merchant", "Account", "Original Statement", "Amount"],
  mint: [
    "Date",
    "Description",
    "Original Description",
    "Transaction Type",
    "Account Name",
  ],
  copilot: ["date", "name", "amount", "status", "type", "account"],
  "apple-card": [
    "Transaction Date",
    "Description",
    "Merchant",
    "Type",
    "Amount (USD)",
  ],
};

export function statementCsvHeaders(text: string): string[] {
  const rows = z.array(z.array(z.string())).parse(
    parse(text, {
      bom: true,
      to_line: 1,
      skip_empty_lines: true,
    }),
  );
  return rows[0] ?? [];
}

export function recognizedStatementSource(headers: string[]): string | null {
  for (const source of ["monarch", "mint", "copilot", "apple-card"] as const) {
    if (requiredHeaders[source].every((header) => headers.includes(header)))
      return source;
  }
  return null;
}

function detectSource(headers: string[]): string {
  const source = recognizedStatementSource(headers);
  if (source) return source;
  throw new Error(
    "Unsupported CSV columns. Choose a Monarch, Mint, Copilot, or Apple Card transaction export.",
  );
}

function mappedValue(row: Record<string, string>, column: string): string {
  return column ? (row[column] ?? "").trim() : "";
}

export function parseMappedStatementCsv(
  text: string,
  label: string,
  fingerprint: string,
  mapping: CsvColumnMapping,
): ParsedStatementCsv {
  const records = z
    .array(z.record(z.string(), z.string()))
    .nonempty()
    .parse(parse(text, { columns: true, bom: true, skip_empty_lines: true }));
  const headers = Object.keys(records[0]!);
  for (const column of [
    mapping.date,
    mapping.amount,
    mapping.description,
    mapping.accountColumn,
    mapping.merchant,
    mapping.category,
    mapping.notes,
    mapping.direction,
    mapping.status,
  ].filter(Boolean)) {
    if (!headers.includes(column))
      throw new Error(`Missing CSV column: ${column}`);
  }
  const source = z
    .string()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .parse(mapping.source.trim().toLowerCase());
  if (!mapping.account.trim() && !mapping.accountColumn)
    throw new Error("Enter an account or choose its CSV column");
  if (!mapping.date || !mapping.amount || !mapping.description)
    throw new Error("Choose date, amount, and description columns");
  if (
    mapping.sign === "direction-column" &&
    (!mapping.direction || !mapping.chargeValue || !mapping.creditValue)
  )
    throw new Error(
      "Choose a direction column and its charge and credit values",
    );
  const normalized = records.map((record, index) => {
    const account = mapping.accountColumn
      ? mappedValue(record, mapping.accountColumn)
      : mapping.account.trim();
    if (!account) throw new Error(`Row ${index + 1} has no account`);
    const date = plainDate(mappedValue(record, mapping.date));
    const signedAmount = amount(mappedValue(record, mapping.amount));
    let providerAmount: number;
    if (mapping.sign === "direction-column") {
      const direction = mappedValue(record, mapping.direction).toLowerCase();
      if (direction === mapping.chargeValue.trim().toLowerCase())
        providerAmount = -Math.abs(signedAmount);
      else if (direction === mapping.creditValue.trim().toLowerCase())
        providerAmount = Math.abs(signedAmount);
      else
        throw new Error(
          `Row ${index + 1} has an unknown direction: ${direction}`,
        );
    } else {
      providerAmount =
        mapping.sign === "charges-positive" ? -signedAmount : signedAmount;
    }
    if (providerAmount === 0) return null;
    const rawDescription = mappedValue(record, mapping.description);
    if (!rawDescription) throw new Error(`Row ${index + 1} has no description`);
    const merchant = mappedValue(record, mapping.merchant) || null;
    const category = mappedValue(record, mapping.category) || null;
    const notes = mappedValue(record, mapping.notes) || null;
    const pending = Boolean(
      mapping.status &&
      mapping.pendingValue &&
      mappedValue(record, mapping.status).toLowerCase() ===
        mapping.pendingValue.trim().toLowerCase(),
    );
    return {
      preview: {
        key: String(index + 1),
        source,
        account,
        date,
        amount: providerAmount,
        merchant,
        originalStatement: rawDescription,
        category,
        notes,
      },
      record: {
        accountDescriptor: account,
        statementDate: date,
        providerAmount,
        merchant,
        rawDescription,
        sourceCategory: category,
        providerStatus: pending ? ("pending" as const) : ("posted" as const),
        providerNotes: notes,
      },
      pending,
    };
  });
  const nonzero = normalized.filter(
    (row): row is NonNullable<typeof row> => row !== null,
  );
  if (!nonzero.length)
    throw new Error("This CSV has no nonzero statement rows to save");
  return {
    source,
    label,
    fingerprint,
    rows: nonzero.filter((row) => !row.pending).map((row) => row.preview),
    recordRows: nonzero.map((row) => row.record),
    pending: nonzero.filter((row) => row.pending).length,
    zeroValueRows: records.length - nonzero.length,
    dateKind: "unknown",
  };
}

function accountWithMask(account: string, mask: string): string {
  const name = account.trim();
  const digits = mask.replaceAll(/\D/g, "").slice(-4);
  if (!digits || name.includes(digits)) return name;
  return `${name} (...${digits})`;
}

type NormalizedKnown = {
  date: string;
  providerAmount: number;
  account: string;
  merchant: string | null;
  rawDescription: string;
  category: string | null;
  notes: string | null;
  pending: boolean;
};

function normalizeMonarchRow(record: Record<string, string>): NormalizedKnown {
  const row = monarchRow.parse(record);
  const merchant = row.Merchant.trim() || null;
  return {
    date: plainDate(row.Date),
    providerAmount: amount(row.Amount),
    account: row.Account.trim(),
    merchant,
    rawDescription: row["Original Statement"].trim() || merchant || "",
    category: row.Category.trim() || null,
    notes: row.Notes.trim() || null,
    pending: false,
  };
}

function normalizeMintRow(
  record: Record<string, string>,
  index: number,
): NormalizedKnown {
  const row = mintRow.parse(record);
  const transactionType = row["Transaction Type"].trim().toLowerCase();
  if (transactionType !== "debit" && transactionType !== "credit")
    throw new Error(`Mint row ${index + 1} has an unknown transaction type`);
  const merchant = row.Description.trim() || null;
  return {
    date: plainDate(row.Date),
    providerAmount:
      (transactionType === "debit" ? -1 : 1) * Math.abs(amount(row.Amount)),
    account: row["Account Name"].trim(),
    merchant,
    rawDescription: row["Original Description"].trim() || merchant || "",
    category: row.Category.trim() || null,
    notes: row.Notes.trim() || null,
    pending: false,
  };
}

function normalizeCopilotRow(record: Record<string, string>): NormalizedKnown {
  const row = copilotRow.parse(record);
  const merchant = row.name.trim() || null;
  return {
    date: plainDate(row.date),
    // Copilot exports charges positive; Cubby's provider evidence is charges-negative.
    providerAmount: -amount(row.amount),
    account: accountWithMask(row.account, row["account mask"]),
    merchant,
    rawDescription: merchant || "",
    category: row.category.trim() || null,
    notes: row.note.trim() || null,
    pending: row.status.trim().toLowerCase() === "pending",
  };
}

function normalizeAppleCardRow(
  record: Record<string, string>,
): NormalizedKnown {
  const row = appleCardRow.parse(record);
  const merchant = row.Merchant.trim() || null;
  return {
    date: plainDate(row["Transaction Date"]),
    providerAmount: -amount(row["Amount (USD)"]),
    account: "Apple Card",
    merchant,
    rawDescription: row.Description.trim() || merchant || "",
    category: row.Category.trim() || null,
    notes: row.Type.trim() || null,
    pending: false,
  };
}

function normalizeKnownRow(
  source: string,
  record: Record<string, string>,
  index: number,
): NormalizedKnown {
  switch (source) {
    case "monarch":
      return normalizeMonarchRow(record);
    case "mint":
      return normalizeMintRow(record, index);
    case "copilot":
      return normalizeCopilotRow(record);
    case "apple-card":
      return normalizeAppleCardRow(record);
    default:
      throw new Error(`Unsupported statement source: ${source}`);
  }
}

export function parseStatementCsv(
  text: string,
  label: string,
  fingerprint: string,
): ParsedStatementCsv {
  const records = z
    .array(z.record(z.string(), z.string()))
    .nonempty()
    .parse(parse(text, { columns: true, bom: true, skip_empty_lines: true }));
  const source = detectSource(Object.keys(records[0]!));
  const normalized = records.map((record, index) => {
    const {
      date,
      providerAmount,
      account,
      merchant,
      rawDescription,
      category,
      notes,
      pending,
    } = normalizeKnownRow(source, record, index);
    if (providerAmount === 0) return null;
    if (!rawDescription)
      throw new Error(`Row ${index + 1} has no statement description`);
    return {
      preview: {
        key: String(index + 1),
        source,
        account,
        date,
        amount: providerAmount,
        merchant,
        originalStatement: rawDescription,
        category,
        notes,
      },
      record: {
        accountDescriptor: account,
        statementDate: date,
        providerAmount,
        merchant,
        rawDescription,
        sourceCategory: category,
        providerStatus: pending ? ("pending" as const) : ("posted" as const),
        providerNotes: notes,
      },
      pending,
    };
  });
  const nonzero = normalized.filter(
    (row): row is NonNullable<typeof row> => row !== null,
  );
  if (!nonzero.length)
    throw new Error("This CSV has no nonzero statement rows to save");
  return {
    source,
    label,
    fingerprint,
    rows: nonzero.filter((row) => !row.pending).map((row) => row.preview),
    recordRows: nonzero.map((row) => row.record),
    pending: nonzero.filter((row) => row.pending).length,
    zeroValueRows: records.length - nonzero.length,
    dateKind:
      source === "monarch"
        ? "posted"
        : source === "apple-card"
          ? "transaction"
          : "unknown",
  };
}

export function previewStatementBatch(
  parsed: ParsedStatementCsv,
  offset = 0,
): FinancialStatementImportPreviewInput | null {
  const rows = parsed.rows.slice(
    offset,
    offset + FINANCIAL_STATEMENT_IMPORT_MAX_ROWS,
  );
  return rows.length
    ? financialStatementImportPreviewInput.parse({ rows })
    : null;
}

export function recordStatementBatch(
  parsed: ParsedStatementCsv,
  offset = 0,
): RecordStatementRowsInput {
  return recordStatementRowsInput.parse({
    import: {
      source: parsed.source,
      label: parsed.label,
      fingerprint: parsed.fingerprint,
      dateKind: parsed.dateKind,
      rowCountDeclared: parsed.recordRows.length,
      notes: null,
    },
    rows: parsed.recordRows.slice(
      offset,
      offset + STATEMENT_ROW_RECORD_MAX_ROWS,
    ),
    dryRun: false,
  });
}

export async function fingerprintStatementCsv(file: File): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    await file.arrayBuffer(),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
