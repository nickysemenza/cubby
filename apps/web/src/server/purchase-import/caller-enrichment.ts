import type { ActorContext } from "@cubby/schemas/context";
import { productShortcode, runShortcode } from "@cubby/schemas/identifiers";
import {
  callerEnrichmentNextOut,
  callerEnrichmentRunInput,
  finishCallerEnrichmentOut,
  runEvidenceKind,
  runStatus,
  skipCallerEnrichmentTargetInput,
  skipCallerEnrichmentTargetOut,
} from "@cubby/schemas/purchase-import";
import { sha256Hex } from "@cubby/shared/sha256";
import { and, count, eq } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import { run as runTable, runFinding, runTarget } from "~/server/db/schema";
import { getDb, withTransaction } from "~/server/repo/database-helpers";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";

import {
  claimNextImportWork,
  finishRun,
  loadRunScopeByShortcode,
  type PurchaseImportNamespace,
} from "./run-service";

/**
 * Caller-owned product enrichment: the member's own MCP client works the run
 * (next target, capture, commit or skip, finish) instead of a queued
 * coordinator. Every entry point here fences on the run's owner and its
 * `caller` execution mode; the commit writer and capture apply the same fence.
 */

/**
 * A caller-owned run never holds a vendor account, so the run services that
 * take the browser bridge never reach it; reaching it would be a bug.
 */
const noBrowserBridge: PurchaseImportNamespace = {
  getByName() {
    throw new Error("A caller-owned run has no browser bridge");
  },
};

/** The caller-owned run `runId` names, owned by `actor`. */
export async function loadCallerRun(
  db: Database,
  actor: ActorContext,
  runId: string,
) {
  const scope = await loadRunScopeByShortcode(db, runShortcode.parse(runId));
  if (scope.actorUserId !== actor.userId)
    throw new Error("Purchase import run is not owned by this member");
  if (scope.executionMode !== "caller")
    throw new Error(
      `${runId} is worked by its coordinator; only a caller-owned run takes caller actions`,
    );
  return scope;
}

export const assertCallerRunActive = (status: string) => {
  if (status !== "running")
    throw new Error(`Import run is fenced in status ${status}`);
};

const capturedPage = z.object({ sourceURL: z.string() });

/** The next pending target, from the same work selection a coordinator reads. */
export async function callerEnrichmentNext(
  db: Database,
  actor: ActorContext,
  rawInput: z.input<typeof callerEnrichmentRunInput>,
) {
  const input = callerEnrichmentRunInput.parse(rawInput);
  const scope = await loadCallerRun(db, actor, input.runId);
  const work = await claimNextImportWork(
    db,
    noBrowserBridge,
    scope.public.runId,
  );
  const base = {
    runId: input.runId,
    status: runStatus.parse(scope.public.status),
    allowedHosts: scope.public.allowedHosts,
  };
  if (work.kind === "none")
    return callerEnrichmentNextOut.parse({ ...base, next: null });
  if (work.kind !== "product_enrichment" || !("targetFingerprint" in work))
    throw new Error(`Caller-owned run has unexpected ${work.kind} work`);
  return callerEnrichmentNextOut.parse({
    ...base,
    next: {
      productId: productShortcode.parse(work.productId),
      productName: work.productName,
      targetFingerprint: work.targetFingerprint,
      startUrl: work.startUrl,
      evidence: work.evidence.map((evidence) => ({
        id: evidence.id,
        kind: runEvidenceKind.parse(evidence.kind),
        checksum: evidence.checksum,
        sourceUrl:
          capturedPage.safeParse(evidence.sourceMetadata).data?.sourceURL ??
          null,
      })),
    },
  });
}

/**
 * Close one pending target without a commit. `needs_review` leaves an open
 * finding naming the Product so the run ends in review; repeating the same
 * outcome answers again without a second finding.
 */
export async function skipCallerEnrichmentTarget(
  db: Database,
  actor: ActorContext,
  rawInput: z.input<typeof skipCallerEnrichmentTargetInput>,
) {
  const input = skipCallerEnrichmentTargetInput.parse(rawInput);
  const scope = await loadCallerRun(db, actor, input.runId);
  const productId = await resolveOrThrow(db, "product", input.productId);
  const state = input.outcome === "skipped" ? "skipped" : "unresolved";
  return withTransaction(db, async (tx) => {
    const [locked] = await tx
      .select({ status: runTable.status })
      .from(runTable)
      .where(eq(runTable.id, scope.public.runId))
      .for("update");
    assertCallerRunActive(locked?.status ?? "missing");
    const [target] = await tx
      .select({ id: runTarget.id, state: runTarget.state })
      .from(runTarget)
      .where(
        and(
          eq(runTarget.runId, scope.public.runId),
          eq(runTarget.entityId, productId),
        ),
      )
      .for("update");
    if (!target)
      throw new Error(`${input.productId} is not a target of this run`);
    const result = skipCallerEnrichmentTargetOut.parse({
      runId: input.runId,
      productId: input.productId,
      state,
    });
    if (target.state === state) return result;
    if (target.state !== "pending" && target.state !== "prepared")
      throw new Error(`${input.productId} is already ${target.state}`);
    await tx
      .update(runTarget)
      .set({
        state,
        outcome: state === "skipped" ? "skipped" : null,
        warning: input.reason,
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(runTarget.id, target.id));
    if (state === "unresolved")
      await tx
        .insert(runFinding)
        .values({
          runId: scope.public.runId,
          ledgerPartyId: scope.ledgerPartyId,
          entityKind: "run",
          entityId: scope.public.runId,
          kind: "other",
          summary: `${input.productId} needs review: ${input.reason}`,
          evidenceFingerprint: await sha256Hex(`caller-skip:${target.id}`),
        })
        .onConflictDoNothing();
    // Activity for the stale-run sweep, which reviews an abandoned run.
    await tx
      .update(runTable)
      .set({ updatedAt: new Date() })
      .where(eq(runTable.id, scope.public.runId));
    return result;
  });
}

/** Finish once every target is settled; a finished run answers its status again. */
export async function finishCallerEnrichment(
  db: Database,
  actor: ActorContext,
  rawInput: z.input<typeof callerEnrichmentRunInput>,
) {
  const input = callerEnrichmentRunInput.parse(rawInput);
  const scope = await loadCallerRun(db, actor, input.runId);
  if (
    scope.public.status !== "completed" &&
    scope.public.status !== "needs_review"
  )
    await finishRun(db, noBrowserBridge, {
      runId: scope.public.runId,
      operationId: "caller-finish",
    });
  const [run] = await getDb(db)
    .select({ status: runTable.status })
    .from(runTable)
    .where(eq(runTable.id, scope.public.runId));
  const [findings] = await getDb(db)
    .select({ value: count() })
    .from(runFinding)
    .where(
      and(
        eq(runFinding.runId, scope.public.runId),
        eq(runFinding.status, "open"),
      ),
    );
  return finishCallerEnrichmentOut.parse({
    runId: input.runId,
    status: run?.status,
    findingCount: findings?.value ?? 0,
  });
}
