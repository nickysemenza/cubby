import type { ActorContext } from "@cubby/schemas/context";
import { executionAuthorizationInput } from "@cubby/schemas/execution-authorization";

import type { Database } from "~/server/db";
import { account } from "~/server/db/auth.schema";
import { getDb } from "~/server/repo/database-helpers";
import { ensureRun } from "~/server/runs/ensure-run";
import { issueExecutionAuthorization } from "~/server/runs/execution-authorization";

/** Ordinary relevance regressions exercise a real persisted authorized import Run. */
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
  const executionAuthorization = await issueExecutionAuthorization(
    db,
    actor,
    executionAuthorizationInput.parse({
      kind: "execution_authorization",
      version: 1,
      owner: { userId: actor.userId, ledgerPartyId: input.ledgerPartyId },
      scope: {
        kind: "backfill",
        mailboxId: input.mailboxId,
        discovery: "all_history",
      },
      meteredBudget: { period: "lifetime", limitMicroUSD: 1_000_000 },
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }),
  );
  return ensureRun(db, actor, {
    purpose: "mail_import",
    trigger: "manual",
    status: "running",
    input: {
      mailboxId: input.mailboxId,
      scopedQueries: [],
      executionPolicy: "import",
      executionAuthorization,
    },
  });
}
