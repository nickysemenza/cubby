import { buildActorContext } from "@cubby/schemas/context";
import { runEntityId, userId } from "@cubby/schemas/identifiers";
import {
  mailDiscoveryRunInput,
  mailDiscoveryRunProgress,
  type MailDiscoveryRunProgress,
} from "@cubby/schemas/run-fields";
import { and, eq, lt, sql } from "drizzle-orm";

import { getPurchaseAgentQueue } from "~/server/cf-env";
import type { Database } from "~/server/db";
import { run as runTable, runProgress } from "~/server/db/schema";
import { isUniqueViolation } from "~/server/errors/db-errors";
import { reportServerError } from "~/server/errors/report-error";
import {
  getDb,
  withTransaction,
  withTransactionDatabase,
} from "~/server/repo/database-helpers";
import { ensureRun } from "~/server/runs/ensure-run";
import type { WorkflowRunParams } from "~/server/workflow-runs/contract";
import {
  productionWorkflowLauncher,
  type WorkflowLauncher,
} from "~/server/workflow-runs/launcher";
import {
  claimWorkflowRun,
  failWorkflowRun,
  launchWorkflowRun,
  recordRunProgress,
  runFailureText,
} from "~/server/workflow-runs/lifecycle";

import type { OrderMailAttachmentStorage } from "./attachment-storage";
import { autoImportOrderMail } from "./auto-import";
import { ingestGmailMessages } from "./ingest";
import {
  advanceMailboxCursor,
  loadGmailCursor,
  persistGmailEvents,
} from "./persistence";
import { processOrderMails } from "./process";
import { gmailProviderForUser } from "./provider";
import { listGmailChanges } from "./sync";
import { listGmailSyncTargets } from "./targets";
import type { GmailProvider } from "./types";

/*
 * A scheduled Gmail pass is one `mail_discovery` Run, walked by the
 * `MailDiscoveryWorkflow`: `list` freezes the pass's message batches and
 * history events on the Run, each `batch.<n>` saves and classifies ten
 * messages, and `finish` records the history and moves the mailbox cursor
 * from where this pass started. Every write is fenced to the Run's current
 * attempt, so a cancel or retry stops an older attempt mid-pass.
 */

const BATCH_SIZE = 10;
/** Routine passes are kept this long, then pruned by the daily cron. */
const ROUTINE_RETENTION_MS = 30 * 86_400_000;

const MAIL_DISCOVERY_CONSTRAINT = "Run_one_active_mail_discovery";

type DiscoveryPorts = {
  providerForUser?: (userId: string) => Promise<GmailProvider>;
  storage?: OrderMailAttachmentStorage;
  process?: typeof processOrderMails;
  autoImport?: (
    db: Database,
    input: Parameters<typeof autoImportOrderMail>[1],
  ) => Promise<string[]>;
};

const productionAutoImport: NonNullable<DiscoveryPorts["autoImport"]> = async (
  db,
  input,
) => {
  const queue = getPurchaseAgentQueue();
  if (!queue) throw new Error("Purchase Agent queue is unavailable");
  return autoImportOrderMail(db, input, queue);
};

const patchProgress = (patch: Partial<MailDiscoveryRunProgress>) =>
  sql`coalesce(${runTable.progress}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb`;
const attemptIs = (attempt: number) =>
  sql`coalesce((${runTable.progress}->>'attempt')::int, 0) = ${attempt}`;
const batchesDoneIs = (count: number) =>
  sql`coalesce((${runTable.progress}->>'batchesDone')::int, 0) = ${count}`;

const claimDiscovery = async (db: Database, params: WorkflowRunParams) => {
  const row = await claimWorkflowRun(db, params);
  if (!row?.ledgerPartyId) return null;
  return {
    row,
    ledgerPartyId: row.ledgerPartyId,
    input: mailDiscoveryRunInput.parse(row.input),
    progress: mailDiscoveryRunProgress.parse(row.progress),
  };
};

/**
 * Start a pass for every member who connected Google. A member whose last
 * pass is still running is skipped: the partial unique index on running
 * `mail_discovery` Runs refuses the insert, so a cron and an app-open
 * trigger that overlap start one pass between them.
 */
export async function startMailDiscovery(
  db: Database,
  options: { launcher?: WorkflowLauncher } = {},
): Promise<{ started: number; running: number }> {
  let started = 0;
  let running = 0;
  for (const target of await listGmailSyncTargets(db)) {
    const cursor = await loadGmailCursor(db, target);
    let runId;
    try {
      runId = await ensureRun(
        db,
        buildActorContext(userId.parse(target.userId), "system"),
        {
          purpose: "mail_discovery",
          trigger: "scheduled",
          status: "running",
          notes: "Scheduled Gmail discovery",
          input: {
            mailboxId: target.mailboxId,
            knownSenders: [...target.bootstrap.knownSenders],
          },
          progress: {
            attempt: 0,
            phase: "listing",
            startHistoryId: cursor.historyId,
            batchesDone: 0,
            saved: 0,
            deleted: 0,
            events: 0,
            droppedEvents: 0,
          },
        },
      );
    } catch (error) {
      if (!isUniqueViolation(error, MAIL_DISCOVERY_CONSTRAINT)) throw error;
      running += 1;
      continue;
    }
    await launchWorkflowRun(
      db,
      { runId, purpose: "mail_discovery" },
      options.launcher ?? productionWorkflowLauncher,
    );
    started += 1;
  }
  return { started, running };
}

/**
 * The `list` step: freeze what this pass will save. A retried pass finds its
 * manifest already on the Run and reuses it, so every attempt saves the same
 * batches and advances to the same target.
 */
export async function listMailDiscovery(
  db: Database,
  params: WorkflowRunParams,
  ports: DiscoveryPorts = {},
): Promise<{ kind: "stopped" } | { kind: "listed"; batches: number }> {
  const claimed = await claimDiscovery(db, params);
  if (!claimed) return { kind: "stopped" };
  if (claimed.progress.batches)
    return { kind: "listed", batches: claimed.progress.batches.length };
  const provider = await (
    ports.providerForUser ?? ((userId) => gmailProviderForUser(db, userId))
  )(claimed.row.actorUserId);
  const changes = await listGmailChanges(provider, {
    mailboxId: claimed.input.mailboxId,
    historyId: claimed.progress.startHistoryId,
    bootstrap: { knownSenders: claimed.input.knownSenders },
  });
  const batches: string[][] = [];
  for (let index = 0; index < changes.messageIds.length; index += BATCH_SIZE)
    batches.push(changes.messageIds.slice(index, index + BATCH_SIZE));
  const [frozen] = await getDb(db)
    .update(runTable)
    .set({
      progress: patchProgress({
        phase: "fetching",
        mode: changes.mode,
        targetHistoryId: changes.targetHistoryId,
        batches,
        pendingEvents: changes.events.map((event) => ({
          ...event,
          labelIds: [...event.labelIds],
        })),
      }),
    })
    .where(
      and(
        eq(runTable.id, claimed.row.id),
        eq(runTable.status, "running"),
        attemptIs(params.attempt),
      ),
    )
    .returning({ id: runTable.id });
  if (!frozen) return { kind: "stopped" };
  await recordRunProgress(
    db,
    claimed.row.id,
    "listed",
    `Listed ${changes.messageIds.length} messages and ${changes.events.length} history changes (${changes.mode.replaceAll("_", " ")}) in ${batches.length} batches`,
  );
  return { kind: "listed", batches: batches.length };
}

/**
 * The `batch.<n>` step: save and classify one frozen batch, then start an
 * import for each new order confirmation in it. A batch an earlier delivery
 * or attempt already saved is not fetched again.
 */
export async function saveMailDiscoveryBatch(
  db: Database,
  params: WorkflowRunParams,
  index: number,
  ports: DiscoveryPorts = {},
): Promise<{ kind: "stopped" } | { kind: "done" }> {
  const claimed = await claimDiscovery(db, params);
  if (!claimed) return { kind: "stopped" };
  const { progress, row } = claimed;
  if (progress.batchesDone > index) return { kind: "done" };
  const batch = progress.batches?.[index];
  if (!batch || progress.batchesDone < index)
    throw new Error(
      `Discovery Run has saved ${progress.batchesDone} batches, not ${index}`,
    );
  const provider = await (
    ports.providerForUser ?? ((userId) => gmailProviderForUser(db, userId))
  )(row.actorUserId);
  const ingested = await ingestGmailMessages(db, provider, {
    ledgerPartyId: claimed.ledgerPartyId,
    mailboxId: claimed.input.mailboxId,
    messageIds: batch,
    storage: ports.storage,
  });
  await (ports.process ?? processOrderMails)(
    db,
    ingested.saved,
    undefined,
    row.id,
  );
  // New confirmations import themselves; a replayed batch reuses its runs.
  await (ports.autoImport ?? productionAutoImport)(db, {
    ledgerPartyId: claimed.ledgerPartyId,
    messageIds: ingested.saved,
  });
  const [saved] = await getDb(db)
    .update(runTable)
    .set({
      progress: patchProgress({
        batchesDone: index + 1,
        saved: progress.saved + ingested.saved.length,
        deleted: progress.deleted + ingested.deleted.length,
      }),
    })
    .where(
      and(
        eq(runTable.id, row.id),
        eq(runTable.status, "running"),
        attemptIs(params.attempt),
        batchesDoneIs(index),
      ),
    )
    .returning({ id: runTable.id });
  if (!saved) return { kind: "stopped" };
  await recordRunProgress(
    db,
    row.id,
    "batch_saved",
    `Saved batch ${index + 1} of ${progress.batches?.length ?? 0}: ${ingested.saved.length} messages${ingested.deleted.length ? `, ${ingested.deleted.length} deleted before fetching` : ""}`,
  );
  return { kind: "done" };
}

/**
 * The `finish` step: record history for saved mail, move the cursor from
 * where this pass started (a later pass that already moved it wins), and
 * complete the Run — `routine` when it saved nothing and recorded nothing.
 */
export async function finishMailDiscovery(
  db: Database,
  params: WorkflowRunParams,
  now = new Date(),
): Promise<{ kind: "stopped" } | { kind: "done" }> {
  // One transaction under the Run's row lock: a cancel or a retry either
  // lands first (and this attempt records nothing) or waits for it to commit.
  return withTransactionDatabase(db, async (tx) => {
    const [locked] = await getDb(tx)
      .select({ id: runTable.id })
      .from(runTable)
      .where(
        and(
          eq(runTable.id, runEntityId.parse(params.runId)),
          eq(runTable.status, "running"),
          attemptIs(params.attempt),
        ),
      )
      .for("update")
      .limit(1);
    if (!locked) return { kind: "stopped" as const };
    const claimed = await claimDiscovery(tx, params);
    if (!claimed) return { kind: "stopped" as const };
    const { progress, row } = claimed;
    const events = await persistGmailEvents(tx, {
      ledgerPartyId: claimed.ledgerPartyId,
      events: progress.pendingEvents ?? [],
    });
    const moved = await advanceMailboxCursor(tx, {
      ledgerPartyId: claimed.ledgerPartyId,
      from: progress.startHistoryId,
      to: progress.targetHistoryId ?? null,
      polledAt: now,
    });
    const routine = progress.saved === 0 && events.saved === 0;
    const detail = routine
      ? "Nothing new in Gmail"
      : `Saved ${progress.saved} messages and ${events.saved} history changes`;
    const cursor = moved
      ? `cursor at ${progress.targetHistoryId ?? "the mailbox start"}`
      : "cursor already moved by a later pass";
    await getDb(tx)
      .update(runTable)
      .set({
        status: "completed",
        endedAt: now,
        routine,
        // The manifest has served its purpose; counts stay for the report.
        progress: patchProgress({
          phase: "completed",
          events: events.saved,
          droppedEvents: events.dropped,
          batches: [],
          pendingEvents: [],
        }),
      })
      .where(eq(runTable.id, row.id));
    await getDb(tx)
      .insert(runProgress)
      .values({
        runId: row.id,
        eventId: crypto.randomUUID(),
        phase: "completed",
        detail: `${detail}; ${cursor}`,
      });
    return { kind: "done" as const };
  });
}

/** The failure step: report the error and fail this attempt's Run. */
export async function failMailDiscovery(
  db: Database,
  params: WorkflowRunParams,
  stepError: string,
  options: { reportError?: typeof reportServerError } = {},
): Promise<null> {
  const error = new Error(stepError);
  const eventId = (options.reportError ?? reportServerError)(error, {
    operation: "mail-discovery",
    stage: "workflow",
  });
  await failWorkflowRun(db, params, {
    failureCode: "mail_discovery_failed",
    message: runFailureText(error, eventId),
  });
  return null;
}

/**
 * Delete routine passes older than a month with their progress lines. A
 * routine Run saved and recorded nothing, so it carries no evidence; one
 * that anything references (AI usage) is kept.
 */
export async function pruneRoutineRuns(
  db: Database,
  now = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - ROUTINE_RETENTION_MS);
  const prunable = and(
    eq(runTable.routine, true),
    lt(runTable.endedAt, cutoff),
    // Hand-qualified: an interpolated `runTable.id` renders unqualified and
    // would bind to the subquery's own table. includes-deleted: a deleted
    // usage row still holds its foreign key to the Run.
    sql.raw(
      `NOT EXISTS (SELECT 1 FROM "AiUsage" u WHERE u."runId" = "Run"."id")`,
    ),
  );
  return withTransaction(db, async (tx) => {
    const ids = (
      await tx.select({ id: runTable.id }).from(runTable).where(prunable)
    ).map((row) => row.id);
    if (ids.length === 0) return 0;
    for (const id of ids) {
      await tx.delete(runProgress).where(eq(runProgress.runId, id));
      await tx.delete(runTable).where(eq(runTable.id, id));
    }
    return ids.length;
  });
}
