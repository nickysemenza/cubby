import { z } from "zod";
import { imageShortcode } from "./identifier-fields";

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
    id: imageShortcode,
    url: z.url(),
    filename: z.string(),
    contentType: z.string(),
    /**
     * The R2 object key. Nothing RENDERS it — it's here because it's part of an
     * image's identity, and because `PendingDocument` (the upload widget's row
     * type) requires it, which is what lets the document list offer a detach
     * affordance without a per-document round-trip back to `image.getByID`.
     */
    key: z.string(),
    documentKind: purchaseDocumentKind,
  }),
);
