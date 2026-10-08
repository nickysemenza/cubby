import {
  runEntityId,
  userId,
  type LedgerPartyId,
} from "@cubby/schemas/identifiers";
import {
  coordinatorModelFor,
  importRunAgentIdentity,
} from "@cubby/schemas/import-run-agent";
import { researchObjectivesRunInput } from "@cubby/schemas/run-fields";
import { and, eq } from "drizzle-orm";

import type { Database } from "~/server/db";
import { ledgerParty, user } from "~/server/db/schema";
import { notDeleted, withTransaction } from "~/server/repo/database-helpers";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

import {
  admitResearchObjectiveTargets,
  OBJECTIVE_RESEARCH_INSTRUCTION_REVISION,
} from "./research-objective";
import { lockVendorResearchScope } from "./vendor-research-scope";

/** Known-Vendor discovery uses the same researcher without requiring an online account. */
export async function admitVendorResearch(
  db: Database,
  memberId: LedgerPartyId,
  vendorRef: string,
) {
  const vendorId = await resolveOrThrow(db, "vendor", vendorRef);
  return withTransaction(db, async (tx) => {
    const [owner] = await tx
      .select({ party: ledgerParty, actor: user })
      .from(ledgerParty)
      .innerJoin(user, eq(user.id, ledgerParty.userId))
      .where(
        and(
          eq(ledgerParty.id, memberId),
          eq(ledgerParty.kind, "member"),
          notDeleted(ledgerParty),
        ),
      )
      .for("share", { of: ledgerParty });
    if (!owner) throw new Error("Vendor research requires the owning member.");
    const active = await lockVendorResearchScope(
      tx,
      { ledgerPartyId: memberId, actorUserId: userId.parse(owner.actor.id) },
      vendorId,
    );
    if (active) return { created: false, run: active };
    const objectives = researchObjectivesRunInput.parse({
      kind: "research_objectives",
      instructionRevision: OBJECTIVE_RESEARCH_INSTRUCTION_REVISION,
      objectives: [{ kind: "vendor_purchases", vendorId, range: null }],
    });
    const id = runEntityId.parse(crypto.randomUUID());
    const admitted = await insertWithShortcode(tx, "run", {
      id,
      ledgerPartyId: memberId,
      actorUserId: userId.parse(owner.actor.id),
      actorName: owner.actor.name ?? owner.party.name,
      actorEmail: owner.actor.email,
      actorLedgerPartyShortcode: owner.party.shortcode,
      actorLedgerPartyName: owner.party.name,
      actorLedgerPartyKind: "member",
      vendorId,
      vendorAccountId: null,
      purpose: "account_sync",
      trigger: "manual",
      input: objectives,
      coordinatorModel: coordinatorModelFor("account_sync"),
      dispatchEventId: crypto.randomUUID(),
      agentSessionId: importRunAgentIdentity(id, "account_sync"),
    });
    await admitResearchObjectiveTargets(tx, { runId: id, objectives });
    return { created: true, run: admitted };
  });
}
