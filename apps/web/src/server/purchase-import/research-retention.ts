import { parseEntityId, runEntityId, userId } from "@cubby/schemas/identifiers";
import { browserEvidenceReference } from "@cubby/schemas/purchase-import";
import { mailResearchRunInput } from "@cubby/schemas/run-fields";
import { ACTIVE_RUN_STATUSES } from "@cubby/shared/client-constants";
import { sha256Uuid } from "@cubby/shared/sha256";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import {
  importSourceClaim,
  importSourceOrder,
  importPreparedLine,
  importPreparedOrder,
  ledgerParty,
  mailboxMessage,
  orderMail,
  orderMailAttachment,
  orderMailCandidateDecision,
  orderMailEvent,
  researchRetention,
  researchSourceExposure,
  photoGroupProposal,
  run,
  runEvidence,
  runFactEvidence,
  runOperation,
  runApproval,
  runFinding,
  runOrderCandidate,
  runProgress,
  runTarget,
} from "~/server/db/schema";
import {
  getDb,
  notDeleted,
  withTransactionDatabase,
} from "~/server/repo/database-helpers";

import {
  assertMailSourceIdentityReady,
  loadMailSourceClaimIds,
} from "./mail-source-identity";

type Work = { runId: string; workRef: string };
type SourceRef = { orderMailId: string; checksum: string };
const liveStatuses = ["running", "paused_offline"];

async function assertSourceNotRetired(
  db: Database,
  source: typeof orderMail.$inferSelect,
) {
  const [receipt] = await getDb(db)
    .select({ id: researchRetention.id })
    .from(researchRetention)
    .where(
      and(
        eq(researchRetention.ledgerPartyId, source.ledgerPartyId),
        eq(researchRetention.orderMailId, source.id),
        eq(researchRetention.checksum, source.rawChecksum),
      ),
    );
  if (receipt)
    throw new Error("Research source permanently retired: unrelated_source.");
}

/** Call inside the existing transaction, before locking a Purchase or Run. */
export async function lockOwnedResearchSource(
  db: Database,
  input: SourceRef & { ledgerPartyId: string; actorUserId: string },
) {
  const [owned] = await getDb(db)
    .select({ source: orderMail })
    .from(orderMail)
    .innerJoin(
      ledgerParty,
      and(
        eq(ledgerParty.id, orderMail.ledgerPartyId),
        eq(ledgerParty.userId, userId.parse(input.actorUserId)),
        eq(ledgerParty.kind, "member"),
        notDeleted(ledgerParty),
      ),
    )
    .where(
      and(
        eq(orderMail.id, input.orderMailId),
        eq(
          orderMail.ledgerPartyId,
          parseEntityId("ledgerParty", input.ledgerPartyId),
        ),
        eq(orderMail.rawChecksum, input.checksum),
      ),
    )
    .for("update", { of: orderMail });
  if (!owned) throw new Error("Research source ownership or checksum changed.");
  await assertMailSourceIdentityReady(getDb(db), owned.source);
  await assertSourceNotRetired(db, owned.source);
  return owned.source;
}

async function ownedRun(db: Database, runId: string) {
  const [owned] = await getDb(db)
    .select({ scope: run })
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
    .where(and(eq(run.id, runEntityId.parse(runId)), notDeleted(run)));
  if (!owned?.scope.ledgerPartyId)
    throw new Error("Research requires the owning member Run.");
  return { ...owned.scope, ledgerPartyId: owned.scope.ledgerPartyId };
}

/** This precedes replay lookup, as well as an operation's final completion write. */
export async function assertResearchRunNotRetired(db: Database, runId: string) {
  const scope = await ownedRun(db, runId);
  if (scope.retiredAt)
    throw new Error(
      "Research coordinator permanently retired: unrelated_source.",
    );
}

async function primarySource(db: Database, input: Work) {
  const scope = await ownedRun(db, input.runId);
  const frozen = mailResearchRunInput.parse(scope.input);
  const [target] = await getDb(db)
    .select()
    .from(runTarget)
    .where(and(eq(runTarget.id, input.workRef), eq(runTarget.runId, scope.id)));
  const reference = frozen.sources.find(
    (source) => source.orderMailId === target?.workKey,
  );
  if (target?.entityKind !== "run" || !reference)
    throw new Error(
      "Unrelated verdict requires its exact primary source work.",
    );
  const [source] = await getDb(db)
    .select()
    .from(orderMail)
    .where(
      and(
        eq(orderMail.id, reference.orderMailId),
        eq(orderMail.ledgerPartyId, scope.ledgerPartyId),
        eq(orderMail.rawChecksum, reference.checksum),
      ),
    )
    .for("update");
  if (!source)
    throw new Error("Primary research source changed or is unavailable.");
  return { scope, target, source };
}

/** Source locks precede the caller's Run/target locks; the callback shares the transaction. */
export async function withResearchSourceAdmission<T>(
  db: Database,
  input: Work,
  work: (transactionDb: Database, source: SourceRef) => Promise<T>,
): Promise<T> {
  return withTransactionDatabase(db, async (transactionDb) => {
    const { source } = await primarySource(transactionDb, input);
    await assertSourceNotRetired(transactionDb, source);
    return work(transactionDb, {
      orderMailId: source.id,
      checksum: source.rawChecksum,
    });
  });
}

/** Enroll before returning headers, search hits, original context, or source bytes. */
export async function exposeResearchSources(
  db: Database,
  input: { runId: string; sources: readonly SourceRef[] },
) {
  if (!input.sources.length) return;
  if (input.sources.length > 100)
    throw new Error("Research exposure exceeds the bounded source set.");
  await withTransactionDatabase(db, async (transactionDb) => {
    const scope = await ownedRun(transactionDb, input.runId);
    const references = new Map(
      input.sources.map((source) => [source.orderMailId, source.checksum]),
    );
    const sources = await getDb(transactionDb)
      .select()
      .from(orderMail)
      .where(
        and(
          eq(orderMail.ledgerPartyId, scope.ledgerPartyId),
          inArray(orderMail.id, [...references.keys()]),
        ),
      )
      .orderBy(asc(orderMail.id))
      .for("update");
    if (
      sources.length !== references.size ||
      sources.some((source) => references.get(source.id) !== source.rawChecksum)
    )
      throw new Error(
        "Research exposure source ownership or checksum changed.",
      );
    const [live] = await getDb(transactionDb)
      .select({ id: run.id })
      .from(run)
      .where(
        and(
          eq(run.id, scope.id),
          isNull(run.retiredAt),
          inArray(run.status, liveStatuses),
        ),
      )
      .for("update");
    if (!live)
      throw new Error("Research exposure requires a live coordinator.");
    for (const source of sources) {
      await assertSourceNotRetired(transactionDb, source);
      await getDb(transactionDb)
        .insert(researchSourceExposure)
        .values({
          runId: scope.id,
          ledgerPartyId: scope.ledgerPartyId,
          orderMailId: source.id,
          checksum: source.rawChecksum,
        })
        .onConflictDoNothing();
    }
  });
}

/** Historical structured source references are conservative exposure, never proof. */
const storedReferences = z.json();
function referencesSource(
  value: z.infer<typeof storedReferences>,
  sourceId: string,
): boolean {
  if (value === sourceId) return true;
  if (Array.isArray(value))
    return value.some((entry) => referencesSource(entry, sourceId));
  const record = z.record(z.string(), storedReferences).safeParse(value);
  return (
    record.success &&
    Object.values(record.data).some((entry) =>
      referencesSource(entry, sourceId),
    )
  );
}

async function preservedEvidenceIds(
  db: Database,
  partyId: typeof ledgerParty.$inferSelect.id,
) {
  const accepted = await getDb(db)
    .select({ evidenceId: runFactEvidence.evidenceId })
    .from(runFactEvidence)
    .innerJoin(runEvidence, eq(runEvidence.id, runFactEvidence.evidenceId))
    .innerJoin(run, eq(run.id, runEvidence.runId))
    .where(eq(run.ledgerPartyId, partyId));
  const sources = await getDb(db)
    .select({ checksum: importSourceOrder.checksum })
    .from(importSourceOrder)
    .innerJoin(
      importSourceClaim,
      eq(importSourceClaim.id, importSourceOrder.sourceClaimId),
    )
    .where(eq(importSourceClaim.ledgerPartyId, partyId));
  const positiveChecksums = new Set(sources.map((source) => source.checksum));
  const evidence = await getDb(db)
    .select({ evidence: runEvidence })
    .from(runEvidence)
    .innerJoin(run, eq(run.id, runEvidence.runId))
    .where(eq(run.ledgerPartyId, partyId));
  return new Set([
    ...accepted.map((item) => item.evidenceId),
    ...evidence
      .filter(({ evidence: item }) => positiveChecksums.has(item.checksum))
      .map(({ evidence: item }) => item.id),
  ]);
}

async function assertNoPositiveSource(
  db: Database,
  source: typeof orderMail.$inferSelect,
) {
  await assertMailSourceIdentityReady(getDb(db), source);
  const attachments = await getDb(db)
    .select()
    .from(orderMailAttachment)
    .where(eq(orderMailAttachment.orderMailId, source.id));
  const claimIds = await loadMailSourceClaimIds(
    getDb(db),
    source,
    attachments.map((attachment) => attachment.providerAttachmentId),
  );
  const associations = await getDb(db)
    .select({ id: importSourceOrder.id })
    .from(importSourceOrder)
    .innerJoin(
      importSourceClaim,
      eq(importSourceClaim.id, importSourceOrder.sourceClaimId),
    )
    .where(inArray(importSourceClaim.id, claimIds));
  const decisions = await getDb(db)
    .select({ id: orderMailCandidateDecision.id })
    .from(orderMailCandidateDecision)
    .innerJoin(
      orderMailEvent,
      eq(orderMailEvent.id, orderMailCandidateDecision.eventId),
    )
    .where(
      and(
        eq(orderMailEvent.orderMailId, source.id),
        eq(orderMailCandidateDecision.decision, "linked"),
      ),
    );
  const facts = await getDb(db)
    .select({ metadata: runEvidence.sourceMetadata })
    .from(runFactEvidence)
    .innerJoin(runEvidence, eq(runEvidence.id, runFactEvidence.evidenceId))
    .innerJoin(run, eq(run.id, runEvidence.runId))
    .where(eq(run.ledgerPartyId, source.ledgerPartyId));
  if (
    associations.length ||
    decisions.length ||
    attachments.some((item) => item.imageId) ||
    facts.some((fact) =>
      referencesSource(storedReferences.parse(fact.metadata), source.id),
    )
  )
    throw new Error(
      "Unrelated cleanup refused: source has a protected positive association.",
    );
}

export async function requestResearchRetention(
  db: Database,
  input: Work & { callId: string; hasSupportedWrites: boolean },
) {
  if (input.hasSupportedWrites)
    throw new Error(
      "Unrelated verdict cannot accompany supported positive writes.",
    );
  return withTransactionDatabase(db, async (transactionDb) => {
    const { scope, source } = await primarySource(transactionDb, input);
    await assertNoPositiveSource(transactionDb, source);
    const id = await sha256Uuid(
      JSON.stringify([
        "research-retention",
        scope.ledgerPartyId,
        source.id,
        source.rawChecksum,
      ]),
    );
    const [existing] = await getDb(transactionDb)
      .select()
      .from(researchRetention)
      .where(eq(researchRetention.id, id));
    if (existing)
      return {
        receiptId: id,
        retiredRunIds: existing.plan.retiredRunIds,
        reason: "unrelated_source" as const,
      };
    const candidates = await getDb(transactionDb)
      .select()
      .from(run)
      // includes-deleted: a Run tombstone can still retain exposed source bytes.
      .where(eq(run.ledgerPartyId, scope.ledgerPartyId));
    const exposures = await getDb(transactionDb)
      .select()
      .from(researchSourceExposure)
      .where(
        and(
          eq(researchSourceExposure.ledgerPartyId, scope.ledgerPartyId),
          eq(researchSourceExposure.orderMailId, source.id),
          eq(researchSourceExposure.checksum, source.rawChecksum),
        ),
      );
    const evidenceBeforeFence = await getDb(transactionDb)
      .select()
      .from(runEvidence)
      .where(
        inArray(
          runEvidence.runId,
          candidates.map((candidate) => candidate.id),
        ),
      );
    const operations = await getDb(transactionDb)
      .select()
      .from(runOperation)
      .where(
        inArray(
          runOperation.runId,
          candidates.map((candidate) => candidate.id),
        ),
      );
    const retiredRunIds = [
      ...new Set([
        scope.id,
        ...exposures.map((item) => item.runId),
        ...candidates
          .filter((candidate) =>
            referencesSource(
              storedReferences.parse(candidate.input),
              source.id,
            ),
          )
          .map((candidate) => candidate.id),
        ...evidenceBeforeFence
          .filter((item) =>
            referencesSource(
              storedReferences.parse(item.sourceMetadata),
              source.id,
            ),
          )
          .map((item) => item.runId),
        ...operations
          .filter((item) =>
            referencesSource(storedReferences.parse(item.result), source.id),
          )
          .map((item) => item.runId),
      ]),
    ].sort();
    // Exposure holds the source first. Readers hold their Run through upload;
    // wait for those writes before freezing the manifest used for R2 deletion.
    await getDb(transactionDb)
      .select({ id: run.id })
      .from(run)
      .where(
        inArray(
          run.id,
          retiredRunIds.map((runId) => runEntityId.parse(runId)),
        ),
      )
      .orderBy(run.id)
      .for("update");
    const evidence = await getDb(transactionDb)
      .select()
      .from(runEvidence)
      .where(
        inArray(
          runEvidence.runId,
          retiredRunIds.map((runId) => runEntityId.parse(runId)),
        ),
      );
    const acceptedIds = await preservedEvidenceIds(
      transactionDb,
      scope.ledgerPartyId,
    );
    const attachments = await getDb(transactionDb)
      .select()
      .from(orderMailAttachment)
      .where(eq(orderMailAttachment.orderMailId, source.id));
    const objectKeys = [
      ...new Set([
        ...evidence
          .filter(
            (item) =>
              retiredRunIds.includes(item.runId) && !acceptedIds.has(item.id),
          )
          .map((item) => item.objectKey),
        ...attachments.flatMap((item) =>
          item.pendingObjectKey ? [item.pendingObjectKey] : [],
        ),
      ]),
    ];
    const now = new Date();
    const screenshotRefs = evidence
      .filter(
        (item) =>
          retiredRunIds.includes(item.runId) && !acceptedIds.has(item.id),
      )
      .flatMap((item) => {
        const metadata = z
          .object({
            screenshots: z.array(browserEvidenceReference).default([]),
          })
          .parse(item.sourceMetadata);
        return metadata.screenshots.map((screenshot) => ({
          runId: item.runId,
          imageRef: screenshot.id,
        }));
      });
    await getDb(transactionDb)
      .insert(researchRetention)
      .values({
        id,
        runId: scope.id,
        workRef: input.workRef,
        ledgerPartyId: scope.ledgerPartyId,
        orderMailId: source.id,
        mailboxId: source.mailboxId,
        messageId: source.messageId,
        checksum: source.rawChecksum,
        phase: "fenced",
        plan: {
          originOperationId: input.callId,
          objectKeys,
          screenshotRefs,
          retiredRunIds,
          successors: [],
        },
      });
    await getDb(transactionDb)
      .update(run)
      .set({
        retiredAt: now,
        retirementReason: "unrelated_source",
      })
      .where(
        and(
          inArray(
            run.id,
            retiredRunIds.map((runId) => runEntityId.parse(runId)),
          ),
          isNull(run.retiredAt),
        ),
      );
    await getDb(transactionDb)
      .update(run)
      .set({ status: "needs_review", endedAt: now, dispatchError: null })
      .where(
        and(
          inArray(
            run.id,
            retiredRunIds.map((runId) => runEntityId.parse(runId)),
          ),
          inArray(run.status, [...ACTIVE_RUN_STATUSES]),
        ),
      );
    return {
      receiptId: id,
      retiredRunIds,
      reason: "unrelated_source" as const,
    };
  });
}

/** The host must check this external receipt before SDK initialization or disposal. */
export async function authorizeResearchCoordinatorRetirement(
  db: Database,
  input: { runId: string; receiptId: string },
) {
  // includes-deleted: this authorizes physical retirement only, never source reads or replay.
  const [scope] = await getDb(db)
    .select({
      id: run.id,
      ledgerPartyId: run.ledgerPartyId,
      retiredAt: run.retiredAt,
      retirementReason: run.retirementReason,
    })
    .from(run)
    .innerJoin(
      ledgerParty,
      and(
        eq(ledgerParty.id, run.ledgerPartyId),
        eq(ledgerParty.userId, run.actorUserId),
        eq(ledgerParty.kind, "member"),
      ),
    )
    .where(eq(run.id, runEntityId.parse(input.runId)));
  if (!scope?.ledgerPartyId)
    throw new Error("Retirement receipt requires its owning member Run.");
  const [receipt] = await getDb(db)
    .select()
    .from(researchRetention)
    .where(
      and(
        eq(researchRetention.id, input.receiptId),
        eq(researchRetention.ledgerPartyId, scope.ledgerPartyId),
      ),
    );
  if (
    !scope.retiredAt ||
    scope.retirementReason !== "unrelated_source" ||
    !receipt?.plan.retiredRunIds.includes(scope.id)
  )
    throw new Error(
      "Coordinator retirement is not authorized by this cleanup receipt.",
    );
  return { runId: parseEntityId("run", scope.id), receiptId: receipt.id };
}

export type ResearchRetentionPorts = {
  deleteObject(key: string): Promise<void>;
  retireCoordinator(input: {
    runId: string;
    receiptId: string;
  }): Promise<{ disposed: boolean }>;
  forgetBrowserRun(input: { runId: string; receiptId: string }): Promise<void>;
  deleteScreenshot?(input: {
    runId: string;
    imageRef: string;
    receiptId: string;
  }): Promise<{ disposition: "deleted" | "preserved" }>;
  transferUnfinished(input: {
    runId: string;
    receiptId: string;
    excludedSourceId: string;
  }): Promise<readonly string[]>;
};

async function readReceipt(db: Database, receiptId: string) {
  const [receipt] = await getDb(db)
    .select()
    .from(researchRetention)
    .where(eq(researchRetention.id, receiptId));
  if (!receipt) throw new Error("Research cleanup receipt not found.");
  await authorizeResearchCoordinatorRetirement(db, {
    runId: receipt.runId,
    receiptId,
  });
  return receipt;
}

async function eraseDisposableHistory(
  db: Database,
  receipt: typeof researchRetention.$inferSelect,
) {
  const client = getDb(db);
  const ids = receipt.plan.retiredRunIds.map((id) => runEntityId.parse(id));
  const keptEvidence = await preservedEvidenceIds(db, receipt.ledgerPartyId);
  const evidence = await client
    .select()
    .from(runEvidence)
    .where(inArray(runEvidence.runId, ids));
  const disposableEvidence = evidence.filter(
    (item) => !keptEvidence.has(item.id),
  );
  if (disposableEvidence.length)
    await client.delete(runEvidence).where(
      inArray(
        runEvidence.id,
        disposableEvidence.map((item) => item.id),
      ),
    );
  const targets = await client
    .select()
    .from(runTarget)
    .where(inArray(runTarget.runId, ids));
  if (targets.length)
    await client
      .update(runFactEvidence)
      .set({ support: null, supportRetiredAt: new Date() })
      .where(
        and(
          inArray(
            runFactEvidence.targetId,
            targets.map((target) => target.id),
          ),
          isNull(runFactEvidence.supportRetiredAt),
        ),
      );
  const events = await client
    .select({ event: orderMailEvent })
    .from(orderMailEvent)
    .innerJoin(orderMail, eq(orderMail.id, orderMailEvent.orderMailId))
    .where(eq(orderMail.ledgerPartyId, receipt.ledgerPartyId));
  const retainedEventSupport = z.object({
    researchRunId: z.uuid(),
    workRef: z.uuid(),
  });
  for (const { event } of events) {
    const support = retainedEventSupport.safeParse(event.payload);
    if (
      !support.success ||
      !ids.includes(runEntityId.parse(support.data.researchRunId))
    )
      continue;
    await client
      .update(orderMailEvent)
      .set({
        payload: {
          ...support.data,
          supportRetiredAt: new Date().toISOString(),
        },
      })
      .where(eq(orderMailEvent.id, event.id));
  }
  const prepared = await client
    .select({ id: importPreparedOrder.id })
    .from(importPreparedOrder)
    .where(inArray(importPreparedOrder.runId, ids));
  if (prepared.length)
    await client.delete(importPreparedLine).where(
      inArray(
        importPreparedLine.preparedOrderId,
        prepared.map((item) => item.id),
      ),
    );
  await client
    .delete(importPreparedOrder)
    .where(inArray(importPreparedOrder.runId, ids));
  await client.delete(runOperation).where(inArray(runOperation.runId, ids));
  await client.delete(runProgress).where(inArray(runProgress.runId, ids));
  await client
    .delete(runOrderCandidate)
    .where(inArray(runOrderCandidate.runId, ids));
  await client.delete(runApproval).where(inArray(runApproval.runId, ids));
  await client.delete(runFinding).where(inArray(runFinding.runId, ids));
  // Committed photo groups name canonical records; their generated proposals are disposable.
  await client
    .delete(photoGroupProposal)
    .where(inArray(photoGroupProposal.runId, ids));
  await client
    .update(runTarget)
    .set({ warning: null, diff: null, deviceWorkError: null })
    .where(inArray(runTarget.runId, ids));
  await client
    .update(runTarget)
    .set({
      state: "skipped",
      outcome: "skipped",
      warning: "Coordinator retired after unrelated source.",
      completedAt: new Date(),
    })
    .where(
      and(
        inArray(runTarget.runId, ids),
        inArray(runTarget.state, ["pending", "prepared", "needs_evidence"]),
      ),
    );
  await client
    .update(run)
    .set({
      input: null,
      progress: null,
      notes: null,
      historyCursorUrl: null,
      dispatchError: null,
      agentSessionId: null,
    })
    .where(inArray(run.id, ids));
  const [source] = await client
    .select()
    .from(orderMail)
    .where(eq(orderMail.id, receipt.orderMailId))
    .for("update");
  if (source) {
    if (source.rawChecksum !== receipt.checksum)
      throw new Error(
        "Retired source changed before cleanup; retained bytes require reconciliation.",
      );
    await assertNoPositiveSource(db, source);
    const decisions = await client
      .select({ eventId: orderMailCandidateDecision.eventId })
      .from(orderMailCandidateDecision)
      .innerJoin(
        orderMailEvent,
        eq(orderMailEvent.id, orderMailCandidateDecision.eventId),
      )
      .where(eq(orderMailEvent.orderMailId, source.id));
    await client
      .delete(orderMailAttachment)
      .where(eq(orderMailAttachment.orderMailId, source.id));
    await client
      .update(mailboxMessage)
      .set({
        classification: "unrelated",
        status: "completed",
        orderMailId: null,
        runId: null,
      })
      .where(
        and(
          eq(mailboxMessage.ledgerPartyId, receipt.ledgerPartyId),
          eq(mailboxMessage.mailboxId, receipt.mailboxId),
          eq(mailboxMessage.messageId, receipt.messageId),
          eq(mailboxMessage.checksum, receipt.checksum),
        ),
      );
    if (decisions.length) {
      const preservedEventIds = decisions.map((decision) => decision.eventId);
      const events = await client
        .select()
        .from(orderMailEvent)
        .where(eq(orderMailEvent.orderMailId, source.id));
      const disposableEvents = events.filter(
        (event) => !preservedEventIds.includes(event.id),
      );
      if (disposableEvents.length)
        await client.delete(orderMailEvent).where(
          inArray(
            orderMailEvent.id,
            disposableEvents.map((event) => event.id),
          ),
        );
      await client
        .update(orderMailEvent)
        .set({
          event: "unrelated",
          orderId: null,
          amount: null,
          currency: null,
          occurredAt: null,
          payload: {},
        })
        .where(inArray(orderMailEvent.id, preservedEventIds));
      for (const eventId of preservedEventIds)
        await client
          .update(orderMailEvent)
          .set({ sourceKey: eventId })
          .where(eq(orderMailEvent.id, eventId));
      await client
        .update(orderMail)
        .set({
          sender: "",
          subject: "",
          receivedAt: null,
          threadId: null,
          historyId: null,
          content: { snippet: null, bodyText: null, bodyHtml: null },
        })
        .where(eq(orderMail.id, source.id));
    } else {
      await client
        .delete(orderMailEvent)
        .where(eq(orderMailEvent.orderMailId, source.id));
      await client.delete(orderMail).where(eq(orderMail.id, source.id));
    }
  }
}

async function transferredRunWork(
  db: Database,
  ledgerPartyId: typeof researchRetention.$inferSelect.ledgerPartyId,
  runId: string,
) {
  const receipts = await getDb(db)
    .select({ plan: researchRetention.plan })
    .from(researchRetention)
    .where(
      and(
        eq(researchRetention.ledgerPartyId, ledgerPartyId),
        sql`${researchRetention.plan}->'retiredRunIds' @> ${JSON.stringify([runId])}::jsonb`,
      ),
    );
  const outcomes = receipts.flatMap(({ plan }) =>
    plan.retiredRunIds.includes(runId)
      ? plan.successors.filter((entry) => entry.runId === runId)
      : [],
  );
  const first = outcomes[0];
  if (!first) return undefined;
  const fingerprint = JSON.stringify([...first.successorRunIds].sort());
  if (
    outcomes.some(
      (entry) =>
        JSON.stringify([...entry.successorRunIds].sort()) !== fingerprint,
    )
  )
    throw new Error(
      "Retired Run has conflicting unfinished-work dispositions.",
    );
  return first.successorRunIds;
}

/** Existing queue redelivery advances this receipt; every port is keyed for idempotent replay. */
export async function processResearchRetention(
  db: Database,
  receiptId: string,
  ports: ResearchRetentionPorts,
) {
  let receipt = await readReceipt(db, receiptId);
  if (receipt.phase === "completed") return { completed: true };
  if (receipt.phase === "fenced") {
    for (const key of receipt.plan.objectKeys) await ports.deleteObject(key);
    for (const screenshot of receipt.plan.screenshotRefs) {
      if (!ports.deleteScreenshot)
        throw new Error("Research screenshot disposal capability unavailable.");
      z.object({ disposition: z.enum(["deleted", "preserved"]) }).parse(
        await ports.deleteScreenshot({ ...screenshot, receiptId }),
      );
    }
    for (const runId of receipt.plan.retiredRunIds)
      await ports.forgetBrowserRun({ runId, receiptId });
    await getDb(db)
      .update(researchRetention)
      .set({
        phase: "objects_deleted",
        plan: { ...receipt.plan, objectKeys: [], screenshotRefs: [] },
      })
      .where(
        and(
          eq(researchRetention.id, receiptId),
          eq(researchRetention.phase, "fenced"),
        ),
      );
    receipt = await readReceipt(db, receiptId);
  }
  if (receipt.phase === "objects_deleted") {
    for (const runId of receipt.plan.retiredRunIds) {
      const result = await ports.retireCoordinator({ runId, receiptId });
      if (!result.disposed)
        throw new Error(
          "Coordinator disposal awaits cold storage deletion acknowledgement.",
        );
    }
    await getDb(db)
      .update(researchRetention)
      .set({ phase: "coordinators_destroyed" })
      .where(
        and(
          eq(researchRetention.id, receiptId),
          eq(researchRetention.phase, "objects_deleted"),
        ),
      );
    receipt = await readReceipt(db, receiptId);
  }
  if (receipt.phase === "coordinators_destroyed") {
    for (const runId of receipt.plan.retiredRunIds) {
      if (receipt.plan.successors.some((entry) => entry.runId === runId))
        continue;
      // includes-deleted: dispose its source caches without recreating member-deleted work.
      const [scope] = await getDb(db)
        .select({
          status: run.status,
          failureCode: run.failureCode,
          deletedAt: run.deletedAt,
        })
        .from(run)
        .where(eq(run.id, runEntityId.parse(runId)));
      if (!scope) throw new Error("Retired transfer Run is unavailable.");
      const preserveStop =
        scope.deletedAt !== null ||
        scope.status === "completed" ||
        scope.failureCode === "user_cancelled" ||
        scope.failureCode === "dispatch_aborted";
      // Source receipts share a Run's disposition, including an empty result.
      // Later receipts must not reinterpret its already-erased task descriptors.
      const transferred = await transferredRunWork(
        db,
        receipt.ledgerPartyId,
        runId,
      );
      const successorRunIds = z.array(z.uuid()).parse(
        transferred ??
          (preserveStop
            ? []
            : await ports.transferUnfinished({
                runId,
                receiptId,
                excludedSourceId: receipt.orderMailId,
              })),
      );
      await withTransactionDatabase(db, async (transactionDb) => {
        const [current] = await getDb(transactionDb)
          .select()
          .from(researchRetention)
          .where(eq(researchRetention.id, receiptId))
          .for("update");
        if (
          !current ||
          current.phase !== "coordinators_destroyed" ||
          current.plan.successors.some((entry) => entry.runId === runId)
        )
          return;
        const canonical = await transferredRunWork(
          transactionDb,
          current.ledgerPartyId,
          runId,
        );
        await getDb(transactionDb)
          .update(researchRetention)
          .set({
            plan: {
              ...current.plan,
              successors: [
                ...current.plan.successors,
                { runId, successorRunIds: canonical ?? successorRunIds },
              ],
            },
          })
          .where(eq(researchRetention.id, receiptId));
      });
      receipt = await readReceipt(db, receiptId);
    }
    await withTransactionDatabase(db, async (transactionDb) => {
      const [current] = await getDb(transactionDb)
        .select()
        .from(researchRetention)
        .where(eq(researchRetention.id, receiptId))
        .for("update");
      if (!current || current.phase !== "coordinators_destroyed") return;
      if (
        current.plan.retiredRunIds.some(
          (runId) =>
            !current.plan.successors.some((entry) => entry.runId === runId),
        )
      )
        throw new Error("Research cleanup awaits unfinished work transfer.");
      await eraseDisposableHistory(transactionDb, current);
      await getDb(transactionDb)
        .update(researchRetention)
        .set({ phase: "completed", completedAt: new Date() })
        .where(eq(researchRetention.id, receiptId));
    });
  }
  return {
    completed: (await readReceipt(db, receiptId)).phase === "completed",
  };
}
