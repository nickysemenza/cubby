import { z } from "zod";
import {
  emailLinkEvidenceKind,
  emailLinkProposer,
  emailLinkState,
  emailPurchaseLink,
} from "./email-fields";
import { purchaseShortcode } from "./identifier-fields";

/** Canonical event/Purchase facts; account-owner and requested-scope gates are separate. */
export const emailPurchaseFact = z.object({
  purchaseId: z.uuid(),
  purchaseShortcode,
  vendorId: z.uuid(),
  eventId: z.uuid().nullable(),
  kind: emailLinkEvidenceKind,
  changed: z.boolean(),
  proposedBy: emailLinkProposer.nullable(),
});
const emailRelationshipEvidence = emailPurchaseFact
  .pick({ kind: true, changed: true, proposedBy: true })
  .extend({ purchaseId: purchaseShortcode });
export const emailRelationshipResult = z.object({
  linked: z.boolean(),
  facts: z.array(emailPurchaseFact),
  evidence: z.array(emailRelationshipEvidence),
  linkState: emailLinkState,
  purchaseLinks: z.array(emailPurchaseLink),
});
