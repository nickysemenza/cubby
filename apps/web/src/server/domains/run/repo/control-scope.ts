/** Run lifecycle authority does not require a purchase-agent execution session. */
import type { ActorContext } from "@cubby/schemas/context";
import { runShortcode } from "@cubby/schemas/purchase-import";
import { and, eq } from "drizzle-orm";

import type { Database } from "~/server/db";
import { getDb, notDeleted } from "~/server/db/helpers";
import { ledgerParty, run, user } from "~/server/db/schema";

export async function loadRunController(db: Database, actor: ActorContext) {
  const [controller] = await getDb(db)
    .select({
      userId: user.id,
      name: user.name,
      email: user.email,
      ledgerPartyId: ledgerParty.id,
      ledgerPartyShortcode: ledgerParty.shortcode,
      ledgerPartyName: ledgerParty.name,
      ledgerPartyKind: ledgerParty.kind,
    })
    .from(ledgerParty)
    .innerJoin(user, eq(user.id, ledgerParty.userId))
    .where(
      and(
        eq(ledgerParty.userId, actor.userId),
        eq(ledgerParty.kind, "member"),
        notDeleted(ledgerParty),
      ),
    )
    .limit(1);
  return controller;
}

export async function loadRunControlScopeByShortcode(
  db: Database,
  publicId: string,
) {
  const [scope] = await getDb(db)
    .select({
      runId: run.id,
      ledgerPartyId: run.ledgerPartyId,
      vendorAccountId: run.vendorAccountId,
      purpose: run.purpose,
    })
    .from(run)
    .where(
      and(eq(run.shortcode, runShortcode.parse(publicId)), notDeleted(run)),
    )
    .limit(1);
  if (!scope) throw new Error("Run was not found");
  return scope;
}
