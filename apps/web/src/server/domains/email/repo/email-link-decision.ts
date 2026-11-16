import type { emailPurchaseDecision } from "~/server/db/retained-tables";

type Decision = typeof emailPurchaseDecision.$inferSelect;

export const emailLinkSubject = (
  row: Pick<
    Decision,
    "emailId" | "originalId" | "eventId" | "purchaseId" | "evidenceChecksum"
  >,
) => ({
  kind: "email_link" as const,
  entity: "email" as const,
  recordId: row.emailId,
  originalId: row.originalId,
  eventId: row.eventId,
  purchaseId: row.purchaseId,
  checksum: row.evidenceChecksum,
});
