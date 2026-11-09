import type { ActorContext } from "@cubby/schemas/context";
import { entityRefKey } from "@cubby/schemas/entity";
import {
  userId,
  parseEntityRef,
  runEntityId,
  vendorAccountId,
  type RunId,
  type VendorId,
} from "@cubby/schemas/identifiers";
import {
  agentImportRunPurpose,
  coordinatorModelFor,
  importRunAgentIdentity,
} from "@cubby/schemas/import-run-agent";
import { paidOverBudgetUsd } from "@cubby/schemas/mail-import-settings";
import {
  type AgentFailureCode,
  type AgentProgressEvent,
  agentProgressEvent,
} from "@cubby/schemas/purchase-agent-services";
import {
  extractedPurchaseLine,
  preparePurchaseImportOut,
  commitPurchaseImportOut,
} from "@cubby/schemas/purchase-import";
import {
  runShortcode,
  runPurpose,
  runScope,
} from "@cubby/schemas/purchase-import";
import { purchaseImportDebugEvent } from "@cubby/schemas/purchase-import-debug";
import {
  chargeHuntRunInput,
  researchObjectivesRunInput,
  mailResearchRunInput,
  orderBackfillRunInput,
  orderMailImportRunInput,
  orderMailImportRunOrders,
  isMemberStartedRun,
  type RunRestartInput,
  runInputsErased,
  runRetirementReason,
} from "@cubby/schemas/run-fields";
import { ACTIVE_RUN_STATUSES } from "@cubby/shared/client-constants";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  not,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import { z } from "zod";

import type { RunDetail, RunLogEntry } from "~/contracts/run.contract";
import type { Database, DrizzleClient, DrizzleTransaction } from "~/server/db";
import { vendorAccountLabelSql } from "~/server/db/computed/vendor-account-label";
import { getDb, notDeleted, withTransaction } from "~/server/db/helpers";
import { outer, related } from "~/server/db/helpers/related";
import {
  aiUsage,
  auditLog,
  entityIdentity,
  importPreparedLine,
  importPreparedOrder,
  ledgerParty,
  purchase,
  run as runTable,
  runControlEvent,
  runOperation,
  vendor,
  vendorAccount,
} from "~/server/db/schema";
import {
  loadRunController,
  loadRunControlScopeByShortcode,
} from "~/server/domains/run/repo/control-scope";
import { dispatchStartedRun } from "~/server/domains/run/repo/coordinator-dispatch";
import {
  runPurposeLifecycle,
  type RunTargetRow,
} from "~/server/domains/run/repo/purpose-lifecycle";
import {
  readRunPurpose,
  runPurposePolicy,
} from "~/server/domains/run/repo/purpose-policy";
import { getRunHeaderByShortcode } from "~/server/domains/run/repo/run";
import {
  DEBUG_EVENT_KIND,
  failOperationsForRun,
} from "~/server/domains/run/repo/run-operation";
import { recordRunProgress } from "~/server/domains/run/repo/run-progress";
import { createAppError } from "~/server/errors/app-error";
import { recordChange } from "~/server/generic/changes/repo/change";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";

import { loadRunFindings } from "./run-finding";
import { listRunTargetOutcomes } from "./run-target";

/**
 * The target outcome receipts of a Run without its own roster, with the
 * public codes its detail shows.
 */
async function receiptTargets(
  client: DrizzleClient | DrizzleTransaction,
  runId: RunId,
) {
  const receipts = await listRunTargetOutcomes(client, [runId]);
  const identities = receipts.length
    ? await client
        .select({ id: entityIdentity.id, shortcode: entityIdentity.shortcode })
        .from(entityIdentity)
        .where(
          inArray(
            entityIdentity.id,
            receipts.map((receipt) => receipt.entityId),
          ),
        )
    : [];
  const accountIds = receipts.flatMap((receipt) =>
    receipt.vendorAccountId
      ? [vendorAccountId.parse(receipt.vendorAccountId)]
      : [],
  );
  const accounts = accountIds.length
    ? await client
        .select({
          id: vendorAccount.id,
          shortcode: vendorAccount.shortcode,
          label: vendorAccountLabelSql,
        })
        .from(vendorAccount)
        .where(inArray(vendorAccount.id, accountIds))
    : [];
  return receipts.map((receipt) => ({
    ...receipt,
    position: receipt.position ?? null,
    vendorAccountId: receipt.vendorAccountId ?? null,
    vendorAccountCode:
      accounts.find((account) => account.id === receipt.vendorAccountId)
        ?.shortcode ?? null,
    vendorAccountLabel:
      accounts.find((account) => account.id === receipt.vendorAccountId)
        ?.label ?? null,
    sourceKind: receipt.sourceKind ?? null,
    sourceExternalKey: receipt.sourceExternalKey ?? null,
    entityCode:
      identities.find((identity) => identity.id === receipt.entityId)
        ?.shortcode ?? null,
    completedAt: receipt.completedAt ? new Date(receipt.completedAt) : null,
  }));
}
/**
 * A Run's roster: its purpose's own targets, or its outcome receipts when the
 * purpose keeps none.
 */
async function runTargets(
  client: DrizzleClient | DrizzleTransaction,
  run: { id: RunId; purpose: string },
): Promise<RunTargetRow[]> {
  const lifecycle = await runPurposeLifecycle(run.purpose);
  return lifecycle
    ? lifecycle.targets(client, run.id)
    : receiptTargets(client, run.id);
}

/** The authoritative roster and latest applicable outcomes used by shared Run progress. */
export function readRunProgressTargets(
  db: Database,
  run: { id: RunId; purpose: string },
) {
  return runTargets(getDb(db), run);
}

/**
 * Consumer-side fence: only the active event generation may admit the agent.
 */
export async function acknowledgeRunCoordinator(
  db: Database,
  input: { runId: RunId; eventId: string },
) {
  const [run] = await getDb(db)
    .update(runTable)
    .set({
      coordinatorStartedAt: new Date(),
      dispatchError: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(runTable.id, runEntityId.parse(input.runId)),
        eq(runTable.dispatchEventId, input.eventId),
        eq(runTable.status, "running"),
        isNull(runTable.coordinatorStartedAt),
      ),
    )
    .returning({ id: runTable.id });
  return Boolean(run);
}

/**
 * Read-only consumer fence before agent admission.
 */
export async function canDispatchRunCoordinator(
  db: Database,
  input: { runId: RunId; eventId: string },
) {
  const runId = runEntityId.parse(input.runId);
  await (
    await runPurposeLifecycle(await readRunPurpose(db, runId))
  )?.beforeCoordinatorAdmission?.(db, runId);
  const [run] = await getDb(db)
    .select({ id: runTable.id })
    .from(runTable)
    .where(
      and(
        eq(runTable.id, runEntityId.parse(input.runId)),
        eq(runTable.dispatchEventId, input.eventId),
        eq(runTable.status, "running"),
        isNull(runTable.coordinatorStartedAt),
      ),
    )
    .limit(1);
  return Boolean(run);
}

export async function loadRunScope(db: Database, runId: RunId) {
  const parsedRunId = runEntityId.parse(runId);
  const [row] = await getDb(db)
    .select({
      runId: runTable.id,
      publicId: runTable.shortcode,
      agentId: runTable.agentSessionId,
      trigger: runTable.trigger,
      purpose: runTable.purpose,
      status: runTable.status,
      vendorAccountId: runTable.vendorAccountId,
      vendorId: sql<VendorId | null>`coalesce(${runTable.vendorId}, ${vendor.id})`,
      vendorLabel: sql<string | null>`${vendorAccountLabelSql}`,
      allowedHosts: vendor.browserDomains,
      navigationHints: vendor.agentHints,
      website: vendor.website,
      ledgerPartyId: runTable.ledgerPartyId,
      actorUserId: runTable.actorUserId,
      coordinatorModel: runTable.coordinatorModel,
      skillRevision: runTable.skillRevision,
      runtimeRevision: runTable.runtimeRevision,
      dispatchEventId: runTable.dispatchEventId,
      dispatchError: runTable.dispatchError,
      coordinatorStartedAt: runTable.coordinatorStartedAt,
      runUpdatedAt: runTable.updatedAt,
    })
    .from(runTable)
    .leftJoin(
      vendorAccount,
      and(
        eq(vendorAccount.id, runTable.vendorAccountId),
        notDeleted(vendorAccount),
      ),
    )
    .leftJoin(
      vendor,
      and(
        or(
          eq(vendor.id, runTable.vendorId),
          eq(vendor.id, vendorAccount.vendorId),
        ),
        notDeleted(vendor),
      ),
    )
    .innerJoin(
      ledgerParty,
      and(eq(ledgerParty.id, runTable.ledgerPartyId), notDeleted(ledgerParty)),
    )
    .where(eq(runTable.id, parsedRunId))
    .limit(1);
  // Only runs that group AI work lack a party, and they have no import scope.
  if (!row || !row.agentId || !row.actorUserId || !row.ledgerPartyId)
    throw new Error("Import run ownership is unavailable");
  return {
    public: runScope.parse({
      runId: row.runId,
      shortcode: row.publicId,
      agentId: row.agentId,
      trigger: row.trigger,
      purpose: row.purpose,
      status: row.status,
      vendorAccountId: row.vendorAccountId,
      vendorLabel: row.vendorLabel,
      allowedHosts: row.allowedHosts ?? [],
      navigationHints: row.navigationHints,
      coordinatorModel: row.coordinatorModel,
      skillRevision: row.skillRevision,
      runtimeRevision: row.runtimeRevision,
      dispatchEventId: row.dispatchEventId,
      dispatchError: row.dispatchError,
      coordinatorStartedAt: row.coordinatorStartedAt?.toISOString() ?? null,
    }),
    website: row.website,
    ledgerPartyId: row.ledgerPartyId,
    vendorId: row.vendorId,
    actorUserId: row.actorUserId,
    runUpdatedAt: row.runUpdatedAt,
  };
}

export async function loadRunScopeByShortcode(db: Database, publicId: string) {
  const parsedPublicId = runShortcode.parse(publicId);
  const [row] = await getDb(db)
    .select({ id: runTable.id })
    .from(runTable)
    .where(eq(runTable.shortcode, parsedPublicId))
    .limit(1);
  if (!row) throw new Error("Purchase import run was not found");
  return loadRunScope(db, row.id);
}

export async function updateAgentProgress(
  db: Database,
  rawInput: AgentProgressEvent,
) {
  const input = agentProgressEvent.parse(rawInput);
  return recordRunProgress(db, input);
}

export async function pauseRunForAuthorization(db: Database, runId: RunId) {
  const [run] = await getDb(db)
    .update(runTable)
    .set({ status: "paused_auth", updatedAt: new Date() })
    .where(
      and(
        eq(runTable.id, runEntityId.parse(runId)),
        eq(runTable.status, "running"),
      ),
    )
    .returning({ publicId: runTable.shortcode });
  return run ?? null;
}

export async function resumeAuthorizedRuns(
  db: Database,
  actorUserId: string,
  now = new Date(),
) {
  const owner = userId.parse(actorUserId);
  const repairCutoff = new Date(now.getTime() - 60_000);
  return withTransaction(db, async (tx) => {
    const resumed = await tx
      .update(runTable)
      .set({
        status: "running",
        dispatchEventId: sql`gen_random_uuid()`,
        dispatchError: null,
        failureCode: null,
        endedAt: null,
        coordinatorStartedAt: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(runTable.actorUserId, owner),
          eq(runTable.status, "paused_auth"),
          inArray(runTable.purpose, [...agentImportRunPurpose.options]),
          notDeleted(runTable),
          isNull(runTable.retiredAt),
        ),
      )
      .returning({
        id: runTable.id,
        publicId: runTable.shortcode,
        purpose: runTable.purpose,
        eventId: runTable.dispatchEventId,
      });
    const interrupted = await tx
      .select({
        id: runTable.id,
        publicId: runTable.shortcode,
        purpose: runTable.purpose,
        eventId: runTable.dispatchEventId,
      })
      .from(runTable)
      .where(
        and(
          eq(runTable.actorUserId, owner),
          eq(runTable.status, "running"),
          inArray(runTable.purpose, [...agentImportRunPurpose.options]),
          notDeleted(runTable),
          isNull(runTable.retiredAt),
          isNull(runTable.coordinatorStartedAt),
          isNotNull(runTable.dispatchEventId),
          lt(runTable.updatedAt, repairCutoff),
        ),
      );
    for (const item of [...resumed, ...interrupted])
      if (item.eventId)
        await dispatchStartedRun(tx, { ...item, eventId: item.eventId });
    return [...resumed, ...interrupted];
  });
}

/**
 * A funding-paused import an older coordinator stopped for review while its
 * targets were still pending. It is waiting for AI funding, not for review:
 * resume and the funding window both continue it.
 *
 * Retry and restart leave the predecessor in `needs_review` with its
 * `execution_limit` code, but its unresolved targets now belong to the
 * successor (photo targets are copied, Mail sources transferred). A
 * predecessor with any successor is therefore never funding-resumable.
 */
const isFundingStoppedForReview = (row: {
  status: string;
  failureCode: string | null;
  hasSuccessor: boolean;
}) =>
  row.status === "needs_review" &&
  row.failureCode === "execution_limit" &&
  !row.hasSuccessor;

/** Resume only funding-paused imports; manual and authorization pauses stay stopped. */

export async function redispatchBudgetPausedImports(
  db: Database,
  now = new Date(),
  pausedBefore = now,
) {
  return withTransaction(db, async (tx) => {
    const resumed = await tx
      .update(runTable)
      .set({
        status: "running",
        dispatchEventId: sql`gen_random_uuid()`,
        dispatchError: null,
        failureCode: null,
        endedAt: null,
        coordinatorStartedAt: null,
        updatedAt: now,
      })
      .where(
        and(
          inArray(runTable.status, ["paused_auth", "needs_review"]),
          eq(runTable.failureCode, "execution_limit"),
          inArray(runTable.purpose, [...agentImportRunPurpose.options]),
          lt(runTable.updatedAt, pausedBefore),
          notDeleted(runTable),
          isNull(runTable.retiredAt),
          // The work moved even if the successor was deleted.
          not(
            related(
              runTable,
              (successor) => eq(successor.predecessorRunId, outer(runTable.id)),
              { includeDeleted: true },
            ).exists(),
          ),
        ),
      )
      .returning({
        id: runTable.id,
        purpose: runTable.purpose,
        eventId: runTable.dispatchEventId,
      });
    for (const item of resumed)
      if (item.eventId)
        await dispatchStartedRun(tx, { ...item, eventId: item.eventId });
    return resumed.length;
  });
}

export async function pauseAuthorizedRuns(db: Database, actorUserId: string) {
  return getDb(db)
    .update(runTable)
    .set({ status: "paused_auth", updatedAt: new Date() })
    .where(
      and(
        eq(runTable.actorUserId, userId.parse(actorUserId)),
        eq(runTable.status, "running"),
      ),
    )
    .returning({ id: runTable.id });
}

/**
 * Historical provider-pagination and mailbox-binding receipts: host authority,
 * never shown as Run evidence.
 */
const PRIVATE_OPERATION_KINDS = [
  "mail_extraction_attempt",
  "research_mail_scope",
  "research_mail_choice",
  "research_mail_page",
  "research_mail_continuation",
] as const;

const PUBLIC_OPERATION_COLUMNS = {
  operationId: runOperation.operationId,
  kind: runOperation.kind,
  state: runOperation.state,
  error: runOperation.error,
  startedAt: runOperation.startedAt,
  completedAt: runOperation.completedAt,
};
const publicRunOperations = (runId: RunId) =>
  and(
    eq(runOperation.runId, runId),
    notInArray(runOperation.kind, [...PRIVATE_OPERATION_KINDS]),
  );

export const STALE_RUN_MS = 2 * 60 * 60_000;

export const assertRunActive = (status: string) => {
  if (status !== "running")
    throw new Error(`Import run is fenced in status ${status}`);
};

/**
 * Called through the `PurchaseImportService` RPC namespace in cf-server.ts.
 * The purpose's lifecycle decides what a failure leaves behind.
 */
export async function markRunFailed(
  db: Database,
  input: {
    runId: RunId;
    failureCode: AgentFailureCode;
    detail?: string;
    dispatchEventId?: string | null;
  },
) {
  const runId = runEntityId.parse(input.runId);
  const run = await withTransaction(db, async (tx) => {
    const [failed] = await tx
      .update(runTable)
      .set({
        status: "failed",
        failureCode: input.failureCode,
        // The Run page's raw failure text, as `failWorkflowRun` records it.
        ...(input.detail !== undefined && { dispatchError: input.detail }),
        endedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(runTable.id, runId),
          eq(runTable.status, "running"),
          input.dispatchEventId === undefined
            ? undefined
            : input.dispatchEventId === null
              ? isNull(runTable.dispatchEventId)
              : eq(runTable.dispatchEventId, input.dispatchEventId),
        ),
      )
      .returning({
        purpose: runTable.purpose,
        trigger: runTable.trigger,
        ledgerPartyId: runTable.ledgerPartyId,
      });
    if (!failed) return failed;
    await recordChange(tx, {
      kind: "source",
      categories: ["run"],
      ringFromBackground: isMemberStartedRun(failed),
    });
    await (
      await runPurposeLifecycle(failed.purpose)
    )?.failed?.(tx, {
      runId,
      ledgerPartyId: failed.ledgerPartyId,
      failureCode: input.failureCode,
      detail: input.detail,
    });
    return failed;
  });
  return { failed: Boolean(run), detail: input.detail ?? null };
}

const iso = (value: Date | null) => value?.toISOString() ?? null;

async function loadPreparedReviewRows(db: Database, runId: RunId) {
  const database = getDb(db);
  return database
    .select({
      orderId: importPreparedOrder.id,
      stableOrderId: importPreparedOrder.stableOrderId,
      prepareOperationId: importPreparedOrder.prepareOperationId,
      itemOperationId: importPreparedOrder.itemOperationId,
      sourceKind: importPreparedOrder.sourceKind,
      externalKey: importPreparedOrder.sourceExternalKey,
      preparedAt: importPreparedOrder.createdAt,
      stableLineId: importPreparedLine.stableLineId,
      line: importPreparedLine.line,
      identifiers: importPreparedLine.identifiers,
      candidates: importPreparedLine.candidates,
    })
    .from(importPreparedOrder)
    .leftJoin(
      importPreparedLine,
      eq(importPreparedLine.preparedOrderId, importPreparedOrder.id),
    )
    .where(eq(importPreparedOrder.runId, runId))
    .orderBy(
      asc(importPreparedOrder.createdAt),
      asc(importPreparedOrder.id),
      asc(importPreparedLine.position),
    );
}

function projectPreparedOrders(
  rows: Awaited<ReturnType<typeof loadPreparedReviewRows>>,
  operations: Pick<
    typeof runOperation.$inferSelect,
    "kind" | "state" | "result"
  >[],
): RunDetail["preparedOrders"] {
  const committedOrders = new Set<string>();
  for (const operation of operations) {
    if (
      operation.kind !== "commit_purchase_import" ||
      operation.state !== "completed"
    )
      continue;
    const result = commitPurchaseImportOut.safeParse(operation.result);
    if (result.success) {
      for (const item of result.data.items)
        committedOrders.add(item.stableOrderId);
    }
  }
  const reviewOrders = new Map<string, RunDetail["preparedOrders"][number]>();
  for (const row of rows) {
    let order = reviewOrders.get(row.orderId);
    if (!order) {
      order = {
        stableOrderId: row.stableOrderId,
        prepareOperationId: row.prepareOperationId,
        itemOperationId: row.itemOperationId,
        sourceKind: row.sourceKind,
        externalKey: row.externalKey,
        preparedAt: row.preparedAt.toISOString(),
        committed: committedOrders.has(row.stableOrderId),
        lineCount: 0,
        lines: [],
      };
      reviewOrders.set(row.orderId, order);
    }
    if (row.stableLineId !== null) {
      const line = extractedPurchaseLine.parse(row.line);
      order.lines.push(
        preparePurchaseImportOut.shape.orders.element.shape.lines.element.parse(
          {
            stableLineId: row.stableLineId,
            title: line.title,
            amount: line.amount,
            identifiers: row.identifiers,
            candidates: row.candidates,
            requiresProductResolution: line.lineKind === "principal",
          },
        ),
      );
      order.lineCount++;
    }
  }
  return [...reviewOrders.values()];
}

/**
 * The run detail every browser and native surface reads: the kernel
 * `run` row plus its child collections, projected once. Private UUIDs
 * and operation payloads never cross this boundary.
 */
/** What a restart copies from `Run.input`, by public values only. */
function restartInputSummary(
  input: unknown,
  vendorRef: string | null,
): RunRestartInput | null {
  const researchMail = mailResearchRunInput.safeParse(input);
  if (researchMail.success)
    return {
      kind: researchMail.data.kind,
      sourceCount: researchMail.data.sources.length,
    };
  const parsedObjectives = researchObjectivesRunInput.safeParse(input);
  const objectives = parsedObjectives.success ? parsedObjectives.data : null;
  if (objectives) {
    const single =
      objectives.objectives.length === 1 ? objectives.objectives[0] : null;
    if (single?.kind === "vendor_purchases" && vendorRef)
      return { ...single, vendorId: vendorRef };
    const charges = objectives.objectives.flatMap((objective) =>
      objective.kind === "charge_hunt" ? [objective.huntId] : [],
    );
    if (charges.length)
      return { kind: "charge_hunts", chargeCount: charges.length };
    const history = objectives.objectives.find(
      (objective) => objective.kind === "account_history",
    );
    if (history?.kind === "account_history" && history.range)
      return { kind: "order_backfill", ...history.range };
    return null;
  }
  const mail = orderMailImportRunInput.safeParse(input);
  if (mail.success)
    return {
      kind: "order_mail_import" as const,
      orderIds: orderMailImportRunOrders(mail.data).map(
        (order) => order.orderId,
      ),
    };
  const backfill = orderBackfillRunInput.safeParse(input);
  if (backfill.success) return backfill.data;
  const charges = chargeHuntRunInput.safeParse(input);
  if (charges.success)
    return {
      kind: "charge_hunts" as const,
      chargeCount: charges.data.huntIds.length,
    };
  return null;
}

/** A durable timeline needs public operation metadata, never result payloads
 * or the import-specific targets and restart context. */
export async function loadRunTimeline(
  db: Database,
  runId: RunId,
): Promise<RunDetail["operations"]> {
  const operations = await getDb(db)
    .select(PUBLIC_OPERATION_COLUMNS)
    .from(runOperation)
    .where(publicRunOperations(runId))
    .orderBy(asc(runOperation.startedAt));
  return operations.map((operation) => ({
    ...operation,
    startedAt: operation.startedAt.toISOString(),
    completedAt: iso(operation.completedAt),
  }));
}

export async function loadRunDetail(
  db: Database,
  shortcode: string,
  preparedHeader?: ReturnType<typeof getRunHeaderByShortcode>,
): Promise<RunDetail> {
  const publicId = runShortcode.parse(shortcode);
  const database = getDb(db);
  const [header, [run]] = await Promise.all([
    preparedHeader ?? getRunHeaderByShortcode(db, publicId),
    database
      .select({
        id: runTable.id,
        dispatchEventId: runTable.dispatchEventId,
        retirementReason: runTable.retirementReason,
        purpose: runTable.purpose,
        progressHistory: runTable.progressHistory,
        actorLedgerPartyShortcode: runTable.actorLedgerPartyShortcode,
        actorLedgerPartyName: runTable.actorLedgerPartyName,
        input: runTable.input,
      })
      .from(runTable)
      .where(and(eq(runTable.shortcode, publicId), notDeleted(runTable)))
      .limit(1),
  ]);
  if (!header || !run) throw new Error("Import run was not found");

  const [
    successor,
    operations,
    preparedOrders,
    progress,
    affectedPurchases,
    findings,
    controlHistory,
    targets,
    agentModelUsage,
  ] = await Promise.all([
    database
      .select({ publicId: runTable.shortcode })
      .from(runTable)
      .where(eq(runTable.predecessorRunId, run.id))
      .orderBy(desc(runTable.startedAt))
      .limit(1),
    database
      .select({
        ...PUBLIC_OPERATION_COLUMNS,
        result: runOperation.result,
      })
      .from(runOperation)
      .where(publicRunOperations(run.id))
      .orderBy(asc(runOperation.startedAt)),
    loadPreparedReviewRows(db, run.id),
    Promise.resolve(run.progressHistory ?? []),
    database
      .selectDistinct({
        shortcode: purchase.shortcode,
        displayName: purchase.displayLabel,
        orderId: purchase.orderId,
      })
      .from(auditLog)
      .innerJoin(
        purchase,
        and(eq(purchase.id, auditLog.entityId), notDeleted(purchase)),
      )
      .where(
        and(eq(auditLog.runId, run.id), eq(auditLog.entityKind, "purchase")),
      ),
    loadRunFindings(db, run.id),
    database
      .select({
        action: runControlEvent.action,
        userId: runControlEvent.controllerUserId,
        name: runControlEvent.controllerName,
        ledgerPartyId: runControlEvent.controllerLedgerPartyShortcode,
        ledgerPartyName: runControlEvent.controllerLedgerPartyName,
        createdAt: runControlEvent.createdAt,
      })
      .from(runControlEvent)
      .where(eq(runControlEvent.runId, run.id))
      .orderBy(asc(runControlEvent.createdAt)),
    runTargets(database, run),
    database
      .select({
        durationMs: sql<number>`coalesce(sum(${aiUsage.durationMs}), 0)`,
      })
      .from(aiUsage)
      .where(
        and(
          eq(aiUsage.runId, run.id),
          eq(aiUsage.feature, "purchase_import_agent"),
        ),
      ),
  ]);
  const { lookupEntityLabels } =
    await import("~/server/generic/shortcode/repo/shortcode-resolver");
  const targetNames = await lookupEntityLabels(
    db,
    targets.map((target) => parseEntityRef(target.entityKind, target.entityId)),
  );
  const publicSourceKey = (
    target: Pick<(typeof targets)[number], "sourceKind" | "sourceExternalKey">,
  ) => {
    if (target.sourceKind === "mail_message") return null;
    return target.sourceKind === "vendor_purchases"
      ? header.vendorId
      : target.sourceExternalKey;
  };
  const controller = (event: (typeof controlHistory)[number]) => ({
    name: event.name,
    ledgerParty: { id: event.ledgerPartyId, name: event.ledgerPartyName },
  });
  const browserProgress = progress.map((event) => ({
    eventId: event.eventId,
    phase: event.phase,
    currentItem: event.currentItem,
    awaitingApproval: event.awaitingApproval,
    detail: event.detail,
    createdAt: event.createdAt,
  }));
  return {
    publicId,
    status: header.status,
    purpose: header.purpose,
    trigger: header.trigger,
    parentRunId: header.parentRunId,
    cause: header.cause,
    attempt: header.attempt,
    source: { kind: header.trigger, vendorName: header.vendorName },
    actor: {
      name: header.actorName,
      ledgerParty: {
        id: run.actorLedgerPartyShortcode,
        name: run.actorLedgerPartyName,
      },
    },
    vendorAccount:
      header.vendorAccountId && header.vendorAccountLabel
        ? { id: header.vendorAccountId, label: header.vendorAccountLabel }
        : null,
    startedAt: header.startedAt.toISOString(),
    endedAt: iso(header.endedAt),
    ordersSeen: header.ordersSeen,
    imported: header.imported,
    updated: header.updated,
    skipped: header.skipped,
    failureCode: header.failureCode,
    notes: header.notes,
    retirementReason: runRetirementReason
      .nullable()
      .parse(run.retirementReason),
    dispatch: {
      eventId: run.dispatchEventId,
      state: header.coordinatorStartedAt
        ? "started"
        : header.dispatchError
          ? "failed"
          : "pending",
      error: header.dispatchError,
      coordinatorStartedAt: iso(header.coordinatorStartedAt),
    },
    predecessorRunPublicId: header.predecessorRunId
      ? runShortcode.parse(header.predecessorRunId)
      : null,
    successorRunPublicId: successor[0]
      ? runShortcode.parse(successor[0].publicId)
      : null,
    // What `restart` writes to its successor: this run's settings and targets.
    // An erased Run has nothing left to copy.
    restartInputs:
      agentImportRunPurpose.safeParse(header.purpose).success &&
      !runInputsErased(run.retirementReason)
        ? {
            purpose: header.purpose,
            trigger: "manual",
            coordinatorModel: coordinatorModelFor(header.purpose),
            vendor: header.vendorId,
            vendorAccount: header.vendorAccountId,
            input: restartInputSummary(run.input, header.vendorId),
            notes: header.notes,
            skillRevision: header.skillRevision,
            runtimeRevision: header.runtimeRevision,
            targets: targets.map((target) => ({
              position: target.position,
              image: target.entityKind === "image" ? target.entityCode : null,
              purchase:
                target.entityKind === "purchase" ? target.entityCode : null,
              product:
                target.entityKind === "product" ? target.entityCode : null,
              vendorAccount: target.vendorAccountCode,
              sourceKind: target.sourceKind,
              sourceExternalKey: publicSourceKey(target),
              targetFingerprint:
                target.sourceKind === "mail_message"
                  ? null
                  : target.targetFingerprint,
            })),
          }
        : null,
    coordinatorModel: header.coordinatorModel,
    skillRevision: header.skillRevision,
    runtimeRevision: header.runtimeRevision,
    agentModelMs: Number(agentModelUsage[0]?.durationMs ?? 0),
    operations: operations.map(({ result: _result, ...operation }) => ({
      ...operation,
      startedAt: operation.startedAt.toISOString(),
      completedAt: iso(operation.completedAt),
    })),
    preparedOrders: projectPreparedOrders(preparedOrders, operations),
    targets: targets.map((target) => ({
      id: target.id,
      targetType: target.entityKind,
      // Image targets need their IMG- code too: photos often share a filename.
      targetShortcode: target.entityCode,
      targetName:
        targetNames.get(entityRefKey(target.entityKind, target.entityId)) ??
        null,
      sourceId: null,
      sourceLabel: target.sourceKind
        ? `${target.sourceKind}${publicSourceKey(target) ? ` · ${publicSourceKey(target)}` : ""}`
        : null,
      vendorAccountLabel: target.vendorAccountLabel,
      state: target.state,
      fingerprint:
        target.sourceKind === "mail_message" ? null : target.targetFingerprint,
      outcome: target.outcome,
      warning: target.warning,
      diff: z
        .json()
        .nullable()
        .parse(target.diff ?? null),
      completedAt: iso(target.completedAt),
    })),
    affectedPurchases,
    findings,
    controllingMembers: [
      ...new Map(
        controlHistory.map((event) => [event.userId, controller(event)]),
      ).values(),
    ],
    controlHistory: controlHistory.map((event) => ({
      action: event.action,
      ...controller(event),
      createdAt: event.createdAt.toISOString(),
    })),
    progress: browserProgress,
    latestProgress: browserProgress.at(-1) ?? null,
  };
}

const MAX_LOG_ENTRIES = 2_000;

const emptyLogMetadata = {
  commandId: null,
  operationId: null,
  operationKind: null,
  host: null,
  browser: null,
  attempt: null,
  count: null,
  outcome: null,
  messageType: null,
  errorType: null,
  errorCode: null,
  error: null,
} as const;

function debugOperationLogEntry(
  operation: Parameters<typeof operationLogEntry>[0],
): RunLogEntry | null {
  const event = purchaseImportDebugEvent.safeParse(operation.result);
  if (!event.success) return null;
  return {
    id: operation.id,
    occurredAt: event.data.occurredAt,
    source: "mac",
    level:
      event.data.outcome?.startsWith("failed:") || event.data.errorType
        ? "error"
        : "debug",
    event: event.data.event,
    state: operation.state,
    commandId: event.data.commandId ?? null,
    operationId: event.data.operationId ?? null,
    operationKind: event.data.operationKind ?? null,
    host: event.data.host ?? null,
    browser: event.data.browser ?? null,
    attempt: event.data.attempt ?? null,
    count: event.data.count ?? null,
    outcome: event.data.outcome ?? null,
    messageType: event.data.messageType ?? null,
    errorType: event.data.errorType ?? null,
    errorCode: event.data.errorCode ?? null,
    error: null,
  };
}

function operationLogEntry(
  operation: Pick<
    typeof runOperation.$inferSelect,
    "id" | "operationId" | "kind" | "state" | "result" | "error" | "startedAt"
  >,
): RunLogEntry | null {
  if (operation.kind === DEBUG_EVENT_KIND)
    return debugOperationLogEntry(operation);

  return {
    id: operation.id,
    occurredAt: operation.startedAt.toISOString(),
    source: "server",
    level: operation.state === "failed" ? "error" : "info",
    event: `tool.${operation.kind}`,
    state: operation.state,
    ...emptyLogMetadata,
    operationId: operation.operationId,
    error: operation.error?.slice(0, 300) ?? null,
  };
}

/** Server tool calls and Mac bridge debug events, in occurrence order. */
export async function loadRunLog(db: Database, shortcode: string) {
  const database = getDb(db);
  const [run] = await database
    .select({
      id: runTable.id,
      status: runTable.status,
      failureCode: runTable.failureCode,
      startedAt: runTable.startedAt,
      endedAt: runTable.endedAt,
    })
    .from(runTable)
    .where(eq(runTable.shortcode, runShortcode.parse(shortcode)))
    .limit(1);
  if (!run) throw new Error("Import run was not found");
  const operations = await database
    .select({
      id: runOperation.id,
      operationId: runOperation.operationId,
      kind: runOperation.kind,
      state: runOperation.state,
      result: runOperation.result,
      error: runOperation.error,
      startedAt: runOperation.startedAt,
    })
    .from(runOperation)
    .where(
      and(
        eq(runOperation.runId, run.id),
        notInArray(runOperation.kind, [...PRIVATE_OPERATION_KINDS]),
      ),
    )
    .orderBy(asc(runOperation.startedAt), asc(runOperation.id))
    .limit(MAX_LOG_ENTRIES + 1);

  const entries: RunLogEntry[] = [
    {
      id: `run:${run.id}:started`,
      occurredAt: run.startedAt.toISOString(),
      source: "run",
      level: "info",
      event: "run.started",
      state: "running",
      ...emptyLogMetadata,
    },
    ...operations
      .slice(0, MAX_LOG_ENTRIES)
      .flatMap((operation) => operationLogEntry(operation) ?? []),
  ];
  if (run.endedAt) {
    entries.push({
      id: `run:${run.id}:ended`,
      occurredAt: run.endedAt.toISOString(),
      source: "run",
      level: run.status === "failed" ? "error" : "info",
      event: `run.${run.status}`,
      state: run.status,
      ...emptyLogMetadata,
      error: run.failureCode,
    });
  }
  entries.sort(
    (left, right) =>
      Date.parse(left.occurredAt) - Date.parse(right.occurredAt) ||
      left.id.localeCompare(right.id),
  );
  return { entries, truncated: operations.length > MAX_LOG_ENTRIES };
}

const runControlInput = z.object({
  runPublicId: runShortcode,
  action: z.enum([
    "pause",
    "resume",
    "cancel",
    "abort",
    "retry",
    "restart",
    "retry_dispatch",
    "upload_evidence",
    "no_evidence_available",
    "escalate_sol",
    "run_now_paid",
  ]),
  paidOverBudgetUsd: paidOverBudgetUsd.optional(),
});

const runControlAction = z.enum([
  "prompt",
  "abort",
  "pause",
  "resume",
  "cancel",
  "retry",
  "restart",
  "retry_dispatch",
  "upload_evidence",
  "no_evidence_available",
  "escalate_sol",
]);

export async function recordRunControlEvent(
  db: Database,
  actor: ActorContext,
  rawInput: {
    runPublicId: string;
    action: z.input<typeof runControlAction>;
  },
) {
  const input = z
    .object({ runPublicId: runShortcode, action: runControlAction })
    .parse(rawInput);
  const scope = await loadRunControlScopeByShortcode(db, input.runPublicId);
  const controller = await loadRunController(db, actor);
  if (!controller)
    throw new Error("Purchase import run is not owned by this member");
  const [event] = await getDb(db)
    .insert(runControlEvent)
    .values({
      runId: scope.runId,
      action: input.action,
      controllerUserId: userId.parse(controller.userId),
      controllerName: controller.name,
      controllerEmail: controller.email,
      controllerLedgerPartyId: controller.ledgerPartyId,
      controllerLedgerPartyShortcode: controller.ledgerPartyShortcode,
      controllerLedgerPartyName: controller.ledgerPartyName,
      controllerLedgerPartyKind: controller.ledgerPartyKind,
    })
    .returning({
      id: runControlEvent.id,
      createdAt: runControlEvent.createdAt,
    });
  if (!event) throw new Error("Import run control event was not recorded");
  return event;
}

const UNRESOLVED_TARGET_STATES: ReadonlySet<string> = new Set([
  "pending",
  "prepared",
  "unresolved",
  "needs_evidence",
  "unavailable",
]);

export async function controlRun(
  db: Database,
  actor: ActorContext,
  rawInput: z.input<typeof runControlInput>,
) {
  const input = runControlInput.parse(rawInput);
  const scope = await loadRunControlScopeByShortcode(db, input.runPublicId);
  const controller = await loadRunController(db, actor);
  if (!controller)
    throw new Error("Purchase import run is not owned by this member");
  const policy = runPurposePolicy(runPurpose.parse(scope.purpose));
  if (
    policy.control === "owner" &&
    scope.ledgerPartyId !== controller.ledgerPartyId
  )
    throw new Error("Only the member this Run belongs to can control it");
  return withTransaction(db, async (tx) => {
    if (scope.vendorAccountId)
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${scope.vendorAccountId}))`,
      );
    const [locked] = await tx
      .select({
        status: runTable.status,
        failureCode: runTable.failureCode,
        ledgerPartyId: runTable.ledgerPartyId,
        actorUserId: runTable.actorUserId,
        actorName: runTable.actorName,
        actorEmail: runTable.actorEmail,
        actorLedgerPartyShortcode: runTable.actorLedgerPartyShortcode,
        actorLedgerPartyName: runTable.actorLedgerPartyName,
        actorLedgerPartyKind: runTable.actorLedgerPartyKind,
        vendorAccountId: runTable.vendorAccountId,
        vendorId: runTable.vendorId,
        purpose: runTable.purpose,
        trigger: runTable.trigger,
        parentRunId: runTable.parentRunId,
        notes: runTable.notes,
        input: runTable.input,
        skillRevision: runTable.skillRevision,
        runtimeRevision: runTable.runtimeRevision,
        dispatchEventId: runTable.dispatchEventId,
        coordinatorStartedAt: runTable.coordinatorStartedAt,
        decisionRevision: runTable.decisionRevision,
      })
      .from(runTable)
      .where(eq(runTable.id, scope.runId))
      .limit(1)
      // A key-preserving lock: this transaction also touches child rows
      // whose foreign keys share-lock the Run, so a full lock could deadlock.
      .for("no key update");
    if (!locked) throw new Error("Purchase import run was not found");
    if (locked.vendorAccountId !== scope.vendorAccountId)
      throw new Error("Purchase import control account changed.");
    if (locked.ledgerPartyId !== scope.ledgerPartyId)
      throw new Error("Purchase import control owner changed.");
    if (input.action === "restart") {
      if (
        !new Set([
          "completed",
          "failed",
          "needs_review",
          "dispatch_failed",
        ]).has(locked.status)
      )
        throw createAppError(
          "RUN_CONTROL_REFUSED",
          `Only a finished run can be started again (${locked.status})`,
        );
      const lifecycle = await runPurposeLifecycle(locked.purpose);
      if (!lifecycle)
        throw new Error("Only agent import runs can be started again");
      const sourceTargets = await lifecycle.targets(tx, scope.runId);
      if (sourceTargets.length === 0)
        throw new Error("This run has no inputs to start again");
      const successorId = runEntityId.parse(crypto.randomUUID());
      const dispatchEventId = crypto.randomUUID();
      const successor = await insertWithShortcode(tx, "run", {
        id: successorId,
        ledgerPartyId: locked.ledgerPartyId,
        actorUserId: userId.parse(controller.userId),
        actorName: controller.name,
        actorEmail: controller.email,
        actorLedgerPartyShortcode: controller.ledgerPartyShortcode,
        actorLedgerPartyName: controller.ledgerPartyName,
        actorLedgerPartyKind: controller.ledgerPartyKind,
        vendorAccountId: locked.vendorAccountId,
        vendorId: locked.vendorId,
        predecessorRunId: scope.runId,
        // Earlier-attempt detection orders Runs by startedAt; admission stamps
        // it from this clock too, never the database default.
        startedAt: new Date(),
        parentRunId: policy.successorKeepsParent ? locked.parentRunId : null,
        purpose: locked.purpose,
        trigger: "manual",
        notes: locked.notes,
        input: locked.input,
        coordinatorModel: coordinatorModelFor(locked.purpose),
        skillRevision: locked.skillRevision,
        runtimeRevision: locked.runtimeRevision,
        dispatchEventId,
        agentSessionId: importRunAgentIdentity(
          successorId,
          agentImportRunPurpose.parse(locked.purpose),
        ),
      });
      await lifecycle.handOff(tx, {
        from: scope.runId,
        to: successorId,
        carried: sourceTargets,
        restart: true,
      });
      await dispatchStartedRun(tx, {
        id: successorId,
        eventId: dispatchEventId,
        purpose: locked.purpose,
      });
      return {
        publicId: input.runPublicId,
        status: locked.status,
        successorRunId: successorId,
        successorRunPublicId: successor.shortcode,
        successorStatus: successor.status,
        created: true,
        dispatchRunId: successorId,
        dispatchPublicId: successor.shortcode,
        dispatchPurpose: locked.purpose,
        dispatchEventId,
      };
    }
    await tx.insert(runControlEvent).values({
      runId: scope.runId,
      action: input.action,
      controllerUserId: userId.parse(controller.userId),
      controllerName: controller.name,
      controllerEmail: controller.email,
      controllerLedgerPartyId: controller.ledgerPartyId,
      controllerLedgerPartyShortcode: controller.ledgerPartyShortcode,
      controllerLedgerPartyName: controller.ledgerPartyName,
      controllerLedgerPartyKind: controller.ledgerPartyKind,
      paidOverBudgetUsd: input.paidOverBudgetUsd ?? null,
    });
    await recordChange(tx, { kind: "source", categories: ["run"] });
    if (input.action === "retry_dispatch") {
      if (
        !new Set(["running", "dispatch_failed"]).has(locked.status) ||
        locked.coordinatorStartedAt
      ) {
        throw new Error("Only an unacknowledged dispatch can be retried");
      }
      const dispatchEventId = crypto.randomUUID();
      await tx
        .update(runTable)
        .set({
          status: "running",
          failureCode: null,
          endedAt: null,
          dispatchEventId,
          dispatchError: null,
          coordinatorModel: coordinatorModelFor(locked.purpose),
          updatedAt: new Date(),
        })
        .where(eq(runTable.id, scope.runId));
      await dispatchStartedRun(tx, {
        id: scope.runId,
        eventId: dispatchEventId,
        purpose: locked.purpose,
      });
      return {
        publicId: input.runPublicId,
        status: "running" as const,
        dispatchRunId: scope.runId,
        dispatchPublicId: input.runPublicId,
        dispatchPurpose: locked.purpose,
        dispatchEventId,
      };
    }
    if (input.action === "retry" || input.action === "escalate_sol") {
      if (!new Set(["needs_review", "completed", "failed"]).has(locked.status))
        throw createAppError(
          "RUN_CONTROL_REFUSED",
          `Purchase import run is not terminal in ${locked.status}`,
        );
      const successorVendorAccountId = locked.vendorAccountId
        ? vendorAccountId.parse(locked.vendorAccountId)
        : null;
      const [existingSuccessor] = await tx
        .select({
          id: runTable.id,
          publicId: runTable.shortcode,
          status: runTable.status,
        })
        .from(runTable)
        .where(eq(runTable.predecessorRunId, scope.runId))
        .orderBy(desc(runTable.startedAt))
        .limit(1);
      if (existingSuccessor) {
        return {
          publicId: input.runPublicId,
          status: locked.status,
          successorRunId: existingSuccessor.id,
          successorRunPublicId: existingSuccessor.publicId,
          successorStatus: existingSuccessor.status,
          created: false,
        };
      }
      const successorId = runEntityId.parse(crypto.randomUUID());
      const dispatchEventId = crypto.randomUUID();
      const lifecycle = await runPurposeLifecycle(locked.purpose);
      if (!lifecycle) throw new Error("Only agent import runs can be retried");
      const unresolvedTargets = (
        await lifecycle.targets(tx, scope.runId)
      ).filter((target) => UNRESOLVED_TARGET_STATES.has(target.state));
      if (!unresolvedTargets.length)
        throw new Error("This Run has no unresolved targets to retry");
      const successorInput =
        lifecycle.retryInput?.(locked.input, unresolvedTargets) ?? locked.input;
      const successor = await insertWithShortcode(tx, "run", {
        id: successorId,
        ledgerPartyId: locked.ledgerPartyId,
        actorUserId: locked.actorUserId,
        actorName: locked.actorName,
        actorEmail: locked.actorEmail,
        actorLedgerPartyShortcode: locked.actorLedgerPartyShortcode,
        actorLedgerPartyName: locked.actorLedgerPartyName,
        actorLedgerPartyKind: locked.actorLedgerPartyKind,
        vendorAccountId: successorVendorAccountId,
        vendorId: locked.vendorId,
        predecessorRunId: scope.runId,
        startedAt: new Date(),
        parentRunId: policy.successorKeepsParent ? locked.parentRunId : null,
        purpose: locked.purpose,
        trigger: locked.trigger,
        input: successorInput,
        dispatchEventId,
        coordinatorModel: coordinatorModelFor(locked.purpose),
        skillRevision: locked.skillRevision,
        runtimeRevision: locked.runtimeRevision,
        decisionRevision: locked.decisionRevision + 1,
        agentSessionId: importRunAgentIdentity(
          successorId,
          agentImportRunPurpose.parse(locked.purpose),
        ),
      });
      await lifecycle.handOff(tx, {
        from: scope.runId,
        to: successorId,
        carried: unresolvedTargets,
        restart: false,
      });
      await dispatchStartedRun(tx, {
        id: successorId,
        eventId: dispatchEventId,
        purpose: locked.purpose,
      });
      return {
        publicId: input.runPublicId,
        status: locked.status,
        successorRunId: successorId,
        successorRunPublicId: successor.shortcode,
        successorStatus: successor.status,
        created: true,
        dispatchRunId: successorId,
        dispatchPublicId: successor.shortcode,
        dispatchPurpose: locked.purpose,
        dispatchEventId,
      };
    }
    if (input.action === "cancel" || input.action === "abort") {
      const dispatchAbort = input.action === "abort";
      if (
        dispatchAbort
          ? !new Set(["running", "dispatch_failed"]).has(locked.status) ||
            locked.coordinatorStartedAt !== null
          : !ACTIVE_RUN_STATUSES.some((status) => status === locked.status)
      )
        throw createAppError(
          "RUN_CONTROL_REFUSED",
          `Purchase import run is immutable in ${locked.status}`,
        );
      await tx
        .update(runTable)
        .set({
          status: "failed",
          failureCode: dispatchAbort ? "dispatch_aborted" : "user_cancelled",
          endedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(runTable.id, scope.runId));
      await failOperationsForRun(
        tx,
        scope.runId,
        dispatchAbort
          ? "Dispatch aborted by its owner"
          : "Run cancelled by its owner",
      );
      await (
        await runPurposeLifecycle(locked.purpose)
      )?.cancelled?.(tx, { runId: scope.runId, input: locked.input });
      return { publicId: input.runPublicId, status: "failed" as const };
    }
    if (input.action === "pause") {
      if (locked.status !== "running")
        throw createAppError(
          "RUN_CONTROL_REFUSED",
          `Purchase import run is fenced in ${locked.status}`,
        );
      await tx
        .update(runTable)
        .set({ status: "paused", updatedAt: new Date() })
        .where(eq(runTable.id, scope.runId));
      return {
        publicId: input.runPublicId,
        status: "paused" as const,
      };
    }
    if (input.action === "resume" || input.action === "run_now_paid") {
      // The recorded `run_now_paid` event is the paid grant
      // (`readPaidGrant`); resuming is the same redispatch.
      if (
        !new Set(
          input.action === "run_now_paid"
            ? ["paused", "paused_auth"]
            : ["paused", "paused_auth", "paused_offline"],
        ).has(locked.status) &&
        !isFundingStoppedForReview({
          ...locked,
          hasSuccessor:
            (
              await tx
                .select({ id: runTable.id })
                .from(runTable)
                .where(eq(runTable.predecessorRunId, scope.runId))
                .limit(1)
            ).length > 0,
        })
      )
        throw createAppError(
          "RUN_CONTROL_REFUSED",
          `Purchase import run is fenced in ${locked.status}`,
        );
      const dispatchEventId = crypto.randomUUID();
      await tx
        .update(runTable)
        .set({
          status: "running",
          failureCode: null,
          dispatchEventId,
          dispatchError: null,
          coordinatorStartedAt: null,
          endedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(runTable.id, scope.runId));
      await dispatchStartedRun(tx, {
        id: scope.runId,
        eventId: dispatchEventId,
        purpose: locked.purpose,
      });
      return {
        publicId: input.runPublicId,
        status: "running" as const,
        dispatchRunId: scope.runId,
        dispatchPublicId: input.runPublicId,
        dispatchPurpose: locked.purpose,
        dispatchEventId,
      };
    }

    throw new Error(`Unsupported Run control: ${input.action}`);
  });
}
