import type { ActorContext } from "@cubby/schemas/context";
import type { SourceTransactionRecordId } from "@cubby/schemas/identifiers";
import type { SourceIdentityResolution } from "@cubby/schemas/source-occurrence-fields";

import type { DrizzleTransaction } from "~/server/db";

import { planSourceIdentity } from "./source-identity-plan";
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
  const plan = planSourceIdentity(input, actor, loaded, new Date());
  const aliases = await loadSourceIdentityAliases(tx, loaded);
  return applySourceIdentity(tx, input, actor, loaded, plan, aliases);
}
