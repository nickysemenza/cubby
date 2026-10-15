import type { LedgerPartyId, RunId } from "@cubby/schemas/identifiers";
import { and, eq } from "drizzle-orm";

import type { Database } from "~/server/db";
import { getDb, notDeleted } from "~/server/db/helpers";
import { ledgerParty, run } from "~/server/db/schema";
import { readRetainedMail } from "~/server/domains/mail/repo/retained-mail";
import { readMailRunSources } from "~/server/domains/purchase-import/repo/mail-run-membership";
import { assertMailSourceIdentityReady } from "~/server/domains/purchase-import/repo/mail-source-identity";

export async function assertSelectedMailSources(
  db: Database,
  runId: RunId,
  ledgerPartyId: LedgerPartyId,
): Promise<void> {
  const sources = await readMailRunSources(getDb(db), runId);
  const originals = await readRetainedMail(db, {
    ledgerPartyIds: [ledgerPartyId],
    orderMailIds: sources.map((source) => source.orderMailId),
  });
  for (const source of sources) {
    const original = originals.find((item) => item.id === source.orderMailId);
    if (
      !source.owned ||
      !source.unchanged ||
      source.email.ledgerPartyId !== ledgerPartyId ||
      source.email.deletedAt ||
      ["excluded", "deleted"].includes(source.email.status) ||
      !original ||
      original.rawChecksum !== source.checksum
    )
      throw new Error("Selected Email source evidence or ownership changed.");
    await assertMailSourceIdentityReady(getDb(db), original);
  }
}

export type RunExecutionIdentity = Pick<
  typeof run.$inferSelect,
  "status" | "retiredAt" | "actorUserId" | "ledgerPartyId"
>;

/** A member-owned mail import Run's lineage fields, for Luna retry checks. */
export async function readMailImportLineage(db: Database, id: RunId) {
  const [row] = await getDb(db)
    .select({
      actorUserId: run.actorUserId,
      ledgerPartyId: run.ledgerPartyId,
      status: run.status,
      retiredAt: run.retiredAt,
      purpose: run.purpose,
      trigger: run.trigger,
      cause: run.cause,
      parentRunId: run.parentRunId,
      predecessorRunId: run.predecessorRunId,
      input: run.input,
    })
    .from(run)
    .innerJoin(
      ledgerParty,
      and(
        eq(ledgerParty.id, run.ledgerPartyId),
        eq(ledgerParty.userId, run.actorUserId),
        eq(ledgerParty.kind, "member"),
        notDeleted(ledgerParty),
      ),
    )
    .where(and(eq(run.id, id), eq(run.purpose, "mail_import"), notDeleted(run)))
    .limit(1);
  return row;
}

export async function readLiveRunOwner(db: Database, runId: RunId) {
  const [row] = await getDb(db)
    .select({
      status: run.status,
      purpose: run.purpose,
      retiredAt: run.retiredAt,
      input: run.input,
      actorUserId: run.actorUserId,
      ledgerPartyId: run.ledgerPartyId,
    })
    .from(run)
    .where(and(eq(run.id, runId), notDeleted(run)))
    .limit(1);
  return row;
}
