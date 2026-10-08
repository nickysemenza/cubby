import { buildActorContext } from "@cubby/schemas/context";
import type {
  ExecutionAuthorizationInput,
  ExecutionAuthorizationRequestedScope,
} from "@cubby/schemas/execution-authorization";
import { runEntityId, userId } from "@cubby/schemas/identifiers";
import { parseEntityId } from "@cubby/schemas/identifiers";
import {
  mailboxDiscoveryInput,
  mailboxDiscoveryProgress,
  type MailboxDiscoveryProgress,
  type MailboxCoverage,
  type MailboxDiscoveryStartOutput,
} from "@cubby/schemas/mailbox-research";
import { and, eq, lt, sql } from "drizzle-orm";

import type { UnparsedError } from "~/lib/error-utils";
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
import { assertExecutionAuthorization } from "~/server/runs/execution-authorization";
import {
  executionRequestForRun,
  executionAuthorizationPaused,
  latestExecutionAuthorization,
} from "~/server/runs/execution-context";
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

import type { startMailResearch } from "../research-run";
import type { OrderMailAttachmentStorage } from "./attachment-storage";
import { ingestGmailMessages } from "./ingest";
import {
  checkpointMailboxCoverage,
  loadGmailCursor,
  persistGmailEvents,
  saveMailboxMessage,
} from "./persistence";
import { gmailProviderForUser } from "./provider";
import type { MailRelevance } from "./relevance";
import {
  initializeMailboxCoverage,
  listGmailPage,
  mergeMailboxQueries,
} from "./sync";
import { listGmailSyncTargets, type GmailSyncTarget } from "./targets";
import { GmailAuthorizationError } from "./tokens";
import type { MailTriage } from "./triage";
import { GmailApiError, type GmailProvider } from "./types";

const ROUTINE_RETENTION_MS = 30 * 86_400_000;
const MAIL_DISCOVERY_CONSTRAINT = "Run_one_active_mail_discovery";
type DiscoveryMode = ExecutionAuthorizationRequestedScope["discovery"];
async function discoveryMode(
  db: Database,
  id: typeof runTable.$inferSelect.id,
  mailboxId: string,
): Promise<DiscoveryMode> {
  const authority = await executionRequestForRun(db, id);
  if (!authority) return "new_mail";
  if (authority.requestedScope.mailboxId !== mailboxId)
    throw new Error(
      "Discovery mailbox is outside its execution authorization.",
    );
  return (await assertExecutionAuthorization(db, authority)).scope.discovery;
}
const scopedQueriesPending = (
  coverage: MailboxCoverage | null,
  queries: GmailSyncTarget["scopedQueries"],
) =>
  coverage
    ? mergeMailboxQueries(coverage, queries).scoped.some(
        (query) => !query.completed,
      )
    : queries.length > 0;

/** Each successor owns one lane; causal lineage never changes its allowance. */
async function nextDiscoveryAllowance(
  db: Database,
  target: GmailSyncTarget,
  continuation = false,
) {
  const owner = {
    userId: userId.parse(target.userId),
    ledgerPartyId: parseEntityId("ledgerParty", target.ledgerPartyId),
  };
  const latest = async (kind: ExecutionAuthorizationInput["scope"]["kind"]) => {
    try {
      const ref = await latestExecutionAuthorization(
        db,
        owner,
        target.mailboxId,
        kind,
      );
      if (!ref) return { present: false, ref: undefined };
      return {
        present: true,
        ref: (await executionAuthorizationPaused(db, ref, "mail_discovery"))
          ? undefined
          : ref,
      };
    } catch (error) {
      reportServerError(error, {
        operation: "mail-discovery-allowance",
        stage: kind,
      });
      return { present: true, ref: undefined };
    }
  };
  const [pilot, backfill, continuous] = await Promise.all([
    latest("pilot"),
    latest("backfill"),
    latest("continuous"),
  ]);
  const { coverage } = await loadGmailCursor(db, {
    ledgerPartyId: target.ledgerPartyId,
    mailboxId: target.mailboxId,
  });
  const scopedPending = scopedQueriesPending(coverage, target.scopedQueries);
  if (
    continuous.ref &&
    coverage &&
    (coverage.history.pageToken || coverage.nextLane === "history")
  )
    return { executionAuthorization: continuous.ref };
  if (pilot.ref && scopedPending) return { executionAuthorization: pilot.ref };
  if (backfill.ref && (scopedPending || !coverage?.broad.completed))
    return { executionAuthorization: backfill.ref };
  if (continuous.ref && !continuation)
    return { executionAuthorization: continuous.ref };
  if (
    !pilot.present &&
    !backfill.present &&
    !continuous.present &&
    (!continuation || Boolean(coverage?.history.pageToken))
  )
    return { executionAuthorization: undefined };
  return null;
}
export type DiscoveryPorts = {
  providerForUser?: (userId: string) => Promise<GmailProvider>;
  storage?: OrderMailAttachmentStorage;
  triage?: MailTriage;
  relevance?: MailRelevance;
  research?: typeof startMailResearch;
};
const attemptIs = (attempt: number) =>
  sql`coalesce((${runTable.progress}->>'attempt')::int, 0) = ${attempt}`;
const patchProgress = (patch: Partial<MailboxDiscoveryProgress>) =>
  sql`coalesce(${runTable.progress}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb`;
const claimDiscovery = async (db: Database, params: WorkflowRunParams) => {
  const row = await claimWorkflowRun(db, params);
  if (!row?.ledgerPartyId) return null;
  return {
    row,
    ledgerPartyId: row.ledgerPartyId,
    input: mailboxDiscoveryInput.parse(row.input),
    progress: mailboxDiscoveryProgress.parse(row.progress),
  };
};
const eligibleAttempt = (params: WorkflowRunParams) =>
  and(
    eq(runTable.id, runEntityId.parse(params.runId)),
    eq(runTable.status, "running"),
    attemptIs(params.attempt),
  );
const pauseAuthorization = async (
  db: Database,
  params: WorkflowRunParams,
  error: UnparsedError,
): Promise<boolean> => {
  if (
    !(error instanceof GmailAuthorizationError) &&
    !(
      error instanceof GmailApiError &&
      (error.status === 401 ||
        (error.status === 403 && error.reason === "insufficientPermissions"))
    )
  )
    return false;
  await getDb(db)
    .update(runTable)
    .set({
      status: "paused_auth",
      failureCode: "gmail_reconnect_required",
      dispatchError: runFailureText(error),
      progress: patchProgress({ phase: "paused" }),
    })
    .where(eligibleAttempt(params));
  return true;
};

export async function startMailDiscovery(
  db: Database,
  options: {
    launcher?: WorkflowLauncher;
    target?: Pick<GmailSyncTarget, "ledgerPartyId" | "userId" | "mailboxId">;
  } = {},
): Promise<MailboxDiscoveryStartOutput> {
  let started = 0;
  let running = 0;
  const targets = await listGmailSyncTargets(db);
  const requested = options.target;
  const selected = requested
    ? targets.filter(
        (target) =>
          target.ledgerPartyId === requested.ledgerPartyId &&
          target.userId === requested.userId &&
          target.mailboxId === requested.mailboxId,
      )
    : targets;
  if (requested && selected.length === 0)
    throw new Error(
      "Selected discovery mailbox is not connected to this member.",
    );
  for (const target of selected) {
    const allowance = await nextDiscoveryAllowance(db, target);
    if (!allowance) continue;
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
            scopedQueries: target.scopedQueries,
            ...allowance,
          },
          progress: {
            attempt: 0,
            phase: "listing",
            pagesDone: 0,
            saved: 0,
            deleted: 0,
            excluded: 0,
            unrelated: 0,
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

export async function beginMailDiscovery(
  db: Database,
  params: WorkflowRunParams,
): Promise<{ kind: "stopped" } | { kind: "page"; index: number }> {
  const claimed = await claimDiscovery(db, params);
  return claimed
    ? { kind: "page", index: claimed.progress.pagesDone }
    : { kind: "stopped" };
}

/** Freeze only the next provider page; the mailbox baseline is already durable. */
export async function listMailDiscovery(
  db: Database,
  params: WorkflowRunParams,
  ports: DiscoveryPorts = {},
): Promise<{ kind: "stopped" } | { kind: "listed"; more: boolean }> {
  const claimed = await claimDiscovery(db, params);
  if (!claimed) return { kind: "stopped" };
  const mode = await discoveryMode(db, claimed.row.id, claimed.input.mailboxId);
  // Historical pages yield to a fresh Run so incremental work spends only its
  // continuous allowance. A history catch-up keeps its own paginated scope.
  const continuing = (coverage: MailboxCoverage) =>
    mode === "new_mail" && Boolean(coverage.history.pageToken);
  if (claimed.progress.page)
    return {
      kind: "listed",
      more: continuing(claimed.progress.page.nextCoverage),
    };
  try {
    const provider = await (
      ports.providerForUser ??
      ((id) => gmailProviderForUser(db, id, claimed.input.mailboxId))
    )(claimed.row.actorUserId);
    let { coverage } = await loadGmailCursor(db, {
      ledgerPartyId: claimed.ledgerPartyId,
      mailboxId: claimed.input.mailboxId,
    });
    if (!coverage) {
      const baseline = await initializeMailboxCoverage(
        provider,
        mode === "new_mail" ? [] : claimed.input.scopedQueries,
      );
      if (
        !(await checkpointMailboxCoverage(db, {
          ledgerPartyId: claimed.ledgerPartyId,
          mailboxId: claimed.input.mailboxId,
          from: null,
          to: baseline,
        }))
      )
        return { kind: "stopped" };
      coverage = baseline;
    }
    const merged = mergeMailboxQueries(
      coverage,
      mode === "new_mail" ? [] : claimed.input.scopedQueries,
    );
    if (JSON.stringify(merged) !== JSON.stringify(coverage)) {
      if (
        !(await checkpointMailboxCoverage(db, {
          ledgerPartyId: claimed.ledgerPartyId,
          mailboxId: claimed.input.mailboxId,
          from: coverage,
          to: merged,
        }))
      )
        return { kind: "stopped" };
      coverage = merged;
    }
    const page = await listGmailPage(
      provider,
      claimed.input.mailboxId,
      coverage,
      mode,
    );
    const [frozen] = await getDb(db)
      .update(runTable)
      .set({ progress: patchProgress({ phase: "fetching", page }) })
      .where(eligibleAttempt(params))
      .returning({ id: runTable.id });
    return frozen
      ? {
          kind: "listed",
          more: continuing(page.nextCoverage),
        }
      : { kind: "stopped" };
  } catch (error) {
    if (await pauseAuthorization(db, params, error)) return { kind: "stopped" };
    throw error;
  }
}

/** Process before cursor movement; an interrupted page reuses its message ledger and Runs. */
export async function saveMailDiscoveryBatch(
  db: Database,
  params: WorkflowRunParams,
  index: number,
  ports: DiscoveryPorts = {},
): Promise<{ kind: "stopped" } | { kind: "done" }> {
  const claimed = await claimDiscovery(db, params);
  if (!claimed) return { kind: "stopped" };
  if (claimed.progress.pagesDone > index) return { kind: "done" };
  const page = claimed.progress.page;
  if (!page || claimed.progress.pagesDone !== index)
    throw new Error(`Discovery page ${index} is not current`);
  try {
    const provider = await (
      ports.providerForUser ??
      ((id) => gmailProviderForUser(db, id, claimed.input.mailboxId))
    )(claimed.row.actorUserId);
    const removed = new Map(
      page.events
        .filter((event) => event.kind === "message_deleted")
        .map((event) => [event.messageId, "deleted" as const]),
    );
    for (const [messageId, status] of removed)
      await saveMailboxMessage(db, {
        ledgerPartyId: claimed.ledgerPartyId,
        mailboxId: claimed.input.mailboxId,
        messageId,
        checksum: status,
        classification: "uncertain",
        status,
      });
    const ingested = await ingestGmailMessages(db, provider, {
      ledgerPartyId: claimed.ledgerPartyId,
      mailboxId: claimed.input.mailboxId,
      messageIds: page.messageIds.filter((id) => !removed.has(id)),
      runId: claimed.row.id,
      triage: ports.triage,
      relevance: ports.relevance,
      storage: ports.storage,
    });
    if (!(await claimDiscovery(db, params))) return { kind: "stopped" };
    for (let offset = 0; offset < ingested.orderMailIds.length; offset += 50) {
      if (!(await claimDiscovery(db, params))) return { kind: "stopped" };
      const results = await (
        ports.research ?? (await import("../research-run")).startMailResearch
      )(db, {
        ledgerPartyId: claimed.ledgerPartyId,
        userId: claimed.row.actorUserId,
        parentRunId: claimed.row.id,
        mailboxId: claimed.input.mailboxId,
        messageIds: ingested.orderMailIds.slice(offset, offset + 50),
      });
      if (results.some((result) => result.status === "dispatch_failed"))
        throw new Error(
          "Mail research dispatch failed; replay the retained page.",
        );
    }
    return withTransactionDatabase(db, async (tx) => {
      const [locked] = await getDb(tx)
        .select({ id: runTable.id })
        .from(runTable)
        .where(eligibleAttempt(params))
        .for("update")
        .limit(1);
      if (!locked) return { kind: "stopped" as const };
      const current = await claimDiscovery(tx, params);
      if (!current || current.progress.pagesDone !== index)
        return { kind: "stopped" as const };
      const events = await persistGmailEvents(tx, {
        ledgerPartyId: claimed.ledgerPartyId,
        mailboxId: claimed.input.mailboxId,
        events: page.events,
      });
      const moved = await checkpointMailboxCoverage(tx, {
        ledgerPartyId: claimed.ledgerPartyId,
        mailboxId: claimed.input.mailboxId,
        from: page.startCoverage,
        to: page.nextCoverage,
      });
      if (!moved)
        throw new Error("Mailbox page coverage changed before checkpoint");
      const progress = {
        ...current.progress,
        phase: "listing" as const,
        pagesDone: index + 1,
        saved: current.progress.saved + ingested.orderMailIds.length,
        deleted:
          current.progress.deleted + ingested.deleted.length + removed.size,
        excluded: current.progress.excluded + ingested.excluded.length,
        unrelated: current.progress.unrelated + ingested.unrelated.length,
        events: current.progress.events + events.saved,
        droppedEvents: current.progress.droppedEvents + events.dropped,
      };
      delete progress.page;
      await getDb(tx)
        .update(runTable)
        .set({ progress })
        .where(eq(runTable.id, current.row.id));
      await recordRunProgress(
        tx,
        current.row.id,
        "page_saved",
        `Processed Gmail page ${index + 1}; ${ingested.orderMailIds.length} sources retained, ${ingested.unrelated.length} unrelated messages`,
      );
      return { kind: "done" as const };
    });
  } catch (error) {
    if (await pauseAuthorization(db, params, error)) return { kind: "stopped" };
    throw error;
  }
}

export async function finishMailDiscovery(
  db: Database,
  params: WorkflowRunParams,
  now = new Date(),
): Promise<{ kind: "stopped" } | { kind: "done" }> {
  const claimed = await claimDiscovery(db, params);
  if (!claimed) return { kind: "stopped" };
  if (claimed.progress.page)
    throw new Error("Cannot complete discovery with an unprocessed page");
  const [finished] = await getDb(db)
    .update(runTable)
    .set({
      status: "completed",
      endedAt: now,
      routine: claimed.progress.saved === 0 && claimed.progress.events === 0,
      progress: patchProgress({ phase: "completed" }),
    })
    .where(eligibleAttempt(params))
    .returning({ id: runTable.id });
  return finished ? { kind: "done" } : { kind: "stopped" };
}

/** A separate durable step bridges the completed page pass to its next bounded pass. */
export async function continueMailDiscovery(
  db: Database,
  params: WorkflowRunParams,
  options: { launcher?: WorkflowLauncher } = {},
): Promise<void> {
  const [previous] = await getDb(db)
    .select()
    .from(runTable)
    .where(
      and(
        eq(runTable.id, runEntityId.parse(params.runId)),
        eq(runTable.status, "completed"),
        attemptIs(params.attempt),
      ),
    )
    .limit(1);
  if (!previous?.ledgerPartyId) return;
  const input = mailboxDiscoveryInput.parse(previous.input);
  const clientKey = `mailbox-continuation:${previous.id}`;
  const [existing] = await getDb(db)
    .select()
    .from(runTable)
    .where(eq(runTable.clientKey, clientKey))
    .limit(1);
  if (
    existing &&
    existing.status !== "failed" &&
    Number(mailboxDiscoveryProgress.parse(existing.progress).attempt) > 0
  )
    return;
  let nextRunId = existing?.id;
  if (!nextRunId) {
    const allowance = await nextDiscoveryAllowance(
      db,
      {
        ledgerPartyId: previous.ledgerPartyId,
        userId: previous.actorUserId,
        mailboxId: input.mailboxId,
        scopedQueries: input.scopedQueries,
      },
      true,
    );
    if (!allowance) return;
    try {
      nextRunId = await ensureRun(
        db,
        buildActorContext(previous.actorUserId, "system"),
        {
          purpose: "mail_discovery",
          trigger: "scheduled",
          status: "running",
          clientKey,
          notes: "Continue Gmail history coverage",
          input: { ...input, ...allowance },
          progress: {
            attempt: 0,
            phase: "listing",
            pagesDone: 0,
            saved: 0,
            deleted: 0,
            excluded: 0,
            unrelated: 0,
            events: 0,
            droppedEvents: 0,
          },
        },
      );
    } catch (error) {
      if (isUniqueViolation(error, MAIL_DISCOVERY_CONSTRAINT)) return;
      throw error;
    }
  }
  await launchWorkflowRun(
    db,
    { runId: nextRunId, purpose: "mail_discovery" },
    options.launcher ?? productionWorkflowLauncher,
  );
}

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
    // A pass that filed a finding (mail from an unknown sender) owns it.
    sql.raw(
      `NOT EXISTS (SELECT 1 FROM "RunFinding" f WHERE f."runId" = "Run"."id")`,
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
