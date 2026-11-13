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
  return applySourceIdentity(tx, actor, plan);
}
