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
  orderMailAttachment,
  researchRetention,
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
import { inheritExecutionAuthorization } from "~/server/runs/execution-context";

import { dispatchRunEvent, recordRunDispatchAttempt } from "./dispatch";
import { assertMailSourceIdentityReady } from "./mail-source-identity";
import {
  readResearchContinuationSuccessor,
  researchContinuationAdmission,
  type ResearchContinuation,
} from "./research-continuation-admission";
import {
  historicalMailSources,
  isHistoricalMailRun,
} from "./research-legacy-mail";
import { researchRetirementAdmission } from "./research-retention-admission";

const frozenOwnerMatches = (
  owner: typeof run.$inferSelect | undefined,
  source: typeof orderMail.$inferSelect,
) => {
  const frozen = mailResearchRunInput.safeParse(owner?.input);
  return Boolean(
    owner &&
    frozen.success &&
    frozen.data.sources.some(
      (item) =>
        item.orderMailId === source.id && item.checksum === source.rawChecksum,
    ),
  );
};

function predecessorOwnsMail(
  owner: typeof run.$inferSelect | undefined,
  source: typeof orderMail.$inferSelect,
  message: typeof mailboxMessage.$inferSelect,
  input: Parameters<typeof retainedMailResearchOwners>[3],
): boolean {
  return Boolean(
    input.predecessor &&
    owner &&
    owner.id === input.predecessor.id &&
    message.checksum === source.rawChecksum &&
    (frozenOwnerMatches(owner, source) ||
      (isHistoricalMailRun(owner) &&
        input.historicalSources?.some(
          (item) =>
            item.id === source.id && item.rawChecksum === source.rawChecksum,
        ))),
  );
}

async function retainedMailResearchOwners(
  tx: Pick<DrizzleTransaction, "select">,
  sources: (typeof orderMail.$inferSelect)[],
  messages: (typeof mailboxMessage.$inferSelect)[],
  input: {
    partyId: NonNullable<typeof run.$inferSelect.ledgerPartyId>;
    predecessor?: typeof run.$inferSelect;
    historicalSources?: (typeof orderMail.$inferSelect)[];
    retirement: boolean;
  },
) {
  const owned = new Map<string, typeof run.$inferSelect>();
  const fresh = [];
  // Admission holds the original-row locks also used by retirement. A receipt
  // is visible here, or its later inventory must include the successor we create.
  const retired = await tx
    .select({
      sourceId: researchRetention.orderMailId,
      checksum: researchRetention.checksum,
    })
    .from(researchRetention)
    .where(
      and(
        eq(researchRetention.ledgerPartyId, input.partyId),
        inArray(
          researchRetention.orderMailId,
          sources.map((source) => source.id),
        ),
      ),
    );
  for (const source of sources) {
    if (
      retired.some(
        (entry) =>
          entry.sourceId === source.id && entry.checksum === source.rawChecksum,
      )
    ) {
      if (input.retirement) continue;
      throw new Error("Mail source permanently retired: unrelated_source.");
    }
    const message = messages.find(
      (candidate) =>
        candidate.ledgerPartyId === source.ledgerPartyId &&
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
      throw new Error(
        "Mail research ledger differs from its retained original.",
      );
    if (message?.runId) {
      const [owner] = await tx
        .select()
        .from(run)
        .where(
          and(
            eq(run.id, runEntityId.parse(message.runId)),
            eq(run.ledgerPartyId, input.partyId),
            notDeleted(run),
          ),
        )
        .limit(1);
      if (predecessorOwnsMail(owner, source, message, input)) {
        fresh.push(source);
        continue;
      }
      if (
        !owner ||
        owner.retiredAt ||
        message.checksum !== source.rawChecksum ||
        !["researching", "completed", "blocked"].includes(message.status) ||
        !frozenOwnerMatches(owner, source)
      )
        throw new Error(
          "Mail research ownership does not match its retained source.",
        );
      // A valid current owner keeps this source; the predecessor can still
      // continue its remaining originals without transferring this one.
      if (input.predecessor) continue;
      owned.set(owner.id, owner);
    } else fresh.push(source);
  }
  return { owned, fresh };
}

async function assertActiveMailResearchParent(
  tx: Pick<DrizzleTransaction, "select">,
  input: Pick<
    Parameters<typeof startMailResearch>[1],
    "parentRunId" | "parentWorkRef"
  >,
  scope: Pick<typeof run.$inferSelect, "actorUserId" | "ledgerPartyId">,
) {
  if (!input.parentWorkRef) return;
  if (!input.parentRunId)
    throw new Error("Parent research work requires its Run.");
  const [parent] = await tx
    .select()
    .from(run)
    .where(and(eq(run.id, input.parentRunId), notDeleted(run)))
    .for("update");
  if (
    !parent ||
    parent.retiredAt ||
    parent.actorUserId !== scope.actorUserId ||
    parent.ledgerPartyId !== scope.ledgerPartyId ||
    !["running", "paused_offline"].includes(parent.status)
  )
    throw new Error("The parent research Run is retired or fenced.");
  const [work] = await tx
    .select()
    .from(runTarget)
    .where(
      and(
        eq(runTarget.id, input.parentWorkRef),
        eq(runTarget.runId, parent.id),
      ),
    )
    .for("update");
  if (!work || !["pending", "prepared", "needs_evidence"].includes(work.state))
    throw new Error("The parent research work is settled or fenced.");
}

function assertExpectedMailSources(
  sources: (typeof orderMail.$inferSelect)[],
  expectedChecksums: Parameters<
    typeof admitMailResearch
  >[1]["expectedChecksums"],
) {
  for (const expected of expectedChecksums ?? []) {
    if (
      sources.find((source) => source.id === expected.orderMailId)
        ?.rawChecksum !== expected.checksum
    )
      throw new Error(
        "Mail source evidence changed; refresh before researching.",
      );
  }
}

function assertMailAdmissionMode(
  input: Parameters<typeof admitMailResearch>[1],
) {
  if (input.continuation && input.retirementReceiptId)
    throw new Error("Choose ordinary continuation or a retirement receipt.");
}

async function lockHistoricalMailSources(
  tx: DrizzleTransaction,
  input: Parameters<typeof admitMailResearch>[1],
  scope: Pick<typeof run.$inferSelect, "ledgerPartyId" | "actorUserId">,
): Promise<(typeof orderMail.$inferSelect)[]> {
  if (!input.continuation) return [];
  const [predecessor] = await tx
    .select()
    .from(run)
    .where(
      and(
        eq(run.id, input.continuation.predecessorRunId),
        eq(run.ledgerPartyId, scope.ledgerPartyId!),
        eq(run.actorUserId, scope.actorUserId!),
        notDeleted(run),
      ),
    );
  if (!predecessor || !isHistoricalMailRun(predecessor)) return [];
  return (await historicalMailSources(tx, predecessor, true)).selected;
}

async function assignMailResearchOwnership(
  tx: DrizzleTransaction,
  id: RunId,
  fresh: (typeof orderMail.$inferSelect)[],
) {
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
}

async function lockMailSources(
  tx: DrizzleTransaction,
  input: Parameters<typeof admitMailResearch>[1],
  partyId: NonNullable<typeof run.$inferSelect.ledgerPartyId>,
): Promise<(typeof orderMail.$inferSelect)[]> {
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
  assertExpectedMailSources(sources, input.expectedChecksums);
  for (const source of sources) await assertMailSourceIdentityReady(tx, source);
  return sources;
}

/** Admission owns source identity; vendors and orders are interpreted later. */
export async function admitMailResearch(
  db: Database,
  input: {
    ledgerPartyId: string;
    userId: string;
    /** Acquisition may constrain a mailbox; frozen research scope belongs to each source. */
    mailboxId?: string;
    /** Retained OrderMail UUIDs, not Gmail message ids. */
    messageIds: readonly string[];
    expectedChecksums?: readonly { orderMailId: string; checksum: string }[];
    parentRunId?: RunId;
    retirementReceiptId?: string;
    continuation?: ResearchContinuation;
    /** Only live investigation needs this fence; completed-parent lineage does not. */
    parentWorkRef?: string;
  },
) {
  if (input.messageIds.length === 0) return [];
  if (
    input.messageIds.length > 50 ||
    new Set(input.messageIds).size !== input.messageIds.length
  )
    throw new Error("Choose at most fifty distinct retained mail sources.");
  const partyId = parseEntityId("ledgerParty", input.ledgerPartyId);
  const actorId = userId.parse(input.userId);
  const admitted = await withTransaction(db, async (tx) => {
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
    if (!party) throw new Error("Mail research requires the owning member.");
    assertMailAdmissionMode(input);
    const existingSuccessor = await readResearchContinuationSuccessor(tx, {
      continuation: input.continuation,
      ledgerPartyId: partyId,
      actorUserId: actorId,
      purpose: "mail_import",
    });
    if (existingSuccessor) return [{ created: false, row: existingSuccessor }];
    if (input.parentRunId)
      await assertRunParent(tx, input.parentRunId, {
        actorUserId: actorId,
        ledgerPartyId: partyId,
      });

    const historicalSources = await lockHistoricalMailSources(tx, input, {
      ledgerPartyId: partyId,
      actorUserId: actorId,
    });

    const sources = await lockMailSources(tx, input, partyId);
    await assertActiveMailResearchParent(tx, input, {
      actorUserId: actorId,
      ledgerPartyId: partyId,
    });
    const continuation =
      (await researchContinuationAdmission(tx, {
        continuation: input.continuation,
        ledgerPartyId: partyId,
        actorUserId: actorId,
        purpose: "mail_import",
        taskKeys: input.messageIds,
      })) ??
      (await researchRetirementAdmission(tx, {
        receiptId: input.retirementReceiptId,
        parentRunId: input.parentRunId,
        ledgerPartyId: partyId,
        actorUserId: actorId,
        purpose: "mail_import",
        taskKeys: input.messageIds,
      }));
    if (continuation) {
      const [existing] = await tx
        .select()
        .from(run)
        .where(eq(run.clientKey, continuation.clientKey));
      if (existing) return [{ created: false, row: existing }];
    }
    // Older retained originals predate the mailbox ledger. Establish their
    // exact source identity without overwriting existing ownership or disposition.
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
    const { owned, fresh } = await retainedMailResearchOwners(
      tx,
      sources,
      messages,
      {
        partyId,
        predecessor: continuation?.predecessor,
        historicalSources,
        retirement: Boolean(input.retirementReceiptId),
      },
    );
    const existingOwners = [...owned.values()].map((row) => ({
      created: false,
      row,
    }));
    if (fresh.length === 0) return existingOwners;
    const sourceSet = mailResearchRunInput.parse({
      kind: "mail_research",
      sources: fresh.map((source) => ({
        orderMailId: source.id,
        checksum: source.rawChecksum,
      })),
    });
    const digest = await sha256Hex(
      JSON.stringify([MAILBOX_RESEARCH_VERSION, sourceSet]),
    );
    const clientKey =
      continuation?.clientKey ?? `mail-research:${party.id}:${digest}`;
    const [existing] = await tx
      .select()
      .from(run)
      .where(eq(run.clientKey, clientKey))
      .limit(1);
    if (existing) return [...existingOwners, { created: false, row: existing }];
    const snapshot = await actorSnapshot(tx, actorId);
    const id = runEntityId.parse(crypto.randomUUID());
    const lineage: Pick<
      typeof run.$inferInsert,
      "parentRunId" | "predecessorRunId" | "cause" | "attempt"
    > = continuation
      ? {
          parentRunId: continuation.parentRunId,
          predecessorRunId: continuation.predecessorRunId,
          cause: "retry",
          attempt: continuation.attempt,
        }
      : {
          parentRunId: input.parentRunId ?? null,
          predecessorRunId: null,
          cause: "source_discovered",
          attempt: 1,
        };
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
      ...lineage,
      actorLedgerPartyShortcode: snapshot.ledgerPartyShortcode,
      actorLedgerPartyName: snapshot.ledgerPartyName,
      actorLedgerPartyKind: snapshot.ledgerPartyKind,
      input:
        (await inheritExecutionAuthorization(tx, sourceSet, {
          parentRunId: continuation
            ? continuation.parentRunId
            : input.parentRunId,
          predecessorRunId: continuation?.predecessorRunId,
        })) ?? null,
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
    await assignMailResearchOwnership(tx, id, fresh);
    return [...existingOwners, { created: true, row }];
  });
  return admitted;
}

export async function startMailResearch(
  db: Database,
  input: Parameters<typeof admitMailResearch>[1],
  queue: PurchaseAgentQueueProducer | undefined = getPurchaseAgentQueue(),
): Promise<{ runId: string; status: string }[]> {
  const admitted = await admitMailResearch(db, input);
  const results = admitted.map((admission) => ({
    runId: admission.row.id,
    status: admission.row.status,
  }));
  for (const admission of admitted) {
    if (
      !admission.row.retiredAt &&
      !admission.row.deletedAt &&
      (admission.created ||
        admission.row.status === "dispatch_failed" ||
        (admission.row.status === "running" &&
          admission.row.dispatchAttempts === 0))
    ) {
      const eventId = admission.row.dispatchEventId;
      if (!eventId) throw new Error("Research Run has no dispatch identity.");
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
        if (!queue) {
          await recordRunDispatchAttempt(committedDb, {
            runId: admission.row.id,
            eventId,
            error: "Purchase researcher queue is unavailable",
          });
        } else {
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
  }
  return results;
}

/** A current, member-owned retained source set, with immutable launch checksums. */
export async function loadMailResearchSources(db: Database, rawRunId: string) {
  const database = getDb(db);
  const [scope] = await database
    .select()
    .from(run)
    .where(and(eq(run.id, runEntityId.parse(rawRunId)), notDeleted(run)))
    .limit(1);
  if (!scope) throw new Error("Research Run was not found.");
  const parsed = mailResearchRunInput.safeParse(scope.input);
  if (!parsed.success) return null;
  if (!scope.ledgerPartyId)
    throw new Error("Mail research has no member scope.");
  const [owner] = await database
    .select({ id: ledgerParty.id })
    .from(ledgerParty)
    .where(
      and(
        eq(ledgerParty.id, scope.ledgerPartyId),
        eq(ledgerParty.userId, scope.actorUserId),
        notDeleted(ledgerParty),
      ),
    )
    .limit(1);
  if (!owner) throw new Error("Mail research source owner is unavailable.");
  const mails = await database
    .select()
    .from(orderMail)
    .where(
      and(
        eq(orderMail.ledgerPartyId, owner.id),
        inArray(
          orderMail.id,
          parsed.data.sources.map((source) => source.orderMailId),
        ),
      ),
    );
  if (mails.length !== parsed.data.sources.length)
    throw new Error("Research source set is incomplete.");
  const attachments = await database
    .select()
    .from(orderMailAttachment)
    .where(
      inArray(
        orderMailAttachment.orderMailId,
        mails.map((mail) => mail.id),
      ),
    );
  return parsed.data.sources.map((frozen) => {
    const mail = mails.find((candidate) => candidate.id === frozen.orderMailId);
    if (!mail || mail.rawChecksum !== frozen.checksum)
      throw new Error("Retained research source changed since admission.");
    return {
      orderMailId: mail.id,
      mailboxId: mail.mailboxId,
      messageId: mail.messageId,
      checksum: mail.rawChecksum,
      sender: mail.sender,
      subject: mail.subject,
      receivedAt: mail.receivedAt,
      content: mail.content,
      attachments: attachments.filter(
        (attachment) => attachment.orderMailId === mail.id,
      ),
    };
  });
}
