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
import { sha256Hex } from "@cubby/shared/sha256";
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

// csv-parse includes blank lines in raw; strip those before counting the
// physical starting line so multiline cells do not shift later identities.
function positionedRecords(text: string) {
  return z
    .array(
      z.object({
        record: z.record(z.string(), z.string()),
        raw: z.string(),
        info: z.object({ lines: z.number().int() }),
      }),
    )
    .nonempty()
    .parse(
      parse(text, {
        columns: true,
        bom: true,
        skip_empty_lines: true,
        info: true,
        raw: true,
      }),
    )
    .map(({ record, raw, info }) => {
      const content = raw.replace(/^(?:\r\n|\n|\r)+/, "");
      const breaks = content.match(/\r\n|\n|\r/g)?.length ?? 0;
      const terminated = /(?:\r\n|\n|\r)$/.test(content);
      return {
        record,
        rowPosition: info.lines - breaks + (terminated ? 1 : 0),
      };
    });
}

function providerId(source: string, record: Record<string, string>) {
  return source === "monarch" ? record.Id?.trim() || null : null;
}

/** One normalized CSV row as the preview row and the recorded evidence row. */
function buildStatementRow(input: {
  index: number;
  source: string;
  fingerprint: string;
  rowPosition: number;
  providerId: string | null;
  account: string;
  date: string;
  providerAmount: number;
  merchant: string | null;
  rawDescription: string;
  category: string | null;
  notes: string | null;
  pending: boolean;
}) {
  const providerStatus = input.pending
    ? ("pending" as const)
    : ("posted" as const);
  return {
    preview: {
      key: String(input.index + 1),
      importFingerprint: input.fingerprint,
      rowPosition: input.rowPosition,
      providerTransactionId: input.providerId,
      providerStatus,
      source: input.source,
      account: input.account,
      date: input.date,
      amount: input.providerAmount,
      merchant: input.merchant,
      originalStatement: input.rawDescription,
      category: input.category,
      notes: input.notes,
    },
    record: {
      rowPosition: input.rowPosition,
      providerTransactionId: input.providerId,
      accountDescriptor: input.account,
      statementDate: input.date,
      providerAmount: input.providerAmount,
      merchant: input.merchant,
      rawDescription: input.rawDescription,
      sourceCategory: input.category,
      providerStatus,
      providerNotes: input.notes,
    },
    pending: input.pending,
  };
}

/** Splits built rows into the previewable (posted, nonzero) set and counts. */
function assembleParsedStatement(
  header: Pick<
    ParsedStatementCsv,
    "source" | "label" | "fingerprint" | "dateKind"
  >,
  normalized: ReturnType<typeof buildStatementRow>[],
): ParsedStatementCsv {
  const nonzero = normalized.filter((row) => row.record.providerAmount !== 0);
  return {
    ...header,
    rows: nonzero.filter((row) => !row.pending).map((row) => row.preview),
    recordRows: normalized.map((row) => row.record),
    pending: nonzero.filter((row) => row.pending).length,
    zeroValueRows: normalized.length - nonzero.length,
  };
}

export function parseMappedStatementCsv(
  text: string,
  label: string,
  fingerprint: string,
  mapping: CsvColumnMapping,
): ParsedStatementCsv {
  const records = positionedRecords(text);
  const headers = Object.keys(records[0]!.record);
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
  const normalized = records.map(({ record, rowPosition }, index) => {
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
    const rawDescription = mappedValue(record, mapping.description);
    if (!rawDescription && providerAmount !== 0)
      throw new Error(`Row ${index + 1} has no description`);
    const merchant = mappedValue(record, mapping.merchant) || null;
    const category = mappedValue(record, mapping.category) || null;
    const notes = mappedValue(record, mapping.notes) || null;
    const pending = Boolean(
      mapping.status &&
      mapping.pendingValue &&
      mappedValue(record, mapping.status).toLowerCase() ===
        mapping.pendingValue.trim().toLowerCase(),
    );
    return buildStatementRow({
      index,
      source,
      fingerprint,
      rowPosition,
      providerId: providerId(source, record),
      account,
      date,
      providerAmount,
      merchant,
      rawDescription,
      category,
      notes,
      pending,
    });
  });
  return assembleParsedStatement(
    { source, label, fingerprint, dateKind: "unknown" },
    normalized,
  );
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
  const records = positionedRecords(text);
  const source = detectSource(Object.keys(records[0]!.record));
  const normalized = records.map(({ record, rowPosition }, index) => {
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
    if (!rawDescription && providerAmount !== 0)
      throw new Error(`Row ${index + 1} has no statement description`);
    return buildStatementRow({
      index,
      source,
      fingerprint,
      rowPosition,
      providerId: providerId(source, record),
      account,
      date,
      providerAmount,
      merchant,
      rawDescription,
      category,
      notes,
      pending,
    });
  });
  return assembleParsedStatement(
    {
      source,
      label,
      fingerprint,
      dateKind:
        source === "monarch"
          ? "posted"
          : source === "apple-card"
            ? "transaction"
            : "unknown",
    },
    normalized,
  );
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
  return sha256Hex(await file.text());
}
