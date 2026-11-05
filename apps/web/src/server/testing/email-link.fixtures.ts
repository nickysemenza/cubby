import { eq } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";

import { emailPurchaseDecision } from "~/server/db/schema";

/** An event's current decisions, the rows every reader treats as authority. */
export const activeEmailPurchaseDecision = new QueryBuilder()
  .select()
  .from(emailPurchaseDecision)
  .where(eq(emailPurchaseDecision.active, true))
  .as("ActiveEmailPurchaseDecision");
