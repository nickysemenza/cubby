import {
  type FinancialAccountIdentity,
  financialAccountIdentity,
  financialAccountSourceAliases,
} from "@cubby/schemas/financial-account";
import {
  type FinancialStatementImportPreviewInput,
  type FinancialStatementImportPreviewOut,
  financialTransactionSourceRefs,
} from "@cubby/schemas/financial-transaction";
import {
  unsafeFinancialAccountShortcode,
  unsafeFinancialTransactionShortcode,
} from "@cubby/schemas/identifiers";
import type { Database } from "~/server/db";
import { financialAccount, financialTransaction } from "~/server/db/schema";
import { notDeleted, unwrapDb } from "~/server/repo/database-helpers";

const canonical = (value: string) =>
  value.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();

const cents = (value: number) => Math.round(value * 100);

const toHex = (value: ArrayBuffer) =>
  [...new Uint8Array(value)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

async function sourceExternalId(
  row: FinancialStatementImportPreviewInput["rows"][number],
) {
  // These are provider-origin fields, deliberately excluding mutable cleanup
  // metadata such as Monarch's merchant/category labels and export filename.
  const payload = [
    "monarch:v1",
    canonical(row.account),
    row.date,
    String(cents(row.amount)),
    canonical(row.originalStatement),
  ].join("\u0000");
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(payload),
  );
  return `v1:${toHex(digest)}`;
}

const networkFromDescriptor = (descriptor: string) => {
  const normalized = canonical(descriptor);
  if (normalized.includes("visa")) return "visa" as const;
  if (normalized.includes("mastercard")) return "mastercard" as const;
  if (normalized.includes("amex") || normalized.includes("american express"))
    return "amex" as const;
  if (normalized.includes("discover")) return "discover" as const;
  return null;
};

const last4FromDescriptor = (descriptor: string) => {
  const match = descriptor.match(/(\d{4})(?!.*\d)/);
  return match?.[1] ?? null;
};

const provisionalAccountFor = (
  row: FinancialStatementImportPreviewInput["rows"][number],
) => {
  const last4 = last4FromDescriptor(row.account);
  const network = networkFromDescriptor(row.account);
  const identity: FinancialAccountIdentity =
    last4 || network
      ? {
          kind: "credit_card",
          issuer: null,
          network: network ?? "other",
          last4,
        }
      : { kind: "other", institution: null, last4: null };
  return {
    name: row.account.trim(),
    identity,
    provisional: true as const,
    sourceAliases: [
      {
        source: row.source,
        alias: row.account.trim(),
        externalAccountId: null,
      },
    ],
  };
};

/**
 * Preview only: client-parsed rows become a decision worklist. It intentionally
 * does not create accounts/transactions or infer any Purchase link.
 */
export async function previewFinancialStatementImport(
  db: Database,
  input: FinancialStatementImportPreviewInput,
): Promise<FinancialStatementImportPreviewOut> {
  const [accounts, transactions, refs] = await Promise.all([
    unwrapDb(db)
      .select({
        id: financialAccount.id,
        shortcode: financialAccount.shortcode,
        name: financialAccount.name,
        identity: financialAccount.identity,
        sourceAliases: financialAccount.sourceAliases,
      })
      .from(financialAccount)
      .where(notDeleted(financialAccount)),
    unwrapDb(db)
      .select({
        id: financialTransaction.id,
        shortcode: financialTransaction.shortcode,
        accountId: financialTransaction.accountId,
        amount: financialTransaction.amount,
        postedDate: financialTransaction.postedDate,
        rawDescription: financialTransaction.rawDescription,
        sourceRefs: financialTransaction.sourceRefs,
      })
      .from(financialTransaction)
      .where(notDeleted(financialTransaction)),
    Promise.all(input.rows.map(sourceExternalId)),
  ]);

  const fingerprintCounts = new Map<string, number>();
  for (const ref of refs)
    fingerprintCounts.set(ref, (fingerprintCounts.get(ref) ?? 0) + 1);

  const parsedAccounts = accounts.map((account) => ({
    ...account,
    identity: financialAccountIdentity.parse(account.identity),
    sourceAliases: financialAccountSourceAliases.parse(account.sourceAliases),
  }));
  const parsedTransactions = transactions.map((transaction) => ({
    ...transaction,
    sourceRefs:
      financialTransactionSourceRefs.safeParse(transaction.sourceRefs).data ??
      [],
  }));

  const rows = input.rows.map((row, index) => {
    const externalId = refs[index]!;
    const sourceRef = { source: row.source, externalId };
    const normalizedAmount = -row.amount;
    const kind = row.kind ?? (normalizedAmount > 0 ? "purchase" : "refund");
    const proposed = {
      sourceRef,
      amount: normalizedAmount,
      kind,
      status: "posted" as const,
      transactionDate: null,
      postedDate: row.date,
      merchant: row.merchant,
      rawDescription: row.originalStatement || null,
      sourceCategory: row.category,
      notes: row.notes,
    };
    const descriptor = canonical(row.account);
    const aliasMatches = parsedAccounts.filter((account) =>
      account.sourceAliases.some(
        (alias) =>
          alias.source === row.source && canonical(alias.alias) === descriptor,
      ),
    );
    const last4 = last4FromDescriptor(row.account);
    const network = networkFromDescriptor(row.account);
    const identityMatches =
      aliasMatches.length === 0 && last4
        ? parsedAccounts.filter((account) => {
            const identity = account.identity;
            return (
              identity.kind === "credit_card" &&
              identity.last4 === last4 &&
              (network === null || identity.network === network)
            );
          })
        : [];
    const accountMatches =
      aliasMatches.length > 0 ? aliasMatches : identityMatches;
    const account = accountMatches.length === 1 ? accountMatches[0] : null;
    const alreadyRecorded = parsedTransactions.filter((transaction) =>
      transaction.sourceRefs.some(
        (ref) =>
          ref.source === sourceRef.source &&
          ref.externalId === sourceRef.externalId,
      ),
    );
    const possibleExisting = account
      ? parsedTransactions.filter(
          (transaction) =>
            transaction.accountId === account.id &&
            cents(Number(transaction.amount)) === cents(normalizedAmount) &&
            transaction.postedDate === row.date,
        )
      : [];
    const existingTransactionIds = (
      alreadyRecorded.length ? alreadyRecorded : possibleExisting
    ).map((transaction) =>
      unsafeFinancialTransactionShortcode(transaction.shortcode),
    );
    const status: FinancialStatementImportPreviewOut["rows"][number]["status"] =
      (fingerprintCounts.get(externalId) ?? 0) > 1
        ? "indistinguishable_duplicate"
        : alreadyRecorded.length > 0
          ? "already_recorded"
          : !account
            ? "unresolved_account"
            : possibleExisting.length > 0
              ? "possible_existing"
              : "ready_to_create";

    return {
      key: row.key,
      status,
      accountId: account
        ? unsafeFinancialAccountShortcode(account.shortcode)
        : null,
      accountName: account?.name ?? null,
      provisionalAccount: account ? null : provisionalAccountFor(row),
      proposed,
      existingTransactionIds,
    };
  });

  const count = (status: (typeof rows)[number]["status"]) =>
    rows.filter((row) => row.status === status).length;
  return {
    rows,
    summary: {
      rowsIn: rows.length,
      alreadyRecorded: count("already_recorded"),
      readyToCreate: count("ready_to_create"),
      possibleExisting: count("possible_existing"),
      unresolvedAccount: count("unresolved_account"),
      indistinguishableDuplicate: count("indistinguishable_duplicate"),
    },
  };
}
