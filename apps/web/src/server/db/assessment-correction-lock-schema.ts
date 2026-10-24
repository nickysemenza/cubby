import { pgTable, text } from "drizzle-orm/pg-core";

/** Durable serialization keys; authority remains in applied correction receipts. */
export const assessmentCorrectionLock = pgTable("AssessmentCorrectionLock", {
  key: text("key").primaryKey(),
});
