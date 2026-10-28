import { buildActorContext, type ActorContext } from "@cubby/schemas/context";
import {
  ledgerPartyId,
  runEntityId,
  userId,
  type RunId,
} from "@cubby/schemas/identifiers";
import { parseEntityId } from "@cubby/schemas/identifiers";
import { jobState } from "@cubby/schemas/job";
import {
  mailboxDiscoveryInput,
  mailboxDiscoveryProgress,
  type MailboxDiscoveryProgress,
  type MailboxCoverage,
  type MailboxDiscoveryStartOutput,
} from "@cubby/schemas/mailbox-research";
import { and, eq, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";

import type { UnparsedError } from "~/lib/error-utils";
import type { Database } from "~/server/db";
import {
  getDb,
  notDeleted,
  withTransactionDatabase,
} from "~/server/db/helpers";
import { email as emailTable, run as runTable } from "~/server/db/schema";
import { recordDiscoveryEmailReceipt } from "~/server/domains/email/repo/discovery-email-audit";
import { launchQueuedControlledMailImport } from "~/server/domains/purchase-import/operations/gmail/controlled-import";
import {
  findControlledMailImport,
  retainedControlledMailIds,
  CONTROLLED_MAIL_SOURCE_STATUSES,
  waitForActiveMailboxImports,
} from "~/server/domains/purchase-import/repo/controlled-mail-import";
import {
  listGmailSyncTargets,
  type GmailSyncTarget,
} from "~/server/domains/purchase-import/repo/gmail/targets";
import {
  GmailApiError,
  type GmailProvider,
} from "~/server/domains/purchase-import/repo/gmail/types";
import { mailImportEnabled } from "~/server/domains/purchase-import/repo/mail-import-settings";
import { HISTORICAL_MAIL_SOURCE_IDENTITY_VERSION } from "~/server/domains/purchase-import/repo/mail-source-identity";
import { ensureRun } from "~/server/domains/run/repo/ensure-run";
import { recordPaidGrant } from "~/server/domains/run/repo/paid-grant";
import { recordRunProgress } from "~/server/domains/run/repo/run-progress";
import { isUniqueViolation } from "~/server/errors/db-errors";
import { reportServerError } from "~/server/errors/report-error";
import { currentJobExecution } from "~/server/generic/jobs/context";
import type { WorkflowRunParams } from "~/server/workflows/runs/contract";
import {
  claimWorkflowRun,
  failWorkflowRun,
  launchWorkflowRun,
  runFailureText,
} from "~/server/workflows/runs/lifecycle";

import type { OrderMailAttachmentStorage } from "../../repo/gmail/attachment-storage";
import {
  checkpointMailboxCoverage,
  loadGmailCursor,
  persistGmailEvents,
} from "../../repo/gmail/persistence";
import { gmailProviderForUser } from "../../repo/gmail/provider";
import {
  creditScopedPage,
  initializeMailboxCoverage,
  listGmailPage,
  mergeMailboxQueries,
} from "../../repo/gmail/sync";
import { GmailAuthorizationError } from "../../repo/gmail/tokens";
import type { startMailImport } from "../../repo/mail-import-run";
import { ingestGmailMessages } from "../../service/gmail/ingest";
import type { MailRelevance } from "../../service/gmail/relevance";
import type { MailTriage } from "../../service/gmail/triage";

/** A history deletion only handles an identity Cubby already knows. */
export async function recordDeletedHistoryEvent(
  db: Database,
  input: {
    runId: string;
    ledgerPartyId: string;
    mailboxId: string;
    messageId: string;
  },
) {
  return withTransactionDatabase(db, async (tx) => {
    const [existing] = await getDb(tx)
      .select()
      .from(emailTable)
      .where(
        and(
          eq(
            emailTable.ledgerPartyId,
            parseEntityId("ledgerParty", input.ledgerPartyId),
          ),
          eq(emailTable.provider, "gmail"),
          eq(emailTable.mailboxId, input.mailboxId),
          eq(emailTable.messageId, input.messageId),
        ),
      )
      .for("update")
      .limit(1);
    if (!existing) return false;
    const frozen =
      existing.classificationVersion ===
      HISTORICAL_MAIL_SOURCE_IDENTITY_VERSION;
    if (!frozen && existing.status !== "deleted")
      await getDb(tx)
        .update(emailTable)
        .set({ status: "deleted" })
        .where(eq(emailTable.id, existing.id));
    await recordDiscoveryEmailReceipt(tx, {
      ...input,
      expected: existing,
      outcome: frozen ? "frozen" : "removed",
    });
    return true;
  });
}

const MAIL_DISCOVERY_CONSTRAINT = "Run_one_active_mail_discovery";
type DiscoveryMode = "new_mail" | "targeted";
/** A paginated new-mail catch-up finishes first; otherwise pending targets alternate with new mail. */
const discoveryMode = (coverage: MailboxCoverage): DiscoveryMode =>
  coverage.history.pageToken ||
  coverage.nextLane === "history" ||
  !coverage.scoped.some((query) => !query.completed)
    ? "new_mail"
    : "targeted";
const scopedQueriesPending = (
  coverage: MailboxCoverage | null,
  queries: GmailSyncTarget["scopedQueries"],
) =>
  coverage
    ? mergeMailboxQueries(coverage, queries).scoped.some(
        (query) => !query.completed,
      )
    : queries.length > 0;

/** Discovery always classifies connected mail; continuations need remaining coverage. */
async function discoveryAllowed(
  db: Database,
  target: Pick<
    GmailSyncTarget,
    "ledgerPartyId" | "mailboxId" | "scopedQueries"
  >,
) {
  const { coverage } = await loadGmailCursor(db, {
    ledgerPartyId: target.ledgerPartyId,
    mailboxId: target.mailboxId,
  });
  return (
    Boolean(coverage?.history.pageToken) ||
    scopedQueriesPending(coverage, target.scopedQueries)
  );
}
export type DiscoveryPorts = {
  providerForUser?: (userId: string) => Promise<GmailProvider>;
  storage?: OrderMailAttachmentStorage;
  triage?: MailTriage;
  relevance?: MailRelevance;
  research?: typeof startMailImport;
};
const attemptIs = (_attempt: number) => {
  const execution = currentJobExecution();
  return execution
    ? sql`EXISTS (SELECT 1 FROM "Job" j WHERE j.id=${execution.claim.id}::uuid AND j.state=${jobState.enum.running} AND j."generation"=${execution.claim.generation} AND j."leaseToken"=${execution.claim.leaseToken}::uuid AND j."leaseExpiresAt">now())`
    : sql`false`;
};
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

/** The mailbox's discovery a funding stop paused; it resumes in place. */
async function fundingPausedDiscovery(
  db: Database,
  target: Pick<GmailSyncTarget, "ledgerPartyId" | "mailboxId">,
  status: "paused_auth" | "running",
) {
  const [row] = await getDb(db)
    .select({ id: runTable.id })
    .from(runTable)
    .where(
      and(
        eq(runTable.purpose, "mail_discovery"),
        eq(runTable.ledgerPartyId, ledgerPartyId.parse(target.ledgerPartyId)),
        sql`${runTable.input}->>'mailboxId' = ${target.mailboxId}`,
        eq(runTable.status, status),
        status === "paused_auth"
          ? eq(runTable.failureCode, "execution_limit")
          : undefined,
        notDeleted(runTable),
      ),
    )
    .limit(1);
  return row;
}

/**
 * Starts discovery for each eligible mailbox. A mailbox whose discovery is
 * waiting for free AI capacity keeps that Run instead of starting another;
 * a member's `paidGrant` ("Run discovery now, paid allowed") records the
 * paid grant on the discovery it starts, resumes or joins.
 */
export async function startMailDiscovery(
  db: Database,
  options: {
    target?: Pick<GmailSyncTarget, "ledgerPartyId" | "userId" | "mailboxId">;
    paidGrant?: { actor: ActorContext; paidOverBudgetUsd?: number };
  } = {},
): Promise<MailboxDiscoveryStartOutput> {
  const grantPaid = async (runId: RunId) => {
    if (!options.paidGrant) return;
    await recordPaidGrant(db, options.paidGrant.actor, {
      runId,
      paidOverBudgetUsd: options.paidGrant.paidOverBudgetUsd,
    });
  };
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
    if (await findControlledMailImport(db, target.mailboxId)) {
      await launchQueuedControlledMailImport(db, target.mailboxId);
      running += 1;
      continue;
    }
    const waiting = await fundingPausedDiscovery(db, target, "paused_auth");
    if (waiting) {
      if (!options.paidGrant) {
        running += 1;
        continue;
      }
      await grantPaid(waiting.id);
      await launchWorkflowRun(db, {
        runId: waiting.id,
        purpose: "mail_discovery",
      });
      started += 1;
      continue;
    }
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
            emailAuditVersion: 1,
            mailboxId: target.mailboxId,
            scopedQueries: target.scopedQueries,
            executionPolicy: (await mailImportEnabled(db, target.mailboxId))
              ? "import"
              : "classification_only",
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
      const active = await fundingPausedDiscovery(db, target, "running");
      if (active) await grantPaid(active.id);
      running += 1;
      continue;
    }
    await grantPaid(runId);
    await launchWorkflowRun(db, { runId, purpose: "mail_discovery" });
    started += 1;
  }
  return { started, running };
}

export async function beginMailDiscovery(
  db: Database,
  params: WorkflowRunParams,
): Promise<{ kind: "stopped" } | { kind: "page"; index: number }> {
  const claimed = await claimDiscovery(db, params);
  if (claimed?.input.controlled && claimed.progress.pagesDone === 0)
    await waitForActiveMailboxImports(db, {
      mailboxId: claimed.input.mailboxId,
      memberId: claimed.ledgerPartyId,
      controlRunId: claimed.row.id,
    });
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
  // A new-mail catch-up keeps paginating; each targeted page is its own pass.
  const continuing = (coverage: MailboxCoverage) =>
    claimed.input.controlled
      ? coverage.scoped.some(
          (query) =>
            !query.completed &&
            claimed.input.scopedQueries.some(
              (selected) => selected.key === query.key,
            ),
        )
      : Boolean(coverage.history.pageToken);
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
        claimed.input.scopedQueries,
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
    // The member's bounded selection must not prune other searches' durable
    // positions or advance the mailbox's history cursor.
    const merged = mergeMailboxQueries(
      coverage,
      claimed.input.controlled
        ? [...coverage.scoped, ...claimed.input.scopedQueries]
        : claimed.input.scopedQueries,
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
      claimed.input.controlled ? "targeted" : discoveryMode(coverage),
      claimed.input.controlled
        ? claimed.input.scopedQueries.map((query) => query.key)
        : undefined,
    );
    const frozen = await (
      await import("~/server/domains/run/repo/ai-work-state")
    ).writeRunningAttemptProgress(
      db,
      runEntityId.parse(params.runId),
      params.attempt,
      { progress: patchProgress({ phase: "fetching", page }) },
    );
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
  const { page } = claimed.progress;
  if (!page || claimed.progress.pagesDone !== index)
    throw new Error(`Discovery page ${index} is not current`);
  try {
    const provider = await (
      ports.providerForUser ??
      ((id) => gmailProviderForUser(db, id, claimed.input.mailboxId))
    )(claimed.row.actorUserId);
    const removed = new Map(
      (page?.events ?? [])
        .filter((event) => event.kind === "message_deleted")
        .map((event) => [event.messageId, "deleted" as const]),
    );
    for (const messageId of removed.keys())
      await recordDeletedHistoryEvent(db, {
        runId: claimed.row.id,
        ledgerPartyId: claimed.ledgerPartyId,
        mailboxId: claimed.input.mailboxId,
        messageId,
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
    // Reused classifications still need import admission when automatic
    // import was previously off. Limit the replay to this selected Gmail page.
    const pageImportMailIds =
      claimed.input.controlled && page.messageIds.length
        ? (
            await getDb(db)
              .select({ id: emailTable.orderMailId })
              .from(emailTable)
              .where(
                and(
                  eq(emailTable.ledgerPartyId, claimed.ledgerPartyId),
                  eq(emailTable.mailboxId, claimed.input.mailboxId),
                  inArray(emailTable.messageId, page.messageIds),
                  eq(emailTable.classification, "related"),
                  inArray(emailTable.status, CONTROLLED_MAIL_SOURCE_STATUSES),
                  isNotNull(emailTable.orderMailId),
                  or(
                    isNull(emailTable.classificationVersion),
                    ne(
                      emailTable.classificationVersion,
                      HISTORICAL_MAIL_SOURCE_IDENTITY_VERSION,
                    ),
                  ),
                  notDeleted(emailTable),
                ),
              )
          ).flatMap((row) => (row.id ? [row.id] : []))
        : ingested.orderMailIds;
    const importMailIds = [
      ...new Set([
        ...pageImportMailIds,
        ...(claimed.input.controlled && index === 0
          ? await retainedControlledMailIds(db, claimed.row.id)
          : []),
      ]),
    ];
    const retained = [
      ...new Set([...(page.retainedOrderMailIds ?? []), ...pageImportMailIds]),
    ];
    if (retained.length !== (page.retainedOrderMailIds?.length ?? 0)) {
      const [saved] = await getDb(db)
        .update(runTable)
        .set({
          progress: patchProgress({
            page: { ...page, retainedOrderMailIds: retained },
          }),
        })
        .where(eligibleAttempt(params))
        .returning({ id: runTable.id });
      if (!saved) return { kind: "stopped" };
    }
    for (
      let offset = 0;
      claimed.input.executionPolicy === "import" &&
      offset < importMailIds.length;
      offset += 50
    ) {
      if (!(await claimDiscovery(db, params))) return { kind: "stopped" };
      const results = await (
        ports.research ??
        (await import("../../repo/mail-import-run")).startMailImport
      )(db, {
        ledgerPartyId: claimed.ledgerPartyId,
        userId: claimed.row.actorUserId,
        parentRunId: claimed.row.id,
        automatic: true,
        mailboxId: claimed.input.mailboxId,
        messageIds: importMailIds.slice(offset, offset + 50),
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
      if (
        !(await checkpointMailboxCoverage(tx, {
          ledgerPartyId: claimed.ledgerPartyId,
          mailboxId: claimed.input.mailboxId,
          from: page.startCoverage,
          to: creditScopedPage(page, retained.length, new Date()),
        }))
      )
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
      await recordRunProgress(tx, {
        runId: current.row.id,
        eventId: `gmail:${params.attempt}:page:${index}`,
        generation: `workflow:${params.attempt}`,
        sequence: index + 1,
        phase: "page_saved",
        detail: `Processed Gmail page ${index + 1}; ${ingested.orderMailIds.length} sources retained, ${ingested.unrelated.length} unrelated messages`,
      });
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
  if (finished)
    await recordRunProgress(
      db,
      {
        runId: finished.id,
        eventId: `gmail:${params.attempt}:completed`,
        generation: `workflow:${params.attempt}`,
        sequence: claimed.progress.pagesDone + 1,
        phase: "completed",
        detail: "Gmail discovery pass completed",
      },
      now,
    );
  return finished ? { kind: "done" } : { kind: "stopped" };
}

/** Admit the next bounded history pass through its durable Job. */
export async function continueMailDiscovery(
  db: Database,
  params: WorkflowRunParams,
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
  const control = await findControlledMailImport(db, input.mailboxId);
  if (control) {
    await launchQueuedControlledMailImport(db, input.mailboxId);
    return;
  }
  // A selected Vendor finishes in this Run; it never fans out to the history lane.
  if (input.controlled) return;
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
    if (
      !(await discoveryAllowed(db, {
        ledgerPartyId: previous.ledgerPartyId,
        mailboxId: input.mailboxId,
        scopedQueries: input.scopedQueries,
      }))
    )
      return;
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
          input: { ...input, emailAuditVersion: 1 },
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
  await launchWorkflowRun(db, { runId: nextRunId, purpose: "mail_discovery" });
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
