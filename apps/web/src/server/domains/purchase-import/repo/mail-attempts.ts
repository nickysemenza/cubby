import type { LedgerPartyId, RunId } from "@cubby/schemas/identifiers";
import { EXTRACT_ORDER_TOOL } from "@cubby/schemas/import-run-agent";
import {
  mailAttemptInput,
  mailAttemptResult,
} from "@cubby/schemas/purchase-agent-services";
import { runStatus } from "@cubby/schemas/run-fields";
import { sha256Hex } from "@cubby/shared/sha256";
import { and, desc, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import { getDb, withTransaction } from "~/server/db/helpers";
import { email, run, runOperation } from "~/server/db/schema";
import {
  insertOperation,
  setOperationResult,
} from "~/server/domains/run/repo/run-operation";

const fencedOwnerStatuses = runStatus.extract([
  "completed",
  "failed",
  "needs_review",
]).options;
const attemptReceipt = mailAttemptInput.extend({
  charged: z.boolean(),
  pending: z.boolean(),
  rejected: z.boolean().default(false),
  replayedFromRunId: z.string().optional(),
});

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
    if (input.action === "admit" && source.status !== "researching")
      throw new Error("Mail extraction source is already settled");
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
      const aliases = await tx
        .select({
          operationId: runOperation.operationId,
          result: runOperation.result,
        })
        .from(runOperation)
        .where(
          and(
            eq(runOperation.runId, runId),
            eq(runOperation.kind, "mail_extraction_attempt"),
            sql`${runOperation.result}->${"source"} = ${JSON.stringify(input.source)}::jsonb`,
            inArray(sql<string>`${runOperation.result}->>${"identity"}`, [
              input.identity,
              ...(input.legacyIdentity ? [input.legacyIdentity] : []),
            ]),
            // A refused call never reached a writer: it releases only its own
            // reservation. Uncharged, it neither reconciles an identical
            // uncertain attempt nor blocks that identity's later replay.
            input.action === "refused"
              ? sql`${runOperation.result}->>${"invocation"} = ${input.invocation}`
              : undefined,
          ),
        );
      for (const alias of aliases)
        await setOperationResult(
          tx,
          { runId, operationId: alias.operationId },
          {
            // Classification preserves the original stage when model recovery moved on.
            ...attemptReceipt.parse(alias.result),
            charged: input.action !== "exempt" && input.action !== "refused",
            pending: input.action === "pending",
            rejected: input.action === "invalid",
          },
        );
      return mailAttemptResult.parse({ kind: "admitted" });
    }
    // includes-deleted: terminal and erased owners' receipts still constrain replay.
    // Narrow Runs by member and frozen source before reading their runId-led ledgers.
    const owners = await tx
      .select({ id: run.id, retiredAt: run.retiredAt, status: run.status })
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
          .select({
            result: runOperation.result,
            runId: runOperation.runId,
            operationId: runOperation.operationId,
          })
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
    const saved = receipts.map((row) => {
      const receipt = attemptReceipt.parse(row.result);
      return {
        ...receipt,
        // A receipt recorded under the legacy digest is this same attempt.
        identity:
          input.legacyIdentity && receipt.identity === input.legacyIdentity
            ? input.identity
            : receipt.identity,
        operationId: row.operationId,
        ownerRunId: row.runId,
      };
    });
    const localReplay = saved.some(
      (row) =>
        row.ownerRunId === runId &&
        row.identity === input.identity &&
        row.charged &&
        (!row.rejected || row.invocation === input.invocation),
    );
    if (localReplay) return mailAttemptResult.parse({ kind: "admitted" });
    const reconciled = new Set(
      saved
        .filter((row) => row.charged && !row.pending)
        .map((row) => row.identity),
    );
    const fenced = new Set(
      owners
        .filter(
          (row) =>
            row.retiredAt !== null ||
            fencedOwnerStatuses.some((status) => status === row.status),
        )
        .map((row) => row.id),
    );
    const pending = saved.filter(
      (row) => row.pending && !reconciled.has(row.identity),
    );
    // A terminal or retired owner fences its writers; this transaction holds the
    // unchanged Email under its successor. Only identical facts can retry
    // through the canonical source writer; a changed extraction must wait.
    if (
      pending.some(
        (row) => row.identity !== input.identity || !fenced.has(row.ownerRunId),
      )
    )
      return mailAttemptResult.parse({ kind: "pending" });
    const rejectedHere = saved.some(
      (row) =>
        row.ownerRunId === runId &&
        row.identity === input.identity &&
        row.charged &&
        row.rejected,
    );
    const replay = rejectedHere
      ? undefined
      : saved.find(
          (row) =>
            row.identity === input.identity &&
            row.charged &&
            !row.rejected &&
            (!row.pending || !reconciled.has(row.identity)),
        );
    const charged = new Set(
      saved
        .filter((row) => row.stage === input.stage && row.charged)
        .map((row) =>
          row.rejected && !row.replayedFromRunId
            ? `invalid:${row.ownerRunId}:${row.invocation}`
            : `candidate:${row.identity}`,
        ),
    );
    if (!replay && charged.size >= (input.stage === "primary" ? 2 : 1))
      return mailAttemptResult.parse({ kind: "exhausted" });
    const prior = saved.find(
      (row) =>
        row.identity === input.identity &&
        !row.charged &&
        row.ownerRunId === runId,
    );
    if (prior) {
      await setOperationResult(
        tx,
        { runId, operationId: prior.operationId },
        {
          ...input,
          charged: true,
          pending: input.publicationPossible,
          ...(replay ? { replayedFromRunId: replay.ownerRunId } : {}),
        },
      );
      return mailAttemptResult.parse({ kind: "admitted" });
    }
    await insertOperation(tx, {
      runId,
      operationId,
      kind: "mail_extraction_attempt",
      inputFingerprint: await sha256Hex(JSON.stringify(input)),
      state: "completed",
      result: {
        ...input,
        charged: true,
        pending: input.publicationPossible,
        ...(replay ? { replayedFromRunId: replay.ownerRunId } : {}),
      },
    });
    return mailAttemptResult.parse({ kind: "admitted" });
  });
}

/**
 * The exact proposal a claim returns for receipt recovery: a fenced owner's, or
 * the claiming Run's own. Its own pending attempt blocks every changed
 * extraction, and the coordinator's trimmed context no longer holds the
 * arguments, so withholding it re-claimed one Email in a loop (2026-11-11).
 */
export async function readMailAttemptRecovery(
  db: Database,
  input: {
    ledgerPartyId: LedgerPartyId;
    orderMailId: string;
    runId: RunId;
    source: z.infer<typeof mailAttemptInput.shape.source>;
  },
): Promise<{
  tool: typeof EXTRACT_ORDER_TOOL;
  arguments: NonNullable<z.infer<typeof mailAttemptInput.shape.proposal>>;
} | null> {
  const [attempt] = await getDb(db)
    .select({ result: runOperation.result })
    .from(runOperation)
    .innerJoin(run, eq(run.id, runOperation.runId))
    .where(
      and(
        eq(run.ledgerPartyId, input.ledgerPartyId),
        eq(run.purpose, "mail_import"),
        or(
          eq(run.id, input.runId),
          isNotNull(run.retiredAt),
          inArray(run.status, fencedOwnerStatuses),
        ),
        sql`${run.input}->'sources' @> ${JSON.stringify([{ orderMailId: input.orderMailId, checksum: input.source.checksum }])}::jsonb`,
        eq(runOperation.kind, "mail_extraction_attempt"),
        sql`${runOperation.result}->${"source"} = ${JSON.stringify(input.source)}::jsonb`,
        sql`${runOperation.result}->>${"pending"} = 'true'`,
        sql`${runOperation.result}->>${"charged"} = 'true'`,
        sql`${runOperation.result}->${"proposal"} IS NOT NULL`,
        sql`/* includes-deleted: Retained replay receipts stay authoritative after their Run is deleted. */
        NOT EXISTS (SELECT 1 FROM "RunOperation" known
        JOIN "Run" known_owner ON known_owner.id = known."runId"
        WHERE known_owner."ledgerPartyId" = ${input.ledgerPartyId}
          AND known.kind = 'mail_extraction_attempt'
          AND known.result->${"source"} = ${runOperation.result}->${"source"}
          AND known.result->>${"identity"} = ${runOperation.result}->>${"identity"}
          AND known.result->>${"charged"} = 'true'
          AND known.result->>${"pending"} = 'false')`,
      ),
    )
    .orderBy(desc(runOperation.updatedAt))
    .limit(1);
  const proposal = mailAttemptInput.shape.proposal.safeParse(
    z.object({ proposal: z.unknown() }).safeParse(attempt?.result).data
      ?.proposal,
  ).data;
  return proposal ? { tool: EXTRACT_ORDER_TOOL, arguments: proposal } : null;
}
