import type { ActorContext } from "@cubby/schemas/context";
import type { mailImportGapCategory } from "@cubby/schemas/email-fields";
import {
  emailId as emailEntityId,
  runEntityId,
  type RunId,
} from "@cubby/schemas/identifiers";
import { runPurpose } from "@cubby/schemas/purchase-import";
import { runTargetOutcomeReceipt } from "@cubby/schemas/run-fields";
import { mailImportOutcome } from "@cubby/schemas/suggestion";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import type { Database, DrizzleTransaction } from "~/server/db";
import {
  notDeleted,
  withTransaction,
  databaseForTransaction,
} from "~/server/db/helpers";
import {
  email as emailTable,
  ledgerParty,
  run as runTable,
  runFinding,
  runOperation,
} from "~/server/db/schema";
import {
  importAttemptsExhaustedSql,
  readMailRunSources,
  readMailSourceTransfers,
} from "~/server/domains/purchase-import/repo/mail-run-membership";
import { runFindingColumns } from "~/server/domains/run/repo/run-finding";
import { recordChange } from "~/server/generic/changes/repo/change";

type MailImportGapCategory = z.infer<typeof mailImportGapCategory>;

/** Admitted Email outcomes a settled Mail import accepts as final. */
const SETTLED_MAIL_STATUSES = new Set(["completed", "excluded", "unsettled"]);

/**
 * The outcome this Run recorded for each unresolved Email at its current
 * checksum, by Email id: the gap category the Work queue routes by.
 */
async function unresolvedMailOutcomes(
  tx: DrizzleTransaction,
  runId: RunId,
  emails: readonly { id: string; checksum: string }[],
) {
  const outcomes = new Map<string, MailImportGapCategory>();
  if (!emails.length) return outcomes;
  const rows = await tx
    .select({ result: runOperation.result })
    .from(runOperation)
    .where(
      and(
        eq(runOperation.runId, runEntityId.parse(runId)),
        eq(runOperation.kind, "target_outcome"),
        eq(runOperation.state, "completed"),
      ),
    )
    .orderBy(runOperation.completedAt);
  const checksums = new Map(emails.map((email) => [email.id, email.checksum]));
  for (const row of rows) {
    const parsed = runTargetOutcomeReceipt
      .extend({ mailOutcome: z.object({ judgment: mailImportOutcome }) })
      .safeParse(row.result);
    if (
      parsed.success &&
      parsed.data.mailOutcome.judgment.kind === "unresolved" &&
      checksums.get(parsed.data.target.entityId) ===
        parsed.data.target.targetFingerprint
    )
      outcomes.set(
        parsed.data.target.entityId,
        parsed.data.mailOutcome.judgment.category,
      );
  }
  return outcomes;
}

/**
 * A transient failure retries automatically: the completed Run releases the
 * Email to ordinary admission, which the per-checksum attempt bound limits.
 * Its outcome stays retained, so the Email reads waiting until re-admitted.
 */
async function retryTransientMailGaps(
  tx: DrizzleTransaction,
  runId: RunId,
  outcomes: ReadonlyMap<string, MailImportGapCategory>,
) {
  const transient = [...outcomes]
    .filter(([, category]) => category === "transient_failure")
    .map(([emailId]) => emailEntityId.parse(emailId));
  if (!transient.length) return;
  await tx
    .update(emailTable)
    .set({ runId: null, status: "pending", updatedAt: new Date() })
    .where(
      and(
        eq(emailTable.runId, runEntityId.parse(runId)),
        eq(emailTable.status, "unsettled"),
        inArray(emailTable.id, transient),
        sql`NOT ${importAttemptsExhaustedSql}`,
      ),
    );
}

/**
 * Whether a Mail import's admitted Emails are settled: null while one is
 * unowned, changed or still unsettled without a final status; otherwise the
 * unsettled Emails with no recorded outcome, the Run's open findings and the
 * recorded gap outcomes.
 */
export async function readMailRunSettlement(
  tx: DrizzleTransaction,
  runId: RunId,
) {
  const sources = await readMailRunSources(tx, runId);
  const transferred = await readMailSourceTransfers(tx, runId);
  // Only an immutable, checksum-matched transfer receipt may remove a
  // source from a live Run's settlement responsibility.
  const remaining = sources.filter(
    (source) =>
      source.owned || transferred.get(source.orderMailId) !== source.checksum,
  );
  if (
    !sources.length ||
    remaining.some(
      (source) =>
        !source.owned ||
        !source.unchanged ||
        !SETTLED_MAIL_STATUSES.has(source.email.status),
    )
  )
    return null;
  const outcomes = await unresolvedMailOutcomes(
    tx,
    runId,
    remaining
      .filter((source) => source.email.status === "unsettled")
      .map(({ email }) => email),
  );
  const unresolved = remaining
    .filter(
      (source) =>
        source.email.status === "unsettled" && !outcomes.has(source.email.id),
    )
    .map(({ email }) => email);
  const findings = await tx
    .select({
      id: runFindingColumns.id,
      kind: runFindingColumns.kind,
      summary: runFindingColumns.summary,
    })
    .from(runFinding)
    .where(
      and(eq(runFinding.runId, runId), eq(runFindingColumns.status, "open")),
    );
  return { unresolved, findings, outcomes };
}

/** A stopped Run keeps the end time of its stop; a running one ends now. */
export async function completeSettledMailRun(
  tx: DrizzleTransaction,
  runId: RunId,
  outcomes: ReadonlyMap<string, MailImportGapCategory>,
) {
  const now = new Date();
  await tx
    .update(runTable)
    .set({
      status: "completed",
      auditedAt: now,
      endedAt: sql`coalesce(${runTable.endedAt}, ${now.toISOString()}::timestamp)`,
      updatedAt: now,
    })
    .where(eq(runTable.id, runId));
  await (
    await import("~/server/kernel/api")
  ).emitWrites(databaseForTransaction(tx), {
    table: runTable,
    entity: "run",
    ids: [runId],
    columns: ["status", "endedAt", "updatedAt"],
  });
  await retryTransientMailGaps(tx, runId, outcomes);
  await recordChange(tx, { kind: "source", categories: ["email", "run"] });
}

/**
 * A Mail import stopped for review only over findings completes once the
 * member resolves the last one and every admitted Email still has a final
 * status or a recorded outcome; otherwise it stays in review.
 */
export async function settleReviewedMailRun(
  db: Database,
  findingId: string,
  actorUserId: ActorContext["userId"],
) {
  await withTransaction(db, async (tx) => {
    // The gate before the Run row lock; completing the Run dirties it.
    await (
      await import("~/server/kernel/api")
    ).enterHouseholdGate(databaseForTransaction(tx));
    const [row] = await tx
      .select({ id: runTable.id })
      .from(runFinding)
      .innerJoin(runTable, eq(runTable.id, runFinding.runId))
      .innerJoin(
        ledgerParty,
        and(
          eq(ledgerParty.id, runFinding.ledgerPartyId),
          eq(ledgerParty.userId, actorUserId),
          notDeleted(ledgerParty),
        ),
      )
      .where(
        and(
          eq(runFinding.id, findingId),
          eq(runTable.purpose, runPurpose.enum.mail_import),
          eq(runTable.status, "needs_review"),
        ),
      )
      .for("no key update", { of: runTable });
    if (!row) return;
    const settlement = await readMailRunSettlement(tx, row.id);
    if (
      !settlement ||
      settlement.unresolved.length ||
      settlement.findings.length
    )
      return;
    await completeSettledMailRun(tx, row.id, settlement.outcomes);
  });
}
