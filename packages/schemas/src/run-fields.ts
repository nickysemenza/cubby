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
  // Scheduled work nobody started: the daily cron and app-open catch-up. A
  // completed one that found nothing is `routine` and hidden by default.
  "scheduled",
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
/** What `run.control` can do to a Run; the report actions and the operation share it. */
export const runControlAction = z.enum([
  "pause",
  "resume",
  "cancel",
  "approve",
  "reject",
  "retry",
  "restart",
  "escalate_sol",
  "retry_dispatch",
  "abort",
  "upload_evidence",
  "no_evidence_available",
]);
export type RunControlAction = z.infer<typeof runControlAction>;
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
  "mail_discovery",
]);
export type RunPurpose = z.infer<typeof runPurpose>;

/**
 * `Run.input` / `Run.progress` for a `mail_search` run: the Gmail search a
 * member asked for and where its page-by-page walk stands. A Cloudflare
 * Workflow instance (`<runShortcode>-<attempt>`) executes it; the Run row is
 * the durable record, so a retry starts a fresh instance that resumes from
 * `pagesScanned`/`nextPageToken`. `queued` and `running` predate the Workflow
 * and still parse on historical rows.
 */
export const mailSearchRunInput = z.object({
  after: z.string(),
  searchTerms: z.array(z.string()),
});
export type MailSearchRunInput = z.infer<typeof mailSearchRunInput>;
export const mailSearchPhase = z.enum([
  "queued",
  "running",
  "waiting",
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
  /** The Workflow attempt that owns the Run; absent on pre-Workflow rows. */
  attempt: z.number().int().nonnegative().optional(),
  /** When a rate-limited page is retried. */
  retryAt: z.iso.datetime().nullable().optional(),
});
export type MailSearchRunProgress = z.infer<typeof mailSearchRunProgress>;

/** `Run.input` for a `mail_discovery` run: the mailbox and bootstrap senders. */
export const mailDiscoveryRunInput = z.object({
  mailboxId: z.string().min(1),
  /** Searched on a first sync or after Gmail expires the history cursor. */
  knownSenders: z.array(z.string()),
});
export type MailDiscoveryRunInput = z.infer<typeof mailDiscoveryRunInput>;
/** How a `mail_discovery` run listed its mailbox changes. */
export const mailDiscoveryMode = z.enum([
  "bootstrap",
  "full_resync",
  "incremental",
]);
/** One Gmail history change a `mail_discovery` pass persists after its batches. */
export const mailDiscoveryEvent = z.object({
  sourceKey: z.string(),
  mailboxId: z.string(),
  historyId: z.string(),
  messageId: z.string(),
  threadId: z.string().nullable(),
  kind: z.enum([
    "message_added",
    "message_deleted",
    "labels_added",
    "labels_removed",
  ]),
  labelIds: z.array(z.string()),
});
/**
 * `Run.progress` for a `mail_discovery` run: one scheduled pass over a
 * member's Gmail mailbox, executed by a Workflow instance
 * (`<runShortcode>-<attempt>`). The `list` step freezes the work here — the
 * batches and history events — so a replayed or retried attempt processes the
 * same messages, and the cursor moves only after every batch from
 * `startHistoryId` to `targetHistoryId`.
 */
export const mailDiscoveryRunProgress = z.object({
  attempt: z.number().int().nonnegative(),
  phase: z.enum(["listing", "fetching", "completed", "failed"]),
  /** The mailbox cursor this pass started from; null on a first sync. */
  startHistoryId: z.string().nullable(),
  /** Frozen by `list`: the cursor the pass advances to when it finishes. */
  targetHistoryId: z.string().nullable().optional(),
  mode: mailDiscoveryMode.optional(),
  /** Frozen by `list`: message ids, chunked once so replay cannot regroup them. */
  batches: z.array(z.array(z.string())).optional(),
  /** Frozen by `list`: history changes, saved once every batch is in. */
  pendingEvents: z.array(mailDiscoveryEvent).optional(),
  batchesDone: z.number().int().nonnegative().default(0),
  /** Messages saved; deleted between listing and fetching; events dropped. */
  saved: z.number().int().nonnegative().default(0),
  deleted: z.number().int().nonnegative().default(0),
  events: z.number().int().nonnegative().default(0),
  droppedEvents: z.number().int().nonnegative().default(0),
});
export type MailDiscoveryRunProgress = z.infer<typeof mailDiscoveryRunProgress>;
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
/**
 * `Run.input` for a browser run over charge hunts a member selected: exactly
 * these `ImportHunt` ids are its work. Their outcomes live on the hunts
 * themselves (see `chargeHuntOutcome`), so no migration or per-run table is
 * needed; a hunt belongs to at most one unfinished run.
 */
export const chargeHuntRunInput = z.object({
  kind: z.literal("charge_hunts"),
  huntIds: z.array(z.uuid()).min(1).max(50),
});
/**
 * What a restart copies from `Run.input`, by public values only: a mail
 * import's order ids, a backfill's range, or how many charges a charge run
 * carries. Mail-event and hunt ids are private and never cross it.
 */
export const runRestartOrderMailInput = z
  .object({
    kind: z.literal("order_mail_import"),
    orderIds: z.array(z.string()),
  })
  .meta({ id: "RunRestartOrderMailInput" });
export const runRestartOrderBackfillInput = z
  .object({
    kind: z.literal("order_backfill"),
    from: z.iso.date(),
    to: z.iso.date(),
  })
  .meta({ id: "RunRestartOrderBackfillInput" });
export const runRestartChargeHuntsInput = z
  .object({
    kind: z.literal("charge_hunts"),
    chargeCount: z.number().int().positive(),
  })
  .meta({ id: "RunRestartChargeHuntsInput" });
export const runRestartInput = z.discriminatedUnion("kind", [
  runRestartOrderMailInput,
  runRestartOrderBackfillInput,
  runRestartChargeHuntsInput,
]);
export type RunRestartInput = z.infer<typeof runRestartInput>;
/** `ImportHunt.state` values a selected-charges run writes (plain text column). */
export const CHARGE_HUNT_STATE = {
  queued: "browser_queued",
  resolved: "resolved",
  deferred: "deferred_for_review",
  notFound: "expected_order_not_found",
} as const;
/** A selected hunt's outcome on its run; `pending` blocks finishing. */
export const chargeHuntOutcome = z.enum([
  "pending",
  "resolved",
  "deferred",
  "not_found",
]);
export const chargeHuntOutcomeOf = (
  state: string,
): z.infer<typeof chargeHuntOutcome> => {
  switch (state) {
    case CHARGE_HUNT_STATE.queued:
      return "pending";
    case CHARGE_HUNT_STATE.resolved:
      return "resolved";
    case CHARGE_HUNT_STATE.notFound:
      return "not_found";
    default:
      return "deferred";
  }
};
export type RunInput =
  | MailSearchRunInput
  | MailDiscoveryRunInput
  | z.infer<typeof orderMailImportRunInput>
  | OrderBackfillRunInput
  | z.infer<typeof chargeHuntRunInput>;
export type RunProgress = MailSearchRunProgress | MailDiscoveryRunProgress;

/** The label of each run purpose; `runWorkLabel` names one run's actual work. */
export const RUN_PURPOSE_LABEL = {
  account_sync: "Account sync",
  purchase_validation: "Purchase validation",
  product_enrichment: "Product enrichment",
  photo_inventory: "Photo inventory",
  ai_suggest: "AI suggestions",
  background: "Background",
  file_import: "File import",
  mail_search: "Mail search",
  mail_discovery: "Mail discovery",
} as const satisfies Record<z.infer<typeof runPurpose>, string>;

/**
 * What one run actually does, for every surface that names it (lists,
 * detail titles, MCP, the Mac, notifications). An `account_sync` run is
 * several kinds of work told apart by its input: mail imports, selected
 * charge searches and history backfills share the purpose with a plain
 * order-history sync, and a vendor-less run with no input only holds a
 * finding about mail from an unknown sender.
 */
export function runWorkLabel(run: {
  purpose: string;
  input: unknown;
  vendorId?: string | null;
}): string {
  const purpose = runPurpose.safeParse(run.purpose);
  if (!purpose.success) return run.purpose;
  if (purpose.data !== "account_sync") return RUN_PURPOSE_LABEL[purpose.data];
  const kind = z.object({ kind: z.string() }).safeParse(run.input);
  switch (kind.success ? kind.data.kind : null) {
    case "order_mail_import":
      return "Order mail import";
    case "charge_hunts":
      return "Charge search";
    case "order_backfill":
      return "Order history backfill";
    default:
      return run.vendorId ? "Order history sync" : "Unknown sender review";
  }
}
