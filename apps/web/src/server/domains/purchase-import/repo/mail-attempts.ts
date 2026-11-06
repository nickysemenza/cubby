import type { RunId } from "@cubby/schemas/identifiers";
import {
  mailAttemptInput,
  mailAttemptResult,
} from "@cubby/schemas/purchase-agent-services";
import { sha256Hex } from "@cubby/shared/sha256";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import { withTransaction } from "~/server/db/helpers";
import { email, run, runOperation } from "~/server/db/schema";
import { insertOperation } from "~/server/domains/run/repo/run-operation";

/** Evidence-scoped receipts survive coordinator retirement and successor Runs. */
export async function recordMailAttempt(
  db: Database,
  runId: RunId,
  input: z.infer<typeof mailAttemptInput>,
) {
  return withTransaction(db, async (tx) => {
    const [owner] = await tx
      .select()
      .from(run)
      .where(eq(run.id, runId))
      .for("no key update");
    if (
      !owner ||
      !owner.ledgerPartyId ||
      owner.purpose !== "mail_import" ||
      (input.action === "admit" && owner.status !== "running") ||
      owner.retiredAt ||
      owner.deletedAt ||
      owner.dispatchEventId !== input.generation
    )
      throw new Error("Mail attempt generation is no longer active");
    const [source] = await tx
      .select()
      .from(email)
      .where(
        and(
          eq(email.ledgerPartyId, owner.ledgerPartyId),
          eq(email.mailboxId, input.source.mailboxId),
          eq(email.messageId, input.source.messageId),
        ),
      )
      .for("update");
    if (
      !source ||
      source.runId !== runId ||
      source.checksum !== input.source.checksum
    )
      throw new Error("Mail attempt source changed ownership or evidence");
    // Only the host claim can establish the version; model-supplied versions
    // cannot create a fresh budget. Historical claims are read through runId.
    const [claim] = await tx
      .select({ id: runOperation.id })
      .from(runOperation)
      .where(
        and(
          eq(runOperation.runId, runId),
          eq(runOperation.kind, "claim_next_work"),
          eq(runOperation.state, "completed"),
          sql`${runOperation.result}->>'evidenceVersion' = ${input.source.evidenceVersion}`,
          sql`${runOperation.result}->${"email"}->>'messageId' = ${input.source.messageId}`,
          sql`${runOperation.result}->${"email"}->>'mailboxId' = ${input.source.mailboxId}`,
        ),
      )
      .limit(1);
    if (!claim) throw new Error("Mail attempt requires trusted claim evidence");
    const operationId = `mail-attempt:${await sha256Hex(JSON.stringify([input.source, input.identity, input.invocation]))}`;
    if (input.action !== "admit") {
      await tx
        .update(runOperation)
        .set({
          // Result classification cannot move a reservation to a different
          // stage when coordinator recovery changed the active model.
          result: sql`${runOperation.result} || ${JSON.stringify({
            charged: input.action !== "exempt",
            pending: input.action === "pending",
            rejected: input.action === "invalid",
          })}::jsonb`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(runOperation.runId, runId),
            sql`${runOperation.result}->${"source"} = ${JSON.stringify(input.source)}::jsonb`,
            sql`${runOperation.result}->>${"identity"} = ${input.identity}`,
            eq(runOperation.kind, "mail_extraction_attempt"),
          ),
        );
      return mailAttemptResult.parse({ kind: "admitted" });
    }
    // Narrow Runs by member and frozen source before reading their runId-led
    // ledgers. Do not filter retirement/deletion: their receipts still count.
    const owners = await tx
      .select({ id: run.id })
      .from(run)
      .where(
        and(
          eq(run.ledgerPartyId, owner.ledgerPartyId),
          eq(run.purpose, "mail_import"),
          or(
            sql`${run.input}->'sources' @> ${JSON.stringify([{ orderMailId: source.orderMailId, checksum: source.checksum }])}::jsonb`,
            sql`EXISTS (SELECT 1 FROM "RunOperation" history WHERE history."runId" = ${run.id} AND history.kind = 'mail_extraction_attempt' AND history.result->${"source"} = ${JSON.stringify(input.source)}::jsonb)`,
          ),
        ),
      );
    const receipts = owners.length
      ? await tx
          .select({ result: runOperation.result, runId: runOperation.runId })
          .from(runOperation)
          .where(
            and(
              inArray(
                runOperation.runId,
                owners.map((row) => row.id),
              ),
              eq(runOperation.kind, "mail_extraction_attempt"),
              sql`${runOperation.result}->${"source"} = ${JSON.stringify(input.source)}::jsonb`,
            ),
          )
      : [];
    const saved = receipts.map((row) => ({
      ...mailAttemptInput
        .extend({
          charged: z.boolean(),
          pending: z.boolean(),
          rejected: z.boolean().default(false),
        })
        .parse(row.result),
      ownerRunId: row.runId,
    }));
    if (
      saved.some(
        (row) =>
          row.identity === input.identity &&
          row.charged &&
          !row.rejected &&
          (!row.pending || row.ownerRunId === runId),
      )
    )
      return mailAttemptResult.parse({ kind: "admitted" });
    if (saved.some((row) => row.pending))
      return mailAttemptResult.parse({ kind: "pending" });
    if (
      saved.filter((row) => row.stage === input.stage && row.charged).length >=
      (input.stage === "primary" ? 2 : 1)
    )
      return mailAttemptResult.parse({ kind: "exhausted" });
    if (source.status !== "researching")
      throw new Error("Mail extraction source is already settled");
    const prior = saved.find(
      (row) =>
        row.identity === input.identity &&
        !row.charged &&
        row.ownerRunId === runId,
    );
    if (prior) {
      await tx
        .update(runOperation)
        .set({
          result: {
            ...input,
            charged: true,
            pending: input.publicationPossible,
          },
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(runOperation.runId, runId),
            sql`${runOperation.result}->>${"identity"} = ${input.identity}`,
          ),
        );
      return mailAttemptResult.parse({ kind: "admitted" });
    }
    await insertOperation(tx, {
      runId,
      operationId,
      kind: "mail_extraction_attempt",
      inputFingerprint: await sha256Hex(JSON.stringify(input)),
      state: "completed",
      result: { ...input, charged: true, pending: input.publicationPossible },
    });
    return mailAttemptResult.parse({ kind: "admitted" });
  });
}
