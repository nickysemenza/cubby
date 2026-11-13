import { z } from "zod";

import {
  expense,
  expenseAttribution,
  financialTransactionAllocation,
  purchase,
  vendor,
} from "~/server/db/schema";
import { writes, type Pure } from "~/server/kernel/api";

export const purchaseRecords = writes(
  purchase,
  [
    "vendorId",
    "vendorAccountId",
    "purchaserOverrideId",
    "defaultProjectId",
    "defaultTrade",
    "spendingCategoryId",
    "spendingCategoryOrigin",
    "itemizationExpectation",
    "orderId",
    "displayLabel",
    "date",
    "statedTotal",
    "notes",
  ],
  { entity: "purchase", createOnly: ["runId"] },
);

export const expenseRecords = writes(
  expense,
  [
    "name",
    "cost",
    "date",
    "lineKind",
    "lineBasis",
    "costType",
    "trade",
    "url",
    "notes",
    "future",
    "projectId",
    "productId",
    "productQuantity",
    "purchaseId",
    "spendingCategoryId",
    "economicRole",
    "bookingTransactionCode",
  ],
  { entity: "expense" },
);

export const allocationRecords = writes(financialTransactionAllocation, [
  "transactionId",
  "purchaseId",
  "amountMinor",
  "confirmsMerchant",
]);
export const attributionRecords = writes(expenseAttribution, [
  "expenseId",
  "role",
  "ledgerPartyId",
  "weight",
]);
const vendorCreation = z.object({
  name: z.string(),
  aliases: z.array(z.string()),
});

export const bookingVendors = writes(vendor, [], {
  entity: "vendor",
  createOnly: ["name", "aliases"],
  coalesceCreation(values) {
    const proposed = values.map((value) => vendorCreation.parse(value));
    const name = proposed[0]!.name;
    return {
      name,
      aliases: [
        ...new Set(
          proposed.flatMap((value) => [
            ...value.aliases,
            ...(value.name === name ? [] : [value.name]),
          ]),
        ),
      ].sort(),
    };
  },
});

export const purchaseEventTables = {
  purchase: { table: purchase, target: purchaseRecords },
  expense: { table: expense, target: expenseRecords },
  FinancialTransactionAllocation: {
    table: financialTransactionAllocation,
    target: allocationRecords,
  },
  ExpenseAttribution: { table: expenseAttribution, target: attributionRecords },
} as const;
export type PurchaseEventTable = keyof typeof purchaseEventTables;

/** Exact minor units enter retained JSON as decimal strings. */
export function restorePurchaseValues(values: Parameters<Pure["record"]>[2]) {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [
      key,
      ["cost", "statedTotal", "amountMinor"].includes(key) &&
      typeof value === "string"
        ? BigInt(value)
        : value,
    ]),
  );
}
