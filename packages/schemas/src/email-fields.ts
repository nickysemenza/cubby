import { z } from "zod";
import { entityIdSchema, purchaseShortcode } from "./identifier-fields.js";

/** Persisted import gaps distinguish missing facts from execution and member choices. */
export const mailImportGapCategory = z.enum([
  "missing_evidence",
  "invalid_extraction",
  "identity_ambiguity",
  "member_decision",
  "source_held",
  "transient_failure",
  "attempt_limit",
  "unknown",
]);

/** Retained content never grants import authorization. Historical policy stays unknown. */
export const emailExecutionPolicy = z.enum(["classification_only", "import"]);
export type EmailExecutionPolicy = z.infer<typeof emailExecutionPolicy>;

/** Search-cache expiry is explicit, independent of unrelated metadata updates. */
const emailSearchOrigin = z.enum(["member_search", "discovery"]);
export type EmailSearchOrigin = z.infer<typeof emailSearchOrigin>;

/**
 * Normalized order numbers an Email prints (trimmed, leading `#` removed,
 * upper-cased), never a tracking number (`mail-rule-evidence.ts`).
 */
const emailOrderKeys = z.array(z.string().min(1));
export type EmailOrderKeys = z.infer<typeof emailOrderKeys>;
/** Carrier tracking numbers an Email prints, upper-cased without whitespace. */
const emailTrackingKeys = z.array(
  z.object({
    carrier: z.enum(["UPS", "FedEx", "USPS", "OnTrac"]).nullable(),
    number: z.string().min(1),
  }),
);
export type EmailTrackingKeys = z.infer<typeof emailTrackingKeys>;
/**
 * How many Mail import Runs admitted this Email at one evidence revision:
 * `revision` is its checksum, followed by `:<evidenceRevision>` when a sender,
 * accepted-order or retained-source recheck admitted it. A new revision
 * restarts the count; the bound applies per revision (`mail-run-membership.ts`).
 */
export const emailImportAttempts = z.object({
  revision: z.string().min(1),
  count: z.number().int().nonnegative(),
});
export type EmailImportAttempts = z.infer<typeof emailImportAttempts>;

/**
 * How one Email relates to one Purchase, derived from stored evidence (ADR
 * 0011): an accepted import source or a reviewed link wins, then a live
 * suggestion, then a dismissal. Dismissing one order event never hides
 * another event of the same Email that still suggests the Purchase.
 */
export const emailPurchaseLinkState = z.enum([
  "linked",
  "suggested",
  "dismissed",
]);
export type EmailPurchaseLinkState = z.infer<typeof emailPurchaseLinkState>;

/** What one row of an Email's Purchase evidence is (server SQL vocabulary). */
export const emailLinkEvidenceKind = z.enum([
  "accepted",
  "linked",
  "dismissed",
  "suggested",
]);

/** The scope-relative state a list row shows; `none` is an Email with no pair in scope. */
export const emailLinkState = z.enum([
  "linked",
  "suggested",
  "dismissed",
  "none",
]);
export type EmailLinkState = z.infer<typeof emailLinkState>;

export const EMAIL_LINK_STATE_LABEL = {
  linked: "Linked",
  suggested: "Suggested",
  dismissed: "Dismissed",
  none: "No Purchase match",
} as const satisfies Record<EmailLinkState, string>;

/**
 * Who proposed a reviewed Email↔Purchase link: a member in the app, an agent
 * session or Pi through `purchase_import.mail_resolve`, an import commit, or the suggestion
 * heuristic a member then accepted or dismissed. A dismissal keeps the
 * proposer, so a dismissed agent link stays measurable as an agent error.
 * Decisions recorded before this column existed are null.
 */
export const emailLinkProposer = z.enum([
  "member",
  "agent",
  "import",
  "heuristic",
]);
export type EmailLinkProposer = z.infer<typeof emailLinkProposer>;
export type EmailPurchaseDecisionValue = "linked" | "dismissed";

/**
 * What a mail import did with the Email, from accepted source facts and the
 * newest retained outcome for its current checksum; the holding Run's status
 * only supplies `importing` (Run still running, no outcome yet) and `failed`
 * (Run ended without an outcome). Processing `status: completed` alone never
 * means imported.
 * - `imported`: an import accepted it as a Purchase source.
 * - `linked`: associated with existing Purchases or a financial transaction.
 * - `waiting`: unresolved, and Cubby re-runs it by itself (`automatic`).
 * - `needs_research`: unresolved; an agent researches it (`agent`).
 * - `needs_member`: unresolved; only the member can decide (`human`).
 * - `unrelated`: the import judged it not a purchase.
 * - `not_imported`: no Run holds it and no outcome or source exists.
 */
export const emailImportOutcome = z.enum([
  "imported",
  "linked",
  "waiting",
  "needs_research",
  "needs_member",
  "importing",
  "failed",
  "unrelated",
  "not_imported",
]);
export type EmailImportOutcome = z.infer<typeof emailImportOutcome>;

/** Who settles an unresolved import gap. Hands-off: automatic unless only an agent or the member can. */
export const mailImportGapExecutor = z.enum(["automatic", "agent", "human"]);
export type MailImportGapExecutor = z.infer<typeof mailImportGapExecutor>;
export const MAIL_IMPORT_GAP_EXECUTOR = {
  source_held: "automatic",
  transient_failure: "automatic",
  missing_evidence: "agent",
  invalid_extraction: "agent",
  attempt_limit: "agent",
  unknown: "agent",
  identity_ambiguity: "human",
  member_decision: "human",
} as const satisfies Record<
  z.infer<typeof mailImportGapCategory>,
  MailImportGapExecutor
>;
export const MAIL_IMPORT_GAP_OUTCOME = {
  automatic: "waiting",
  agent: "needs_research",
  human: "needs_member",
} as const satisfies Record<MailImportGapExecutor, EmailImportOutcome>;

/**
 * The source an unresolved Email waits on: another Email (its order
 * confirmation), or an order number at a Vendor that no Purchase holds yet.
 * Settling that source re-admits the waiting Email.
 */
export const mailImportWaitingOn = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("email"), emailId: entityIdSchema("email") }),
  z.object({
    kind: z.literal("order"),
    orderId: z.string().min(1),
    vendorId: entityIdSchema("vendor").nullable(),
  }),
]);
export type MailImportWaitingOn = z.infer<typeof mailImportWaitingOn>;

/** The Email's import outcome with the reason a member or agent reads beside it. */
export const emailImportOutcomeDetail = z.object({
  outcome: emailImportOutcome,
  category: mailImportGapCategory.nullable(),
  executor: mailImportGapExecutor.nullable(),
  reason: z.string().nullable(),
  waitingOn: mailImportWaitingOn.nullable(),
  /** The Run that produced the outcome, or that holds the Email now. */
  runId: entityIdSchema("run").nullable(),
});
export type EmailImportOutcomeDetail = z.infer<typeof emailImportOutcomeDetail>;

/** Per-outcome Email counts of one mail_import Run, derived from its target outcomes. */
export const mailRunOutcomeCounts = z.object({
  imported: z.number().int().nonnegative(),
  linked: z.number().int().nonnegative(),
  unrelated: z.number().int().nonnegative(),
  waiting: z.number().int().nonnegative(),
  needsResearch: z.number().int().nonnegative(),
  needsMember: z.number().int().nonnegative(),
});
export type MailRunOutcomeCounts = z.infer<typeof mailRunOutcomeCounts>;

/** One (Email, Purchase) pair as an Email list or detail read shows it. */
export const emailPurchaseLink = z
  .object({
    purchaseId: purchaseShortcode,
    state: emailPurchaseLinkState,
    /** An import accepted this Email as the Purchase's source; a review cannot undo it. */
    accepted: z.boolean(),
    /** The original changed after this pair was reviewed or accepted. */
    changedSinceReview: z.boolean(),
    /** Purchases whose link on the same order events a Link here would replace. */
    replacesPurchaseIds: z.array(purchaseShortcode),
    proposedBy: emailLinkProposer.nullable(),
    /** "PUR-… (Linked)": the pair's own state for the native generic list cell; agents read `state`. */
    label: z.string(),
  })
  .strict();
export type EmailPurchaseLink = z.infer<typeof emailPurchaseLink>;

export const emailPurchaseLinkLabel = (
  purchaseId: string,
  state: EmailPurchaseLinkState,
) => `${purchaseId} (${EMAIL_LINK_STATE_LABEL[state]})`;
