import type { ActorContext } from "@cubby/schemas/context";

import type { Database } from "~/server/db";
import { account } from "~/server/db/auth.schema";
import { getDb } from "~/server/db/helpers";
import { ensureRun } from "~/server/domains/run/repo/ensure-run";

/** Ordinary relevance regressions exercise a real persisted import Run. */
export async function syntheticMailImportRun(
  db: Database,
  actor: ActorContext,
  input: { ledgerPartyId: string; mailboxId: string },
) {
  await getDb(db).insert(account).values({
    id: crypto.randomUUID(),
    accountId: input.mailboxId,
    providerId: "google",
    userId: actor.userId,
    updatedAt: new Date(),
  });
  return ensureRun(db, actor, {
    purpose: "mail_import",
    trigger: "manual",
    status: "running",
    input: {
      mailboxId: input.mailboxId,
      scopedQueries: [],
      executionPolicy: "import",
    },
  });
}
