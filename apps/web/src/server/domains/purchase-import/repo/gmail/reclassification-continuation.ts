import { buildActorContext } from "@cubby/schemas/context";
import { and, eq, inArray, isNull } from "drizzle-orm";

import { PENDING_AI_STATES } from "~/server/ai/repo/ai-evaluation-requests";
import type { Database } from "~/server/db";
import { getDb } from "~/server/db/helpers";
import {
  aiEvaluation,
  aiEvaluationRequest,
  email,
  run,
} from "~/server/db/schema";
import { ensureRun } from "~/server/domains/run/repo/ensure-run";

import {
  prepareReclassification,
  reclassificationSnapshot,
} from "./reclassification-work";

/** The old generation settles; linked, delayed demand keeps changing evidence from starving its roster. */
export async function continueChangedReclassification(
  db: Database,
  item: typeof aiEvaluation.$inferSelect,
  current: typeof email.$inferSelect,
) {
  const snapshot = reclassificationSnapshot.parse(item.snapshot);
  const requesters = await getDb(db)
    .select({ owner: run, receipt: aiEvaluationRequest.receipt })
    .from(aiEvaluationRequest)
    .innerJoin(run, eq(run.id, aiEvaluationRequest.runId))
    .where(
      and(
        eq(aiEvaluationRequest.evaluationId, item.id),
        isNull(aiEvaluationRequest.cancelledAt),
        inArray(run.status, ["running", "paused", "paused_auth"]),
        isNull(run.deletedAt),
        isNull(run.retiredAt),
      ),
    );
  const ids = [];
  for (const { owner } of requesters.filter(
    ({ owner }) => owner.status === "running",
  )) {
    const actor = buildActorContext(owner.actorUserId, owner.channel, {
      oauthClientId: owner.oauthClientId,
      deviceId: owner.deviceId,
    });
    const id = await ensureRun(db, actor, {
      purpose: "mail_reclassify",
      trigger: "manual",
      parentRunId: owner.id,
      cause: "evidence_changed",
      clientKey: `reclassify-evidence-continuation:${owner.id}:${item.id}`,
      input: {
        kind: "mail_reclassify",
        mode: "relevance",
        mailboxId: current.mailboxId,
        executionAuthorization: snapshot.executionAuthorization,
        emails: [{ emailId: current.id, checksum: current.checksum }],
      },
      progress: {
        kind: "mail_reclassification",
        version: 1,
        attempt: 0,
        complete: false,
        results: [],
      },
    });
    await prepareReclassification(
      db,
      id,
      [current],
      snapshot.executionAuthorization,
      snapshot.decisionModel,
    );
    const targets = await getDb(db)
      .select({ id: aiEvaluation.id })
      .from(aiEvaluationRequest)
      .innerJoin(
        aiEvaluation,
        eq(aiEvaluation.id, aiEvaluationRequest.evaluationId),
      )
      .where(eq(aiEvaluationRequest.runId, id));
    for (const target of targets)
      await getDb(db)
        .update(aiEvaluation)
        .set({
          state: "retry_wait",
          nextAttemptAt: new Date(Date.now() + 5 * 60_000),
        })
        .where(
          and(
            eq(aiEvaluation.id, target.id),
            eq(aiEvaluation.state, "queued"),
            eq(aiEvaluation.runId, id),
          ),
        );
    ids.push(id);
  }
  // Pausing one requester cannot discard its later demand or give another requester cancellation authority over it.
  for (const { owner, receipt } of requesters.filter(
    ({ owner }) => owner.status !== "running",
  )) {
    await prepareReclassification(
      db,
      owner.id,
      [current],
      snapshot.executionAuthorization,
      snapshot.decisionModel,
    );
    const [next] = await getDb(db)
      .select({ id: aiEvaluation.id })
      .from(aiEvaluationRequest)
      .innerJoin(
        aiEvaluation,
        eq(aiEvaluation.id, aiEvaluationRequest.evaluationId),
      )
      .where(
        and(
          eq(aiEvaluationRequest.runId, owner.id),
          inArray(aiEvaluation.state, PENDING_AI_STATES),
          eq(aiEvaluation.target, item.target),
        ),
      );
    if (!next)
      throw new Error(
        "Changed Email continuation has no retained requester demand",
      );
    await getDb(db)
      .update(aiEvaluationRequest)
      .set({
        receipt: {
          retainedReceipt: receipt,
          retryEvaluationId: next.id,
          continuationRunIds: ids,
        },
      })
      .where(
        and(
          eq(aiEvaluationRequest.runId, owner.id),
          eq(aiEvaluationRequest.evaluationId, item.id),
        ),
      );
  }
  return ids;
}
