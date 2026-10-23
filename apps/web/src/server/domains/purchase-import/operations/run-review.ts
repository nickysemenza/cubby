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
  type RunId,
} from "@cubby/schemas/identifiers";
import { runPurpose } from "@cubby/schemas/purchase-import";
import {
  runProgressEvent,
  runProgressStamp,
  runTargetOutcomeReceipt,
} from "@cubby/schemas/run-fields";
import { ACTIVE_RUN_STATUSES } from "@cubby/shared/client-constants";
import { countLabel } from "@cubby/shared/pluralize";
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

import type { Database, DrizzleClient, DrizzleTransaction } from "~/server/db";
import {
  getDb,
  withTransaction,
  withTransactionDatabase,
} from "~/server/db/helpers";
import {
  auditLog,
  photoGroupProposal,
  run as runTable,
  assessmentState,
  runOperation,
  photoRunImage,
} from "~/server/db/schema";
import {
  readMailRunSources,
  releaseUnsettledMailRunSources,
} from "~/server/domains/purchase-import/repo/mail-run-membership";
import { failOperationsForRun } from "~/server/domains/run/repo/run-operation";
import { transitionAssessmentStates } from "~/server/generic/assessment/repo/assessment-state";
import { recordChange } from "~/server/generic/changes/repo/change";
import { EXECUTED_RUN_PURPOSES } from "~/server/workflows/runs/contract";

import { loadPurchaseAuditBatch } from "../repo/audit-batch";
import { resolveRunFinding } from "../repo/findings";
import { publishRunFinding, runFindingData } from "../repo/run-finding";
import {
  loadRunScope,
  STALE_RUN_MS,
  assertRunActive,
  markRunFailed,
} from "../repo/run-service";

/**
 * Whether the server issued a wake the reporting agent has not received: the
 * current dispatch generation. It is a queue event that resumes the conversation,
 * so the stop the settled submission reported is not where the run ends.
 * Event ids, not clocks: the two Workers' clocks are not comparable.
 */
function unreceivedWake(
  scope: Awaited<ReturnType<typeof loadRunScope>>,
  received: ReadonlySet<string>,
): boolean {
  if (
    scope.public.dispatchEventId &&
    !received.has(scope.public.dispatchEventId)
  )
    return true;
  return false;
}

/**
 * A run still `running` after its agent submission settled means the
 * coordinator stopped without a terminal tool call: a `review` progress
 * report, a turn budget, or a model that simply ended its turn. The
 * legitimate ways to settle while running are a wake the agent has not
 * received yet (`unreceivedWake`) and photo groups awaiting a household
 * review, so those cases are left alone.
 */
async function reconcileSettledRunOnce(
  db: Database,
  input: {
    runId: string;
    operationId: string;
    generation: string | null;
    /** The activity window observed by stale recovery, rechecked at its terminal write. */
    staleBefore?: Date;
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
  if (input.receivedEventIds && unreceivedWake(scope, input.receivedEventIds))
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
        .for("no key update");
      if (
        locked?.run.status !== "running" ||
        locked.run.dispatchEventId !== input.generation ||
        !(await staleRunStillEligible(
          tx,
          scope.public.runId,
          input.staleBefore,
        ))
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
  // imported, linked, excluded or resolved unresolved, Pi's settled submission
  // completes it, or reviews it under one finding naming each unresolved
  // Email. Only an Email still being researched means the coordinator ended
  // without finishing.
  if (scope.public.purpose === "mail_import") {
    const settled = await withTransaction(db, async (tx) => {
      const [locked] = await tx
        .select({
          status: runTable.status,
          generation: runTable.dispatchEventId,
        })
        .from(runTable)
        .where(eq(runTable.id, scope.public.runId))
        .for("no key update");
      if (
        locked?.status !== "running" ||
        locked.generation !== input.generation ||
        !(await staleRunStillEligible(
          tx,
          scope.public.runId,
          input.staleBefore,
        ))
      )
        return false;
      const sources = await readMailRunSources(tx, scope.public.runId);
      if (
        !sources.length ||
        sources.some(
          (source) =>
            !source.owned ||
            !source.unchanged ||
            !SETTLED_MAIL_STATUSES.has(source.email.status),
        )
      )
        return null;
      const unresolved = sources.filter(
        (source) => source.email.status === "blocked",
      );
      if (unresolved.length)
        return {
          unresolved: unresolved.map(({ email }) => email),
          reasons: await unresolvedMailReasons(
            tx,
            scope.public.runId,
            unresolved.map(({ email }) => email.id),
          ),
        };
      await tx
        .update(runTable)
        .set({
          status: "completed",
          endedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(runTable.id, scope.public.runId));
      await recordChange(tx, { kind: "source", categories: ["email"] });
      return { unresolved: [], reasons: new Map<string, string>() };
    });
    if (settled && !settled.unresolved.length)
      return { reconciled: true as const, status: "completed" as const };
    if (settled) {
      await stopRunForReview(db, {
        runId: input.runId,
        operationId: input.operationId,
        kind: "unresolved_targets",
        dispatchEventId: input.generation,
        summary: unresolvedTargetsSummary(settled.unresolved, settled.reasons),
        staleBefore: input.staleBefore,
      });
      const status = (await loadRunScope(db, input.runId)).public.status;
      return { reconciled: status === "needs_review", status };
    }
  }
  await stopRunForReview(db, {
    runId: input.runId,
    operationId: input.operationId,
    kind: "other",
    dispatchEventId: input.generation,
    summary: input.detail ?? "Coordinator ended without finishing the run",
    staleBefore: input.staleBefore,
  });
  const settledStatus = (await loadRunScope(db, input.runId)).public.status;
  return {
    reconciled: settledStatus === "needs_review",
    status: settledStatus,
  };
}

/** The existing two-hour backstop excludes Workflow sleeps and undispatched native uploads. */
function staleRunWhere(cutoff: Date) {
  return and(
    eq(runTable.status, "running"),
    lt(runTable.updatedAt, cutoff),
    notInArray(runTable.purpose, [...EXECUTED_RUN_PURPOSES]),
    or(
      ne(runTable.purpose, runPurpose.enum.photo_inventory),
      isNotNull(runTable.coordinatorStartedAt),
    ),
    // Raw Date parameters use the host offset; stored timestamps are UTC wall time.
    sql`NOT EXISTS (SELECT 1 FROM ${runOperation} WHERE ${runOperation.runId} = ${runTable.id} AND ${runOperation.startedAt} >= ${cutoff.toISOString()}::timestamp)`,
    or(isNull(runTable.heartbeatAt), lt(runTable.heartbeatAt, cutoff)),
  );
}

/** A fresh statement after the Run lock sees activity committed while that lock waited. */
async function staleRunStillEligible(
  tx: DrizzleClient | DrizzleTransaction,
  runId: RunId,
  cutoff?: Date,
) {
  if (!cutoff) return true;
  const [current] = await tx
    .select({ id: runTable.id })
    .from(runTable)
    .where(and(eq(runTable.id, runId), staleRunWhere(cutoff)));
  return Boolean(current);
}

/**
 * Activity is the newest of the Run row, its operations and progress reports.
 * Agent settlement retains its Mail/photo review behavior; other abandoned
 * Runs fail without requiring an agent session or removing committed writes.
 */
export async function expireStaleRuns(db: Database, now = new Date()) {
  const cutoff = new Date(now.getTime() - STALE_RUN_MS);
  const stale = await getDb(db)
    .select({
      id: runTable.id,
      generation: runTable.dispatchEventId,
      agentSessionId: runTable.agentSessionId,
    })
    .from(runTable)
    .where(staleRunWhere(cutoff));
  let expired = 0;
  const failures: Array<{ runId: string; error: string }> = [];
  for (const run of stale) {
    try {
      const reconciled = run.agentSessionId
        ? (
            await reconcileSettledRun(db, {
              runId: run.id,
              operationId: `stale-run:${now.toISOString()}`,
              generation: run.generation,
              staleBefore: cutoff,
              detail: "No coordinator activity for two hours",
            })
          ).reconciled
        : await withTransactionDatabase(db, async (transactionDb) => {
            const database = getDb(transactionDb);
            const [locked] = await database
              .select({ generation: runTable.dispatchEventId })
              .from(runTable)
              .where(eq(runTable.id, run.id))
              .for("no key update");
            if (!locked || locked.generation !== run.generation) return false;
            const eligible = await staleRunStillEligible(
              database,
              run.id,
              cutoff,
            );
            if (!eligible) return false;
            const { failed } = await markRunFailed(transactionDb, {
              runId: run.id,
              failureCode: "agent_failed",
              dispatchEventId: run.generation,
              detail: "No Run activity for two hours",
            });
            if (failed)
              await failOperationsForRun(
                database,
                run.id,
                "No Run activity for two hours",
              );
            return failed;
          });
      if (reconciled) expired += 1;
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
    const inserted = await publishRunFinding(db, {
      runId: runId,
      ledgerPartyId: scope.ledgerPartyId,
      entityKind: relinkExpenseId ? "expense" : "purchase",
      entityId: relinkExpenseId ?? finding.targetPurchaseId,
      kind: finding.kind,
      summary: finding.summary,
      proposedFix: proposedFix,
      evidenceFingerprint,
      probability: finding.probability,
    });
    if (!inserted.created) continue;
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
        await transitionAssessmentStates(
          db,
          eq(assessmentState.id, inserted.id),
          (row) => ({
            data: {
              ...runFindingData.parse(row.data),
              summary: `${finding.summary} Auto-fix refused: ${detail}`.slice(
                0,
                1_000,
              ),
              proposedFix: null,
            },
          }),
          { kind: "run_finding_auto_fix_refused" },
        );
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

/** Admitted Email outcomes a settled Mail import accepts as final. */
const SETTLED_MAIL_STATUSES = new Set(["completed", "excluded", "blocked"]);

/** Pi's latest recorded reason for each unresolved Email, by Email id. */
async function unresolvedMailReasons(
  tx: DrizzleTransaction,
  runId: string,
  emailIds: readonly string[],
) {
  const rows = await tx
    .select({ result: runOperation.result })
    .from(runOperation)
    .where(
      and(
        eq(runOperation.runId, runEntityId.parse(runId)),
        eq(runOperation.kind, "target_outcome"),
      ),
    )
    .orderBy(runOperation.completedAt);
  const reasons = new Map<string, string>();
  for (const row of rows) {
    const parsed = runTargetOutcomeReceipt.safeParse(row.result);
    if (
      parsed.success &&
      parsed.data.target.warning &&
      emailIds.includes(parsed.data.target.entityId)
    )
      reasons.set(parsed.data.target.entityId, parsed.data.target.warning);
  }
  return reasons;
}

function unresolvedTargetsSummary(
  emails: readonly {
    id: string;
    shortcode: string;
    subject: string | null;
    messageId: string;
  }[],
  reasons: ReadonlyMap<string, string>,
) {
  const lines = emails.map(
    (email) =>
      `${email.shortcode} (${email.subject ?? email.messageId}): ${reasons.get(email.id) ?? "no reason recorded"}`,
  );
  const summary = `${countLabel(emails.length, "admitted Email")} unresolved; settle each with purchase_import.mail_resolve. ${lines.join("; ")}`;
  return summary.length > 1_000 ? `${summary.slice(0, 999)}…` : summary;
}

async function stopRunForReviewOnce(
  db: Database,
  input: {
    runId: string;
    operationId: string;
    kind: string;
    summary: string;
    dispatchEventId?: string | null;
    staleBefore?: Date;
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
      "unresolved_targets",
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
      .select({ generation: runTable.dispatchEventId, status: runTable.status })
      .from(runTable)
      .where(eq(runTable.id, runId))
      .for("no key update");
    if (
      !current ||
      (current.status !== "needs_review" &&
        !ACTIVE_RUN_STATUSES.some((status) => status === current.status)) ||
      (input.dispatchEventId !== undefined &&
        current.generation !== input.dispatchEventId) ||
      !(await staleRunStillEligible(tx, runId, input.staleBefore))
    )
      return { findingId: null };
    const finding = await publishRunFinding(tx, {
      runId: runId,
      ledgerPartyId: scope.ledgerPartyId,
      entityKind: "run",
      entityId: runId,
      kind,
      summary,
      proposedFix: null,
      evidenceFingerprint: fingerprint,
    });
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
    const [stopped] = await tx
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
      )
      .returning({ purpose: runTable.purpose, input: runTable.input });
    if (stopped)
      await recordChange(tx, { kind: "source", categories: ["run"] });
    // A Run without a roster (erased, or a legacy/manual Mail import) has no
    // Email to return, and stopping it for review must never fail on parsing one.
    if (stopped?.purpose === "mail_import" && stopped.input !== null)
      await releaseUnsettledMailRunSources(tx, runId);
    return { findingId: finding.open ? finding.id : null };
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
