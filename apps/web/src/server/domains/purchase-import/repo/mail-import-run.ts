/**
 * Mail import admission: classified Emails become one Pi Run's targets. The
 * Run freezes each Email's checksum and owns it through `Email.runId`,
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
import {
  coordinatorModelFor,
  importRunAgentIdentity,
} from "@cubby/schemas/import-run-agent";
import {
  mailboxDiscoveryInput,
  MAILBOX_RESEARCH_VERSION,
} from "@cubby/schemas/mailbox-research";
import { mailResearchRunInput } from "@cubby/schemas/run-fields";
import { sha256Hex } from "@cubby/shared/sha256";
import { and, asc, eq, inArray, isNull, ne, notInArray, or } from "drizzle-orm";

import { getPurchaseAgentQueue } from "~/server/cf-env";
import type { Database, DrizzleTransaction } from "~/server/db";
import { getDb, notDeleted, withTransaction } from "~/server/db/helpers";
import { runAfterCommit } from "~/server/db/helpers/core";
import {
  ledgerParty,
  email as emailTable,
  orderMail,
  run,
} from "~/server/db/schema";
import {
  readRetainedMail,
  type RetainedMail,
} from "~/server/domains/mail/repo/retained-mail";
import type { PurchaseAgentQueueProducer } from "~/server/domains/purchase-agent/service/purchase-agent-queue-types";
import {
  assertMailSourceIdentityReady,
  HISTORICAL_MAIL_SOURCE_IDENTITY_VERSION,
} from "~/server/domains/purchase-import/repo/mail-source-identity";
import {
  actorSnapshot,
  assertRunParent,
} from "~/server/domains/run/repo/ensure-run";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";

import { dispatchRunEvent, recordRunDispatchAttempt } from "./dispatch";

const CLASSIFICATION_RUN_PURPOSES: (typeof run.$inferSelect.purpose)[] = [
  "mail_discovery",
  "mail_reclassify",
  "ai_refresh",
];

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
  const sources = await readRetainedMail(
    tx,
    {
      ledgerPartyIds: [partyId],
      mailboxId: input.mailboxId,
      orderMailIds: input.messageIds,
    },
    "update",
  );
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
  sources: RetainedMail[],
) {
  const messages = await tx
    .select()
    .from(emailTable)
    .where(
      and(
        eq(emailTable.ledgerPartyId, partyId),
        or(
          ...sources.map((source) =>
            and(
              eq(emailTable.mailboxId, source.mailboxId),
              eq(emailTable.messageId, source.messageId),
            ),
          ),
        ),
      ),
    )
    .for("update");
  const owners = new Map<string, typeof run.$inferSelect>();
  const fresh: RetainedMail[] = [];
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
    if (
      owner &&
      !owner.retiredAt &&
      !CLASSIFICATION_RUN_PURPOSES.includes(owner.purpose)
    )
      owners.set(owner.id, owner);
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
  const selectedSources = new Set(
    input.expectedChecksums?.map((source) => source.orderMailId),
  );
  const memberSelected =
    !input.parentRunId &&
    input.messageIds.every((id) => selectedSources.has(id));
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
    if (input.parentRunId) {
      const [parent] = await tx
        .select({
          purpose: run.purpose,
          input: run.input,
        })
        .from(run)
        .where(eq(run.id, input.parentRunId));
      const policy = mailboxDiscoveryInput.safeParse(parent?.input);
      if (
        parent?.purpose === "mail_discovery" &&
        (!policy.success ||
          policy.data.executionPolicy === "classification_only")
      )
        throw new Error(
          "Classification-only discovery cannot admit Emails to Pi.",
        );
    }
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
    const snapshot = await actorSnapshot(tx, actorId);
    const id = runEntityId.parse(crypto.randomUUID());
    const row = await insertWithShortcode(tx, "run", {
      id,
      ledgerPartyId: party.id,
      purpose: "mail_import",
      trigger: memberSelected ? "foreground" : "discovery",
      status: "running",
      channel: "system",
      actorUserId: actorId,
      actorName: snapshot.actorName,
      actorEmail: snapshot.actorEmail,
      actorLedgerPartyShortcode: snapshot.ledgerPartyShortcode,
      actorLedgerPartyName: snapshot.ledgerPartyName,
      actorLedgerPartyKind: snapshot.ledgerPartyKind,
      parentRunId: input.parentRunId ?? null,
      cause: memberSelected ? "member_request" : "source_discovered",
      coordinatorModel: coordinatorModelFor("mail_import"),
      input: sourceSet,
      clientKey,
      startedAt: new Date(),
      dispatchEventId: crypto.randomUUID(),
      agentSessionId: importRunAgentIdentity(id, "mail_import"),
    });
    const assigned = await tx
      .update(emailTable)
      .set({ status: "researching", runId: id })
      .where(
        or(
          ...fresh.map((source) =>
            and(
              eq(emailTable.ledgerPartyId, source.ledgerPartyId),
              eq(emailTable.mailboxId, source.mailboxId),
              eq(emailTable.messageId, source.messageId),
              eq(emailTable.orderMailId, source.id),
              eq(emailTable.checksum, source.rawChecksum),
            ),
          ),
        ),
      )
      .returning({ orderMailId: emailTable.orderMailId });
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
            generation: eventId,
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

/** Revisit retained related Emails that predate automatic import admission. */
export async function importPendingEmails(
  db: Database,
  queue: PurchaseAgentQueueProducer | undefined = getPurchaseAgentQueue(),
) {
  const { listMemberMailboxes } =
    await import("~/server/domains/purchase-import/repo/gmail/targets");
  const { mailImportEnabled } = await import("./mail-import-settings");
  const { retainedEmailImportContentCondition } =
    await import("~/server/domains/purchase-import/repo/email-content");
  const errors: unknown[] = [];
  for (const target of await listMemberMailboxes(db)) {
    const actorId = target.userId;
    if (!actorId) continue;
    if (!(await mailImportEnabled(db, target.mailboxId))) continue;
    const pending = await getDb(db)
      .select({ id: orderMail.id })
      .from(emailTable)
      .innerJoin(
        orderMail,
        and(
          eq(orderMail.id, emailTable.orderMailId),
          eq(orderMail.rawChecksum, emailTable.checksum),
        ),
      )
      .leftJoin(run, eq(run.id, emailTable.runId))
      .where(
        and(
          eq(
            emailTable.ledgerPartyId,
            parseEntityId("ledgerParty", target.ledgerPartyId),
          ),
          eq(emailTable.mailboxId, target.mailboxId),
          eq(emailTable.classification, "related"),
          or(
            isNull(emailTable.classificationVersion),
            ne(
              emailTable.classificationVersion,
              HISTORICAL_MAIL_SOURCE_IDENTITY_VERSION,
            ),
          ),
          retainedEmailImportContentCondition(),
          or(
            isNull(emailTable.runId),
            and(
              inArray(run.purpose, CLASSIFICATION_RUN_PURPOSES),
              eq(run.ledgerPartyId, emailTable.ledgerPartyId),
            ),
          ),
          notInArray(emailTable.status, ["excluded", "deleted"]),
          notDeleted(emailTable),
        ),
      )
      .orderBy(asc(emailTable.createdAt), asc(emailTable.id))
      .limit(50);
    const admit = (messageIds: readonly string[]) =>
      startMailImport(
        db,
        {
          ledgerPartyId: target.ledgerPartyId,
          userId: actorId,
          mailboxId: target.mailboxId,
          messageIds,
        },
        queue,
      );
    try {
      await admit(pending.map(({ id }) => id));
    } catch {
      // SILENT: retry each source below; persistent errors are returned and reported after discovery.
      // A source may change after selection. Isolate it without abandoning
      // other sources; admission replay preserves ownership on a retry.
      for (const { id } of pending) {
        try {
          await admit([id]);
        } catch (error) {
          errors.push(error);
        }
      }
    }
  }
  return { errors };
}
