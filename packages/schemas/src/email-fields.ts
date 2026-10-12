import { z } from "zod";

import { purchaseShortcode } from "./identifier-fields.js";

/** Retained content never grants import authorization. Historical policy stays unknown. */
export const emailExecutionPolicy = z.enum(["classification_only", "import"]);
export type EmailExecutionPolicy = z.infer<typeof emailExecutionPolicy>;

/** Search-cache expiry is explicit, independent of unrelated metadata updates. */
export const emailSearchOrigin = z.enum(["member_search", "discovery"]);
export type EmailSearchOrigin = z.infer<typeof emailSearchOrigin>;

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
 * session or Pi through `mail.resolve`, an import commit, or the suggestion
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

/**
 * Whether the Email's order was imported: `imported` once an import accepted
 * it as a Purchase source, `importing` while its import Run is active,
 * `failed` when that Run ended without accepting it, else `not_imported`.
 * Processing `status: completed` alone never means imported.
 */
export const emailImportOutcome = z.enum([
  "imported",
  "importing",
  "failed",
  "not_imported",
]);
export type EmailImportOutcome = z.infer<typeof emailImportOutcome>;

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
  })
  .strict();
export type EmailPurchaseLink = z.infer<typeof emailPurchaseLink>;
