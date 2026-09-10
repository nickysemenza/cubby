import { z } from "zod";

export const purchaseReconciliation = z.enum([
  "unknown",
  "match",
  "refund_adjusted",
  "mismatch",
]);
export const purchaseExpenseStatus = z.enum(["empty", "unpriced", "priced"]);
export const purchaseDocumentKindValues = [
  "order_confirmation",
  "sales_order",
  "invoice",
  "receipt",
  "payment_receipt",
  "credit_memo",
  "return_authorization",
  "quote",
  "estimate",
  "contract",
  "statement",
  "specification",
  "other",
] as const;
export const purchaseDocumentKind = z.enum(purchaseDocumentKindValues);
export const purchaseImages = z.array(
  z.object({
    id: z.string(),
    url: z.url(),
    filename: z.string(),
    contentType: z.string(),
    key: z.string(),
    documentKind: purchaseDocumentKind,
  }),
);
