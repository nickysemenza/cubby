import { buildActorContext } from "@cubby/schemas/context";
import { and, eq, inArray, isNull } from "drizzle-orm";

import { PENDING_AI_STATES } from "~/server/ai/repo/ai-evaluation-requests";
import type { Database } from "~/server/db";
import { getDb, withTransactionDatabase } from "~/server/db/helpers";
import { job } from "~/server/db/retained-tables";
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
      snapshot.decisionModelOverride,
    );
    const targets = await getDb(db)
      .select({ id: aiEvaluation.id })
      .from(aiEvaluationRequest)
      .innerJoin(
        aiEvaluation,
        eq(aiEvaluation.id, aiEvaluationRequest.evaluationId),
      )
      .where(eq(aiEvaluationRequest.runId, id));
    for (const target of targets) {
      await withTransactionDatabase(db, async (tx) => {
        const [execution] = await getDb(tx)
          .select()
          .from(job)
          .where(eq(job.key, `ai-evaluation:${target.id}`))
          .for("update");
        // Existing work may have another requester or already be stopped.
        // This continuation never revives it or replaces its attempt owner.
        if (execution?.state !== "queued") return;
        const [deferred] = await getDb(tx)
          .update(aiEvaluation)
          .set({ state: "retry_wait" })
          .where(
            and(
              eq(aiEvaluation.id, target.id),
              eq(aiEvaluation.state, "queued"),
              eq(aiEvaluation.runId, id),
            ),
          )
          .returning({ id: aiEvaluation.id });
        if (deferred)
          await getDb(tx)
            .update(job)
            .set({
              availableAt: new Date(Date.now() + 5 * 60_000),
              updatedAt: new Date(),
            })
            .where(eq(job.id, execution.id));
      });
    }
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
      snapshot.decisionModelOverride,
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
