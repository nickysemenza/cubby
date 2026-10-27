import type { DerivedStoredInput } from "./definition";

const purchaseExpenses = { table: "Expense", from: "purchaseId", to: "id" };
const transactionPurchases = {
  table: "FinancialTransactionAllocation",
  from: "transactionId",
  to: "purchaseId",
};

/** Raw inputs of the shared beneficiary seed policy, including purchaser evidence. */
export const EXPENSE_BENEFICIARY_INPUTS: DerivedStoredInput[] = [
  {
    table: "Expense",
    match: { id: "id" },
    columns: ["cost", "future", "purchaseId", "deletedAt", "name"],
  },
  { table: "ExpenseAttribution", match: { expenseId: "id" } },
  { table: "Purchase", match: { id: "purchaseId" } },
  {
    table: "FinancialTransactionAllocation",
    match: { purchaseId: "purchaseId" },
  },
  {
    table: "FinancialTransaction",
    match: { id: "id" },
    path: [transactionPurchases, purchaseExpenses],
  },
  {
    table: "FinancialAccount",
    match: { id: "id" },
    path: [
      { table: "FinancialTransaction", from: "accountId", to: "id" },
      transactionPurchases,
      purchaseExpenses,
    ],
  },
  {
    table: "VendorAccount",
    match: { id: "id" },
    path: [
      { table: "Purchase", from: "vendorAccountId", to: "id" },
      purchaseExpenses,
    ],
  },
  {
    table: "ImportSourceOrder",
    match: { purchaseId: "purchaseId" },
    columns: ["sourceClaimId", "purchaseId"],
  },
  {
    table: "AssessmentState",
    match: { data: "purchaseId" },
    json: { key: "purchaseId" },
    where: { family: "email_link" },
    columns: ["data", "active", "family"],
  },
  // Household creation and accepted-mail identity changes can introduce a new
  // fallback without an existing cached relationship. Expand conservatively
  // outside member saves; ordinary relationship edits use the paths above.
  {
    table: "LedgerParty",
    match: { id: "id" },
    targetWhere: { deletedAt: null },
    columns: ["kind", "name", "shortcode", "deletedAt"],
  },
  {
    table: "ImportSourceClaim",
    match: { id: "id" },
    targetWhere: { deletedAt: null },
    columns: ["canonicalClaimId", "ledgerPartyId", "kind", "externalKey"],
  },
  {
    table: "OrderMail",
    match: { id: "id" },
    targetWhere: { deletedAt: null },
    columns: ["ledgerPartyId"],
  },
  {
    table: "OrderMailAttachment",
    match: { id: "id" },
    targetWhere: { deletedAt: null },
    columns: ["orderMailId", "providerAttachmentId"],
  },
  {
    table: "OrderMailEvent",
    match: { id: "id" },
    targetWhere: { deletedAt: null },
    columns: ["orderMailId", "supersededAt"],
  },
  {
    table: "Email",
    match: { id: "id" },
    columns: [
      "ledgerPartyId",
      "provider",
      "mailboxId",
      "messageId",
      "orderMailId",
      "deletedAt",
    ],
    targetWhere: { deletedAt: null },
  },
];
