import type { RunId } from "@cubby/schemas/identifiers";
import { sha256Hex } from "@cubby/shared/sha256";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import {
  run,
  runEvidence,
  runFactEvidence,
  runOperation,
  runTarget,
} from "~/server/db/schema";
import { notDeleted, withTransaction } from "~/server/repo/database-helpers";
import { executeAtomicOperation } from "~/server/runs/operation";

const jsonObject = z.record(z.string(), z.json());
const receipt = z.object({ settled: z.boolean(), next: jsonObject });
const activeWork = z.object({
  status: z.literal("working"),
  work: z.object({ workRef: z.uuid() }),
});

/** A final paragraph cannot abandon executable work or repeatedly extend it. */
export async function continueResearchWork(
  db: Database,
  input: { runId: RunId; callId: string; next: object },
) {
  const active = activeWork.safeParse(input.next);
  if (!active.success)
    return { settled: false, next: jsonObject.parse(input.next) };
  const workRef = active.data.work.workRef;
  return executeAtomicOperation(
    db,
    {
      runId: input.runId,
      operationId: input.callId,
      kind: "research_continue",
      payload: { workRef },
      subject: "Research continuation",
    },
    (ledger) =>
      withTransaction(db, async (tx) => {
        const replayed = await ledger.replay(tx, receipt);
        if (replayed) return replayed;
        const [scope] = await tx
          .select()
          .from(run)
          .where(and(eq(run.id, input.runId), notDeleted(run)))
          .for("update");
        if (
          !scope ||
          scope.retiredAt ||
          !["running", "paused_offline"].includes(scope.status)
        )
          throw new Error("Research continuation is no longer executable.");
        const [target] = await tx
          .select()
          .from(runTarget)
          .where(
            and(eq(runTarget.id, workRef), eq(runTarget.runId, input.runId)),
          )
          .for("update");
        if (
          !target ||
          !["pending", "prepared", "needs_evidence"].includes(target.state)
        )
          throw new Error("Research continuation task is no longer active.");
        const observations = await tx
          .selectDistinct({ checksum: runEvidence.checksum })
          .from(runEvidence)
          .where(eq(runEvidence.targetId, workRef));
        const claims = await tx
          .selectDistinct({
            entityKind: runFactEvidence.entityKind,
            entityId: runFactEvidence.entityId,
            field: runFactEvidence.fieldPath,
            value: runFactEvidence.valueFingerprint,
          })
          .from(runFactEvidence)
          .where(eq(runFactEvidence.targetId, workRef));
        const resolutions = await tx
          .select({ result: runOperation.result })
          .from(runOperation)
          .where(
            and(
              eq(runOperation.runId, input.runId),
              eq(runOperation.kind, "research_resolve_import"),
              eq(runOperation.state, "completed"),
              sql`${runOperation.result}->'attempt'->>'workRef' = ${workRef}`,
            ),
          );
        const identities = resolutions.flatMap(({ result }) => {
          const saved = z
            .object({
              purchaseIds: z.array(z.uuid()),
              productIds: z.array(z.uuid()),
              eventIds: z.array(z.uuid()),
            })
            .parse(result);
          return [...saved.purchaseIds, ...saved.productIds, ...saved.eventIds];
        });
        // IDs for observations/operations and read timestamps are not progress.
        const progressFingerprint = await sha256Hex(
          JSON.stringify({
            observations: observations.map(({ checksum }) => checksum).sort(),
            claims: claims.map((claim) => JSON.stringify(claim)).sort(),
            identities: [...new Set(identities)].sort(),
          }),
        );
        const [previous] = await tx
          .select({ count: sql<number>`count(*)::integer` })
          .from(runOperation)
          .where(
            and(
              eq(runOperation.runId, input.runId),
              eq(runOperation.kind, "research_continue"),
              eq(runOperation.state, "completed"),
              sql`${runOperation.result}->>'workRef' = ${workRef}`,
              sql`${runOperation.result}->>'progressFingerprint' = ${progressFingerprint}`,
            ),
          );
        const [lastAttempt] = await tx
          .select({ error: runOperation.error, result: runOperation.result })
          .from(runOperation)
          .where(
            and(
              eq(runOperation.runId, input.runId),
              inArray(runOperation.kind, [
                "research_resolve_import",
                "research_resolve_product",
              ]),
              sql`${runOperation.result}->'attempt'->>'workRef' = ${workRef}`,
            ),
          )
          .orderBy(desc(runOperation.startedAt), desc(runOperation.id))
          .limit(1);
        const feedback = lastAttempt
          ? z
              .object({
                refusals: z
                  .array(z.object({ path: z.string(), reason: z.string() }))
                  .default([]),
              })
              .parse(lastAttempt.result)
          : { refusals: [] };
        const settled = (previous?.count ?? 0) + 1 >= 3;
        const detail =
          "Coordinator repeatedly ended without resolving this task; unchanged work is paused for review.";
        await ledger.start(tx);
        if (settled)
          await tx
            .update(runTarget)
            .set({
              state: "unresolved",
              outcome: "temporarily_blocked",
              warning: `${detail}${lastAttempt?.error ? ` Last error: ${lastAttempt.error}` : feedback.refusals.length ? ` Last refusals: ${JSON.stringify(feedback.refusals)}` : ""}`,
              completedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(runTarget.id, workRef));
        const next = jsonObject.parse({
          ...input.next,
          reasoningMode: "unfamiliar_resolution",
          feedback: { ...feedback, error: lastAttempt?.error ?? null },
        });
        const result = { settled, next };
        await ledger.complete(tx, { ...result, workRef, progressFingerprint });
        return result;
      }),
  );
}
