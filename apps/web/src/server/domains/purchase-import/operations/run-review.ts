/**
 * Run settlement and stop-for-review. Both run the required import audit,
 * a model call (`agents/extract`), before they commit, so they compose the
 * run-service repo with the audit here rather than inside the repo.
 */
import { buildActorContext } from "@cubby/schemas/context";
import {
  parseEntityId,
  purchaseId,
  runEntityId,
} from "@cubby/schemas/identifiers";
import { runPurpose } from "@cubby/schemas/purchase-import";
import { runProgressEvent, runProgressStamp } from "@cubby/schemas/run-fields";
import { ACTIVE_RUN_STATUSES } from "@cubby/shared/client-constants";
import { sha256Hex } from "@cubby/shared/sha256";
import {
  and,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  ne,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import { getDb, withTransaction } from "~/server/db/helpers";
import {
  auditLog,
  photoGroupProposal,
  run as runTable,
  runApproval,
  runFinding,
  runOperation,
  photoRunImage,
} from "~/server/db/schema";
import { WORKFLOW_RUN_PURPOSES } from "~/server/workflows/runs/contract";

import { loadPurchaseAuditBatch } from "../repo/audit-batch";
import { resolveRunFinding } from "../repo/findings";
import { readMailRunSources } from "../repo/mail-run-membership";
import {
  loadRunScope,
  STALE_RUN_MS,
  APPROVAL_WAKE_DECISION,
  assertRunActive,
  markRunFailed,
} from "../repo/run-service";

/**
 * Whether the server issued a wake the reporting agent has not received: the
 * current dispatch generation or a member's approval decision. Each is a
 * queue event that resumes the conversation,
 * so the stop the settled submission reported is not where the run ends.
 * Event ids, not clocks: the two Workers' clocks are not comparable.
 */
async function unreceivedWake(
  db: Database,
  scope: Awaited<ReturnType<typeof loadRunScope>>,
  received: ReadonlySet<string>,
): Promise<boolean> {
  const runId = scope.public.runId;
  if (
    scope.public.dispatchEventId &&
    !received.has(scope.public.dispatchEventId)
  )
    return true;
  const decided = await getDb(db)
    .select({ id: runApproval.id, state: runApproval.state })
    .from(runApproval)
    .where(
      and(
        eq(runApproval.runId, runId),
        inArray(runApproval.state, [...APPROVAL_WAKE_DECISION.keys()]),
      ),
    );
  for (const { id, state } of decided) {
    const decision = APPROVAL_WAKE_DECISION.get(state);
    if (!received.has(`approval:${id}:${decision}`)) return true;
  }
  return false;
}

/**
 * A run still `running` after its agent submission settled means the
 * coordinator stopped without a terminal tool call: a `review` progress
 * report, a turn budget, or a model that simply ended its turn. The
 * legitimate ways to settle while running are a wake the agent has not
 * received yet (`unreceivedWake`) and photo groups awaiting a household
 * review, so those cases are left alone.
 * A pending approval never reaches here: it moves the run to
 * `paused_approval` first.
 */
async function reconcileSettledRunOnce(
  db: Database,
  input: {
    runId: string;
    operationId: string;
    generation: string | null;
    sequence?: number;
    detail?: string;
    /**
     * Every queue event id the reporting agent has received; absent for the
     * stale-run sweep, which reconciles regardless.
     */
    receivedEventIds?: ReadonlySet<string>;
    /** The settled submission went unanswered: fail the run instead. */
    failure?: {
      failureCode: "agent_failed" | "agent_aborted";
      detail?: string;
    };
  },
) {
  const scope = await loadRunScope(db, input.runId);
  const stamp = input.receivedEventIds
    ? runProgressStamp.parse({
        generation: input.generation,
        sequence: input.sequence,
      })
    : null;
  if (scope.public.dispatchEventId !== input.generation)
    return { reconciled: false as const, status: scope.public.status };
  if (scope.public.status !== "running")
    return { reconciled: false as const, status: scope.public.status };
  if (
    input.receivedEventIds &&
    (await unreceivedWake(db, scope, input.receivedEventIds))
  )
    return { reconciled: false as const, status: "running" as const };
  if (input.failure) {
    const { failed } = await markRunFailed(db, {
      runId: input.runId,
      ...input.failure,
      dispatchEventId: input.generation,
    });
    return failed
      ? { reconciled: true as const, status: "failed" as const }
      : {
          reconciled: false as const,
          status: (await loadRunScope(db, input.runId)).public.status,
        };
  }
  if (scope.public.purpose === "photo_inventory") {
    const awaitingPhotoReview = await withTransaction(db, async (tx) => {
      const [locked] = await tx
        .select({ run: runTable })
        .from(runTable)
        .where(eq(runTable.id, scope.public.runId))
        .for("update");
      if (
        locked?.run.status !== "running" ||
        locked.run.dispatchEventId !== input.generation
      )
        return false;
      const [proposal] = await tx
        .select({ id: photoGroupProposal.id })
        .from(photoGroupProposal)
        .where(
          and(
            eq(photoGroupProposal.runId, scope.public.runId),
            eq(photoGroupProposal.state, "proposed"),
          ),
        )
        .limit(1);
      if (!proposal) return false;
      if (!locked.run.liveProgress?.awaitingApproval && stamp) {
        const eventId = `photo-review-handoff:${input.operationId}`;
        const previous = locked.run.liveProgress;
        const ids = locked.run.progressEventIds ?? [];
        if (
          !ids.includes(eventId) &&
          (previous?.generation !== stamp.generation ||
            previous.sequence < stamp.sequence)
        ) {
          const now = new Date();
          const event = runProgressEvent.parse({
            ...stamp,
            eventId,
            phase: "awaiting_approval",
            currentItem: "Review proposed photo groups",
            awaitingApproval: true,
            detail: "Photo groups are ready for human review",
            createdAt: now.toISOString(),
          });
          await tx
            .update(runTable)
            .set({
              liveProgress: event,
              progressHistory: [
                ...(locked.run.progressHistory ?? []),
                event,
              ].slice(-100),
              progressEventIds: [...ids, eventId],
              heartbeatAt: now,
            })
            .where(eq(runTable.id, scope.public.runId));
        }
      }
      return true;
    });
    if (awaitingPhotoReview)
      return { reconciled: false as const, status: "running" as const };
  }
  // A Mail import has no explicit finish tool: once every admitted Email is
  // imported, linked or disposed of, Pi's settled submission completes it.
  // Without this every fully resolved Mail import ended in needs_review.
  if (scope.public.purpose === "mail_import") {
    const completed = await withTransaction(db, async (tx) => {
      const [locked] = await tx
        .select({
          status: runTable.status,
          generation: runTable.dispatchEventId,
        })
        .from(runTable)
        .where(eq(runTable.id, scope.public.runId))
        .for("update");
      if (
        locked?.status !== "running" ||
        locked.generation !== input.generation
      )
        return false;
      const sources = await readMailRunSources(tx, scope.public.runId);
      if (
        !sources.length ||
        sources.some(
          (source) =>
            !source.owned ||
            !source.unchanged ||
            source.email.status !== "completed",
        )
      )
        return false;
      await tx
        .update(runTable)
        .set({
          status: "completed",
          endedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(runTable.id, scope.public.runId));
      return true;
    });
    if (completed)
      return { reconciled: true as const, status: "completed" as const };
  }
  await stopRunForReview(db, {
    runId: input.runId,
    operationId: input.operationId,
    kind: "other",
    dispatchEventId: input.generation,
    summary: input.detail ?? "Coordinator ended without finishing the run",
  });
  const settledStatus = (await loadRunScope(db, input.runId)).public.status;
  return {
    reconciled: settledStatus === "needs_review",
    status: settledStatus,
  };
}

/**
 * Cron backstop for the reconcile above: a settled event can be lost, and a
 * coordinator can stall inside a submission. Activity is the newest of the
 * run row, its operations and its progress reports so a slow but live agent
 * is not cut off.
 */
export async function expireStaleRuns(db: Database, now = new Date()) {
  const cutoff = new Date(now.getTime() - STALE_RUN_MS);
  const stale = await getDb(db)
    .select({ id: runTable.id, generation: runTable.dispatchEventId })
    .from(runTable)
    .where(
      and(
        eq(runTable.status, "running"),
        lt(runTable.updatedAt, cutoff),
        // A Workflow owns these Runs, and one may sleep through a rate limit;
        // `reconcileWorkflowRuns` checks their instance instead.
        notInArray(runTable.purpose, [...WORKFLOW_RUN_PURPOSES]),
        // Unstarted photo runs may sit between native upload sessions. Once
        // dispatched, they get the same stalled-coordinator backstop; review
        // proposals are preserved by reconcileSettledRun.
        or(
          ne(runTable.purpose, runPurpose.enum.photo_inventory),
          isNotNull(runTable.coordinatorStartedAt),
        ),
        sql`NOT EXISTS (SELECT 1 FROM ${runOperation} WHERE ${runOperation.runId} = ${runTable.id} AND ${runOperation.startedAt} >= ${cutoff})`,
        or(isNull(runTable.heartbeatAt), lt(runTable.heartbeatAt, cutoff)),
      ),
    );
  let expired = 0;
  const failures: Array<{ runId: string; error: string }> = [];
  for (const run of stale) {
    // One run's review path can fail on a provider call (the required audit
    // pass); that must not abort the tick for every other run or the offline
    // expiry that shares it. The next tick retries.
    try {
      const outcome = await reconcileSettledRun(db, {
        runId: run.id,
        operationId: `stale-run:${now.toISOString()}`,
        generation: run.generation,
        detail: "No coordinator activity for two hours",
      });
      if (outcome.reconciled) expired += 1;
    } catch (error) {
      failures.push({
        runId: run.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { expired, failures };
}

export async function auditImportBatch(
  db: Database,
  input: {
    runId: string;
    operationId: string;
    offset: number;
    /** A stop for review audits a paused run's writes before it ends. */
    allowPaused?: boolean;
  },
  assessor?: typeof import("~/server/domains/purchase-import/operations/agents/extract").auditPurchaseImportBatch,
) {
  const scope = await loadRunScope(db, input.runId);
  if (
    !input.allowPaused ||
    !ACTIVE_RUN_STATUSES.some((status) => status === scope.public.status)
  )
    assertRunActive(scope.public.status);
  if (!scope.actorUserId) throw new Error("Import run actor is unavailable");
  const runId = runEntityId.parse(input.runId);
  const renderedBatch = await loadPurchaseAuditBatch(
    db,
    runId,
    z.number().int().nonnegative().parse(input.offset),
  );
  if (renderedBatch.length === 0) return { findings: 0, nextOffset: null };
  const purchaseIds = renderedBatch.map(({ id }) => id);
  const writablePurchases = new Set(
    (
      await getDb(db)
        .selectDistinct({ id: auditLog.entityId })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.runId, runId),
            eq(auditLog.entityKind, "purchase"),
            inArray(auditLog.entityId, purchaseIds),
          ),
        )
    ).map((row) => row.id),
  );
  const auditBatch =
    assessor ??
    (await import("~/server/domains/purchase-import/operations/agents/extract"))
      .auditPurchaseImportBatch;
  const audit = await auditBatch({
    db,
    runId: input.runId,
    renderedBatch,
  });
  const actor = buildActorContext(scope.actorUserId, "mcp", {
    runId: runEntityId.parse(input.runId),
  });
  const batchExpenseIds = new Set(
    renderedBatch.flatMap((purchaseRow) =>
      purchaseRow.expenses.map((expenseRow) => expenseRow.id),
    ),
  );
  let stored = 0;
  // Retry lineage admits inspection, never a fix on predecessor-only writes.
  const findings = audit.findings
    .filter((finding) =>
      purchaseIds.includes(purchaseId.parse(finding.targetPurchaseId)),
    )
    .map((finding) => {
      const fix = finding.proposedFix;
      const target = renderedBatch.find(
        (row) => row.id === finding.targetPurchaseId,
      );
      const matchesTarget =
        fix?.kind === "relink_product"
          ? target?.expenses.some((row) => row.id === fix.expenseId)
          : fix &&
            "purchaseId" in fix &&
            fix.purchaseId === finding.targetPurchaseId;
      return {
        ...finding,
        proposedFix:
          writablePurchases.has(finding.targetPurchaseId) && matchesTarget
            ? fix
            : null,
      };
    });
  for (const finding of findings) {
    const proposedFix = finding.proposedFix;
    const relinkExpenseId =
      proposedFix?.kind === "relink_product" ? proposedFix.expenseId : null;
    if (
      relinkExpenseId &&
      !batchExpenseIds.has(parseEntityId("expense", relinkExpenseId))
    )
      continue;
    const evidenceFingerprint = await sha256Hex(JSON.stringify(finding));
    const [inserted] = await getDb(db)
      .insert(runFinding)
      .values({
        runId: runId,
        ledgerPartyId: scope.ledgerPartyId,
        entityKind: relinkExpenseId ? "expense" : "purchase",
        entityId: relinkExpenseId ?? finding.targetPurchaseId,
        kind: finding.kind,
        summary: finding.summary,
        proposedFix: proposedFix,
        evidenceFingerprint,
        probability: finding.probability,
      })
      .onConflictDoNothing()
      .returning({ id: runFinding.id });
    if (!inserted) continue;
    stored += 1;
    if (finding.probability >= 0.95 && proposedFix?.kind === "relink_product") {
      try {
        await resolveRunFinding(
          db,
          { id: inserted.id, action: "apply" },
          actor,
        );
      } catch (error) {
        const detail =
          error instanceof Error ? error.message : "Automated fix was refused";
        await getDb(db)
          .update(runFinding)
          .set({
            summary: `${finding.summary} Auto-fix refused: ${detail}`.slice(
              0,
              1_000,
            ),
            proposedFix: null,
            updatedAt: new Date(),
          })
          .where(eq(runFinding.id, inserted.id));
      }
    }
  }
  return {
    findings: stored,
    nextOffset: renderedBatch.length === 25 ? input.offset + 25 : null,
  };
}

/** Server-side finalization guard: every run mutation is audited in pages of 25. */
export async function auditAllImportBatches(
  db: Database,
  input: { runId: string; operationId: string; allowPaused?: boolean },
) {
  let offset = 0;
  let findings = 0;
  while (true) {
    const page = await auditImportBatch(db, {
      ...input,
      operationId: `${input.operationId}:${offset}`,
      offset,
    });
    findings += page.findings;
    if (page.nextOffset === null) return { findings };
    offset = page.nextOffset;
  }
}

async function stopRunForReviewOnce(
  db: Database,
  input: {
    runId: string;
    operationId: string;
    kind: string;
    summary: string;
    dispatchEventId?: string | null;
  },
) {
  const scope = await loadRunScope(db, input.runId);
  const runId = runEntityId.parse(input.runId);
  const summary = z.string().trim().min(1).max(1_000).parse(input.summary);
  const kind = z
    .enum([
      "auth_required",
      "expected_order_not_found",
      "unclassified_vendor",
      "other",
    ])
    .parse(input.kind);
  // A paused run (its browser stuck on one step) is stopped too: refusing it
  // once left an agent retrying the same step for hours.
  if (
    scope.public.status !== "needs_review" &&
    !ACTIVE_RUN_STATUSES.some((status) => status === scope.public.status)
  )
    throw new Error(`Import run is fenced in status ${scope.public.status}`);
  const fingerprint = await sha256Hex(`${kind}:${summary}`);
  // Audit before stopping when possible; a successor inspects matching
  // unaudited predecessor writes if this required audit fails.
  if (scope.public.purpose === "account_sync")
    await auditAllImportBatches(db, {
      runId: input.runId,
      operationId: `${input.operationId}:required-audit`,
      allowPaused: true,
    });
  const auditedAt = new Date();
  return withTransaction(db, async (tx) => {
    const [current] = await tx
      .select({ generation: runTable.dispatchEventId })
      .from(runTable)
      .where(eq(runTable.id, runId))
      .for("no key update");
    if (
      input.dispatchEventId !== undefined &&
      current?.generation !== input.dispatchEventId
    )
      return { findingId: null };
    const [finding] = await tx
      .insert(runFinding)
      .values({
        runId: runId,
        ledgerPartyId: scope.ledgerPartyId,
        entityKind: "run",
        entityId: runId,
        kind,
        summary,
        evidenceFingerprint: fingerprint,
      })
      .onConflictDoNothing()
      .returning({ id: runFinding.id });
    const [existingFinding] = finding
      ? []
      : await tx
          .select({ id: runFinding.id })
          .from(runFinding)
          .where(
            and(
              eq(runFinding.runId, runId),
              eq(runFinding.entityKind, "run"),
              eq(runFinding.entityId, runId),
              eq(runFinding.kind, kind),
              eq(runFinding.evidenceFingerprint, fingerprint),
              eq(runFinding.status, "open"),
            ),
          )
          .limit(1);
    await tx
      .update(photoRunImage)
      .set({ state: "unresolved", outcome: null, updatedAt: new Date() })
      .where(
        and(
          eq(photoRunImage.runId, runId),
          inArray(photoRunImage.state, [
            "pending",
            "prepared",
            "needs_evidence",
          ]),
        ),
      );
    await tx
      .update(runTable)
      .set({
        status: "needs_review",
        auditedAt,
        endedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(runTable.id, runId),
          inArray(runTable.status, [...ACTIVE_RUN_STATUSES]),
        ),
      );
    return { findingId: finding?.id ?? existingFinding?.id ?? null };
  });
}

/**
 * Settle a coordinator submission. A photo Run's lifecycle moves with it (review ready or stopped), so
 * its Live Activity is pushed after the commit.
 */
export async function reconcileSettledRun(
  ...args: Parameters<typeof reconcileSettledRunOnce>
): ReturnType<typeof reconcileSettledRunOnce> {
  const outcome = await reconcileSettledRunOnce(...args);
  const { advancePhotoRunQuietly } =
    await import("~/server/domains/photo-import/repo/run/lifecycle");
  await advancePhotoRunQuietly(args[0], args[1].runId);
  return outcome;
}

/**
 * Stop a Run for member review. A photo Run's lifecycle moves with it (review ready or stopped), so
 * its Live Activity is pushed after the commit.
 */
export async function stopRunForReview(
  ...args: Parameters<typeof stopRunForReviewOnce>
): ReturnType<typeof stopRunForReviewOnce> {
  const outcome = await stopRunForReviewOnce(...args);
  const { advancePhotoRunQuietly } =
    await import("~/server/domains/photo-import/repo/run/lifecycle");
  await advancePhotoRunQuietly(args[0], args[1].runId);
  return outcome;
}
