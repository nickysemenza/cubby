import type { EmailId } from "@cubby/schemas/identifiers";
import { eq } from "drizzle-orm";

import type { Database } from "~/server/db";
import { getDb } from "~/server/db/helpers";
import { email } from "~/server/db/schema";

export async function readReclassifiedEmail(db: Database, emailId: EmailId) {
  const [after] = await getDb(db)
    .select()
    .from(email)
    .where(eq(email.id, emailId));
  return after;
}
