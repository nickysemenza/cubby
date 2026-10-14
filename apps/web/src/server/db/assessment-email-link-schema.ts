import type { EmailLinkProposer } from "@cubby/schemas/email-fields";
import type { PurchaseId } from "@cubby/schemas/identifiers";
import { pgView, uuid, text, timestamp } from "drizzle-orm/pg-core";

/** Read-only typed view of the shared current projection; there is no Email review ledger. */
export const assessmentEmailLink = pgView("AssessmentEmailLink", {
  id: uuid("id").notNull(),
  eventId: uuid("eventId").notNull(),
  purchaseId: uuid("purchaseId").notNull().$type<PurchaseId>(),
  decision: text("decision").notNull().$type<"linked" | "dismissed">(),
  evidenceChecksum: text("evidenceChecksum").notNull(),
  decidedByUserId: text("decidedByUserId").notNull(),
  proposedBy: text("proposedBy").$type<EmailLinkProposer>(),
  createdAt: timestamp("createdAt").notNull(),
  updatedAt: timestamp("updatedAt").notNull(),
}).existing();
