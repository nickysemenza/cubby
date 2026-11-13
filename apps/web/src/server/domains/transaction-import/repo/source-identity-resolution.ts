import type { ActorContext } from "@cubby/schemas/context";
import type { SourceTransactionRecordId } from "@cubby/schemas/identifiers";
import type { SourceIdentityResolution } from "@cubby/schemas/source-occurrence-fields";

import type { DrizzleTransaction } from "~/server/db";
import { planSourceIdentity } from "~/server/domains/transaction-import/policy/source-identity-plan";

import {
  lockAndLoadSourceIdentity,
  loadSourceIdentityAliases,
  applySourceIdentity,
} from "./source-identity-stages";

export async function resolveSourceIdentity(
  tx: DrizzleTransaction,
  observationId: SourceTransactionRecordId,
  input: SourceIdentityResolution,
  actor: ActorContext,
): Promise<{ source: string; chargeKey: string }> {
  const loaded = await lockAndLoadSourceIdentity(tx, observationId, input);
  const aliases = await loadSourceIdentityAliases(tx, loaded);
  const plan = planSourceIdentity(input, actor, loaded, aliases, new Date());
  const result = await applySourceIdentity(tx, actor, plan);
  if (input.decision === "accept_existing") {
    const { decideStatement } =
      await import("~/server/domains/transaction-import/repo/statement-decisions");
    const { databaseForTransaction } = await import("~/server/db/helpers");
    const { sourceTransactionRecord } = await import("~/server/db/schema");
    const { eq } = await import("drizzle-orm");
    const { repositoryQueries } =
      await import("~/server/db/repository-access.boundary");
    const db = databaseForTransaction(tx);
    const [observation] = await repositoryQueries(db)
      .select()
      .from(sourceTransactionRecord)
      .where(eq(sourceTransactionRecord.id, observationId));
    await decideStatement(db, actor, {
      observationId: observation!.shortcode,
      application: {
        action: "attach",
        transactionId: input.transactionId,
        fields: [],
        rejectedCandidateIds: [],
      },
    });
  }
  return result;
}
