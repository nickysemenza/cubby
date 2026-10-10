/**
 * Mail import admission: classified Emails become one Pi Run's targets. The
 * Run freezes each Email's checksum and owns it through `MailboxMessage.runId`,
 * so discovery replay and a member's import of the same Email converge on one
 * owner. Interpretation (Vendor, orders, Products) happens later, through the
 * public tools (ADR 0010).
 */
import {
  userId,
  parseEntityId,
  runEntityId,
  type RunId,
} from "@cubby/schemas/identifiers";
import { importRunAgentIdentity } from "@cubby/schemas/import-run-agent";
import { MAILBOX_RESEARCH_VERSION } from "@cubby/schemas/mailbox-research";
import { mailResearchRunInput } from "@cubby/schemas/run-fields";
import { sha256Hex } from "@cubby/shared/sha256";
import { and, asc, eq, inArray, or } from "drizzle-orm";

import { getPurchaseAgentQueue } from "~/server/cf-env";
import type { Database, DrizzleTransaction } from "~/server/db";
import {
  ledgerParty,
  mailboxMessage,
  orderMail,
  run,
  runTarget,
} from "~/server/db/schema";
import type { PurchaseAgentQueueProducer } from "~/server/purchase-agent-queue-types";
import {
  getDb,
  notDeleted,
  withTransaction,
} from "~/server/repo/database-helpers";
import { runAfterCommit } from "~/server/repo/database-helpers/core";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import { actorSnapshot, assertRunParent } from "~/server/runs/ensure-run";
import {
  bindRetainedMailBackfill,
  inheritExecutionAuthorization,
} from "~/server/runs/execution-context";

import { dispatchRunEvent, recordRunDispatchAttempt } from "./dispatch";
import { assertMailSourceIdentityReady } from "./mail-source-identity";

type MailImportAdmission = {
  ledgerPartyId: string;
  userId: string;
  /** Acquisition may constrain a mailbox; each Email keeps its own. */
  mailboxId?: string;
  /** Retained OrderMail UUIDs, not Gmail message ids. */
  messageIds: readonly string[];
  expectedChecksums?: readonly { orderMailId: string; checksum: string }[];
  parentRunId?: RunId;
};

async function lockMailSources(
  tx: DrizzleTransaction,
  input: MailImportAdmission,
  partyId: NonNullable<typeof run.$inferSelect.ledgerPartyId>,
) {
  const sources = await tx
    .select()
    .from(orderMail)
    .where(
      and(
        eq(orderMail.ledgerPartyId, partyId),
        input.mailboxId ? eq(orderMail.mailboxId, input.mailboxId) : undefined,
        inArray(orderMail.id, [...input.messageIds]),
      ),
    )
    .orderBy(asc(orderMail.id))
    .for("update");
  if (sources.length !== input.messageIds.length)
    throw new Error("Mail source was not found for this member and mailbox.");
  for (const expected of input.expectedChecksums ?? [])
    if (
      sources.find((source) => source.id === expected.orderMailId)
        ?.rawChecksum !== expected.checksum
    )
      throw new Error(
        "Mail source evidence changed; refresh before importing.",
      );
  for (const source of sources) await assertMailSourceIdentityReady(tx, source);
  return sources;
}

/**
 * Emails another live Mail import Run already owns stay with it; the rest
 * are fresh. An excluded, deleted or changed Email is refused.
 */
async function partitionOwnership(
  tx: DrizzleTransaction,
  partyId: NonNullable<typeof run.$inferSelect.ledgerPartyId>,
  sources: (typeof orderMail.$inferSelect)[],
) {
  // Older retained originals predate the mailbox ledger. Establish their
  // exact source identity without overwriting existing ownership.
  await tx
    .insert(mailboxMessage)
    .values(
      sources.map((source) => ({
        ledgerPartyId: partyId,
        mailboxId: source.mailboxId,
        messageId: source.messageId,
        orderMailId: source.id,
        checksum: source.rawChecksum,
        classification: "uncertain" as const,
        classificationVersion: "retained-source-admission/v1",
        status: "pending" as const,
      })),
    )
    .onConflictDoNothing();
  const messages = await tx
    .select()
    .from(mailboxMessage)
    .where(
      and(
        eq(mailboxMessage.ledgerPartyId, partyId),
        or(
          ...sources.map((source) =>
            and(
              eq(mailboxMessage.mailboxId, source.mailboxId),
              eq(mailboxMessage.messageId, source.messageId),
            ),
          ),
        ),
      ),
    )
    .for("update");
  const owners = new Map<string, typeof run.$inferSelect>();
  const fresh: (typeof orderMail.$inferSelect)[] = [];
  for (const source of sources) {
    const message = messages.find(
      (candidate) =>
        candidate.mailboxId === source.mailboxId &&
        candidate.messageId === source.messageId,
    );
    if (message && ["excluded", "deleted"].includes(message.status))
      throw new Error(
        "Mail source was excluded or deleted from the connected mailbox.",
      );
    if (
      message &&
      (message.orderMailId !== source.id ||
        message.checksum !== source.rawChecksum)
    )
      throw new Error("Mail import ledger differs from its retained original.");
    const [owner] = message?.runId
      ? await tx
          .select()
          .from(run)
          .where(
            and(
              eq(run.id, runEntityId.parse(message.runId)),
              eq(run.ledgerPartyId, partyId),
              notDeleted(run),
            ),
          )
          .limit(1)
      : [];
    if (owner && !owner.retiredAt) owners.set(owner.id, owner);
    else fresh.push(source);
  }
  return { owners, fresh };
}

export async function admitMailImport(
  db: Database,
  input: MailImportAdmission,
) {
  if (input.messageIds.length === 0) return [];
  if (
    input.messageIds.length > 50 ||
    new Set(input.messageIds).size !== input.messageIds.length
  )
    throw new Error("Choose at most fifty distinct retained mail sources.");
  const partyId = parseEntityId("ledgerParty", input.ledgerPartyId);
  const actorId = userId.parse(input.userId);
  return withTransaction(db, async (tx) => {
    const [party] = await tx
      .select()
      .from(ledgerParty)
      .where(
        and(
          eq(ledgerParty.id, partyId),
          eq(ledgerParty.userId, actorId),
          eq(ledgerParty.kind, "member"),
          notDeleted(ledgerParty),
        ),
      )
      // Serialize admission while allowing source claims to reference this member.
      .for("no key update");
    if (!party) throw new Error("Mail import requires the owning member.");
    if (input.parentRunId)
      await assertRunParent(tx, input.parentRunId, {
        actorUserId: actorId,
        ledgerPartyId: partyId,
      });
    const sources = await lockMailSources(tx, input, partyId);
    const { owners, fresh } = await partitionOwnership(tx, partyId, sources);
    const existing = [...owners.values()].map((row) => ({
      created: false,
      row,
    }));
    if (fresh.length === 0) return existing;
    const sourceSet = mailResearchRunInput.parse({
      kind: "mail_research",
      sources: fresh.map((source) => ({
        orderMailId: source.id,
        checksum: source.rawChecksum,
      })),
    });
    const clientKey = `mail-research:${party.id}:${await sha256Hex(
      JSON.stringify([MAILBOX_RESEARCH_VERSION, sourceSet]),
    )}`;
    const [replayed] = await tx
      .select()
      .from(run)
      .where(eq(run.clientKey, clientKey))
      .limit(1);
    if (replayed) return [...existing, { created: false, row: replayed }];
    const inherited = mailResearchRunInput.parse(
      await inheritExecutionAuthorization(tx, sourceSet, {
        parentRunId: input.parentRunId,
      }),
    );
    const authorized = await bindRetainedMailBackfill(
      tx,
      inherited,
      { userId: actorId, ledgerPartyId: party.id },
      fresh.map((source) => [
        {
          externalKey: `gmail:${source.mailboxId}:${source.messageId}`,
          checksum: source.rawChecksum,
        },
      ]),
    );
    const snapshot = await actorSnapshot(tx, actorId);
    const id = runEntityId.parse(crypto.randomUUID());
    const row = await insertWithShortcode(tx, "run", {
      id,
      ledgerPartyId: party.id,
      purpose: "mail_import",
      trigger: "discovery",
      status: "running",
      channel: "system",
      actorUserId: actorId,
      actorName: snapshot.actorName,
      actorEmail: snapshot.actorEmail,
      actorLedgerPartyShortcode: snapshot.ledgerPartyShortcode,
      actorLedgerPartyName: snapshot.ledgerPartyName,
      actorLedgerPartyKind: snapshot.ledgerPartyKind,
      parentRunId: input.parentRunId ?? null,
      cause: "source_discovered",
      input: authorized,
      clientKey,
      startedAt: new Date(),
      dispatchEventId: crypto.randomUUID(),
      agentSessionId: importRunAgentIdentity(id, "mail_import"),
    });
    await tx.insert(runTarget).values(
      await Promise.all(
        fresh.map(async (source) => ({
          runId: id,
          entityKind: "run" as const,
          entityId: id,
          workKey: source.id,
          sourceKind: "mail_message",
          sourceExternalKey: source.id,
          state: "pending",
          targetFingerprint: await sha256Hex(
            JSON.stringify([
              source.id,
              source.rawChecksum,
              MAILBOX_RESEARCH_VERSION,
            ]),
          ),
        })),
      ),
    );
    const assigned = await tx
      .update(mailboxMessage)
      .set({ status: "researching", runId: id })
      .where(
        or(
          ...fresh.map((source) =>
            and(
              eq(mailboxMessage.ledgerPartyId, source.ledgerPartyId),
              eq(mailboxMessage.mailboxId, source.mailboxId),
              eq(mailboxMessage.messageId, source.messageId),
              eq(mailboxMessage.orderMailId, source.id),
              eq(mailboxMessage.checksum, source.rawChecksum),
            ),
          ),
        ),
      )
      .returning({ orderMailId: mailboxMessage.orderMailId });
    if (assigned.length !== fresh.length)
      throw new Error("Mail source ownership assignment is incomplete.");
    return [...existing, { created: true, row }];
  });
}

/** Admit, then hand each new or undispatched Run to Pi after commit. */
export async function startMailImport(
  db: Database,
  input: MailImportAdmission,
  queue: PurchaseAgentQueueProducer | undefined = getPurchaseAgentQueue(),
): Promise<{ runId: string; status: string }[]> {
  const admitted = await admitMailImport(db, input);
  const results = admitted.map((admission) => ({
    runId: admission.row.id,
    status: admission.row.status,
  }));
  for (const admission of admitted) {
    if (
      admission.row.retiredAt ||
      admission.row.deletedAt ||
      !(
        admission.created ||
        admission.row.status === "dispatch_failed" ||
        (admission.row.status === "running" &&
          admission.row.dispatchAttempts === 0)
      )
    )
      continue;
    const eventId = admission.row.dispatchEventId;
    if (!eventId) throw new Error("Mail import Run has no dispatch identity.");
    await runAfterCommit(db, async (committedDb) => {
      const [live] = await getDb(committedDb)
        .select()
        .from(run)
        .where(eq(run.id, admission.row.id));
      if (
        !live ||
        live.retiredAt ||
        live.deletedAt ||
        !["running", "dispatch_failed"].includes(live.status)
      )
        return;
      if (!queue)
        await recordRunDispatchAttempt(committedDb, {
          runId: admission.row.id,
          eventId,
          error: "Purchase agent queue is unavailable",
        });
      else
        try {
          await dispatchRunEvent(committedDb, queue, {
            version: 1,
            type: "start_or_resume",
            runId: admission.row.id,
            purpose: "mail_import",
            eventId,
          });
        } catch {
          // SILENT: dispatchRunEvent retained the error; the caller receives dispatch_failed and retries the same admission.
        }
      const [saved] = await getDb(committedDb)
        .select({ status: run.status })
        .from(run)
        .where(eq(run.id, admission.row.id));
      const summary = results.find(
        (result) => result.runId === admission.row.id,
      );
      if (summary && saved) summary.status = saved.status;
    });
  }
  return results;
}
