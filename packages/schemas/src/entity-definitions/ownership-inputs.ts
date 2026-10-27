import type { DerivedStoredInput } from "./definition";

const expenses = { table: "Expense", from: "purchaseId", to: "productId" };
const linkedProducts = {
  table: "EntityLink",
  from: "fromEntityId",
  to: "toEntityId",
  where: { kind: "purchaseProduct" },
};
const purchasePaths = [[expenses], [linkedProducts]];
const expensePaths = [
  [{ table: "Expense", from: "id", to: "productId" }],
  [{ table: "Expense", from: "id", to: "purchaseId" }, linkedProducts],
];
/** The canonical acquisition ladder's complete source read-set, rooted at Product. */
export const PRODUCT_OWNERSHIP_INPUTS: DerivedStoredInput[] = [
  { table: "Product", match: { id: "id" }, columns: ["deletedAt"] },
  {
    table: "InventoryEntry",
    match: { productId: "id" },
    columns: ["productId", "ownershipMode", "ownerLedgerPartyId", "deletedAt"],
  },
  { table: "Expense", match: { productId: "id" } },
  ...purchasePaths.flatMap((path): DerivedStoredInput[] => [
    { table: "Purchase", match: { id: "id" }, path },
    { table: "Expense", match: { purchaseId: "id" }, path },
    {
      table: "EntityLink",
      match: { fromEntityId: "id" },
      where: { kind: "purchaseProduct" },
      path,
    },
    {
      table: "VendorAccount",
      match: { id: "id" },
      path: [{ table: "Purchase", from: "vendorAccountId", to: "id" }, ...path],
    },
    {
      table: "FinancialTransactionAllocation",
      match: { purchaseId: "id" },
      path,
    },
    {
      table: "FinancialTransaction",
      match: { id: "id" },
      path: [
        {
          table: "FinancialTransactionAllocation",
          from: "transactionId",
          to: "purchaseId",
        },
        ...path,
      ],
    },
    {
      table: "FinancialAccount",
      match: { id: "id" },
      path: [
        { table: "FinancialTransaction", from: "accountId", to: "id" },
        {
          table: "FinancialTransactionAllocation",
          from: "transactionId",
          to: "purchaseId",
        },
        ...path,
      ],
    },
  ]),
  {
    table: "EntityLink",
    match: { toEntityId: "id" },
    where: { kind: "purchaseProduct" },
  },
  ...expensePaths.map<DerivedStoredInput>((path) => ({
    table: "ExpenseAttribution",
    match: { expenseId: "id" },
    path,
  })),
  ...[
    [{ table: "InventoryEntry", from: "ownerLedgerPartyId", to: "productId" }],
    ...expensePaths.map((path) => [
      { table: "ExpenseAttribution", from: "ledgerPartyId", to: "expenseId" },
      ...path,
    ]),
    ...purchasePaths.flatMap((path) => [
      [
        { table: "VendorAccount", from: "ledgerPartyId", to: "id" },
        { table: "Purchase", from: "vendorAccountId", to: "id" },
        ...path,
      ],
      [
        { table: "FinancialAccount", from: "ledgerPartyId", to: "id" },
        { table: "FinancialTransaction", from: "accountId", to: "id" },
        {
          table: "FinancialTransactionAllocation",
          from: "transactionId",
          to: "purchaseId",
        },
        ...path,
      ],
    ]),
  ].map<DerivedStoredInput>((path) => ({
    table: "LedgerParty",
    match: { id: "id" },
    path,
  })),
];
export const INVENTORY_OWNERSHIP_INPUTS: DerivedStoredInput[] = [
  {
    table: "InventoryEntry",
    match: { id: "id" },
    columns: ["productId", "ownershipMode", "ownerLedgerPartyId", "deletedAt"],
  },
  ...PRODUCT_OWNERSHIP_INPUTS.map((input) => ({
    ...input,
    path: [
      ...(input.path ?? []),
      { table: "InventoryEntry", from: "productId", to: "id" },
    ],
  })),
];
