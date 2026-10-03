import { z } from "zod";

/**
 * Cycle-safe enums for the `run` declaration. `purchase-import.ts`
 * re-exports them so existing consumers keep their import paths.
 */
export const runTrigger = z.enum([
  "foreground",
  "discovery",
  "manual",
  "backfill",
  // A short-lived run that only groups AI work: created already `completed`,
  // and never blocks ledger-party delete/merge.
  "ephemeral",
]);
export const runStatus = z.enum([
  "running",
  "paused_auth",
  "paused_offline",
  "paused_approval",
  "needs_review",
  "completed",
  "failed",
  "dispatch_failed",
]);
export const runPurpose = z.enum([
  "account_sync",
  "purchase_validation",
  "product_enrichment",
  "photo_inventory",
  // Every AI call belongs to a run; these purposes group work that is not an
  // import. Their lifetime is set by `trigger` (`ephemeral` or not).
  "ai_suggest",
  "background",
  "file_import",
  "mail_search",
]);
export type RunPurpose = z.infer<typeof runPurpose>;

/**
 * `Run.input` / `Run.progress` for a `mail_search` run: the Gmail search a
 * member asked for and where its page-by-page walk stands. `phase` is the
 * claim state a worker CAS-es on (`queued` between pages, `running` while one
 * is scanned); the Run's own `status` stays `running` until the last page.
 */
export const mailSearchRunInput = z.object({
  after: z.string(),
  searchTerms: z.array(z.string()),
});
export type MailSearchRunInput = z.infer<typeof mailSearchRunInput>;
export const mailSearchPhase = z.enum([
  "queued",
  "running",
  "completed",
  "failed",
]);
export const mailSearchRunProgress = z.object({
  phase: mailSearchPhase,
  /** The cursor the walk started from; null when it began at the newest page. */
  pageToken: z.string().nullable(),
  nextPageToken: z.string().nullable(),
  pagesScanned: z.number().int().nonnegative(),
  searched: z.number().int().nonnegative(),
  reviewable: z.number().int().nonnegative(),
  /** A transient cause kept while a rate-limited page waits to be retried. */
  error: z.string().nullable().optional(),
});
export type MailSearchRunProgress = z.infer<typeof mailSearchRunProgress>;
/** A listed or selected order's terminal outcome on one Run. */
export const runOrderCandidateState = z.enum([
  "pending",
  "covered",
  "imported",
  "skipped",
]);
/** One saved placement confirmation a mail import run is assigned. */
export const orderMailImportOrder = z.object({
  eventId: z.uuid(),
  evidenceChecksum: z.string().min(1),
  orderId: z.string().min(1),
});
export type OrderMailImportOrder = z.infer<typeof orderMailImportOrder>;
/**
 * `Run.input` for mail-only imports. The single form (one confirmation) is
 * what every run started before multi-select carries and stays readable; the
 * `orders` form is one run over several selected confirmations of one member
 * and Vendor, each tracked as a `RunOrderCandidate`.
 */
export const orderMailImportRunInput = z.union([
  orderMailImportOrder.extend({ kind: z.literal("order_mail_import") }),
  z.object({
    kind: z.literal("order_mail_import"),
    orders: z.array(orderMailImportOrder).min(1).max(50),
  }),
]);
/** Every confirmation a mail import run was assigned, in claim order. */
export const orderMailImportRunOrders = (
  input: z.infer<typeof orderMailImportRunInput>,
): OrderMailImportOrder[] =>
  "orders" in input
    ? input.orders
    : [
        {
          eventId: input.eventId,
          evidenceChecksum: input.evidenceChecksum,
          orderId: input.orderId,
        },
      ];
/**
 * `Run.input` for an explicit historical backfill: list and import only
 * orders placed within the inclusive range, newest first. It never moves the
 * account's incremental cursor.
 */
export const orderBackfillRunInput = z
  .object({
    kind: z.literal("order_backfill"),
    from: z.iso.date(),
    to: z.iso.date(),
  })
  .refine((range) => range.from <= range.to, {
    message: "Backfill range must start on or before its end",
    path: ["from"],
  });
export type OrderBackfillRunInput = z.infer<typeof orderBackfillRunInput>;
export type RunInput =
  | MailSearchRunInput
  | z.infer<typeof orderMailImportRunInput>
  | OrderBackfillRunInput;
export type RunProgress = MailSearchRunProgress;
