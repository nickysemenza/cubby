import { entityRefKey } from "@cubby/schemas/entity";
import {
  parseEntityRef,
  vendorAccountId,
  type RunId,
} from "@cubby/schemas/identifiers";
import {
  agentImportRunPurpose,
  coordinatorModelFor,
} from "@cubby/schemas/import-run-agent";
import {
  extractedPurchaseLine,
  preparePurchaseImportOut,
  commitPurchaseImportOut,
} from "@cubby/schemas/purchase-import";
import { runShortcode } from "@cubby/schemas/purchase-import";
import { purchaseImportDebugEvent } from "@cubby/schemas/purchase-import-debug";
import {
  chargeHuntRunInput,
  researchObjectivesRunInput,
  mailResearchRunInput,
  orderBackfillRunInput,
  orderMailImportRunInput,
  orderMailImportRunOrders,
  type RunRestartInput,
  runInputsErased,
  runRetirementReason,
} from "@cubby/schemas/run-fields";
import { and, asc, desc, eq, inArray, notInArray, sql } from "drizzle-orm";
import { z } from "zod";

import type { RunDetail, RunLogEntry } from "~/contracts/run.contract";
import type { Database, DrizzleClient, DrizzleTransaction } from "~/server/db";
import { vendorAccountLabelSql } from "~/server/db/computed/vendor-account-label";
import { getDb, notDeleted } from "~/server/db/helpers";
import {
  aiUsage,
  auditLog,
  entityIdentity,
  importPreparedLine,
  importPreparedOrder,
  purchase,
  run as runTable,
  runControlEvent,
  runOperation,
  vendorAccount,
} from "~/server/db/schema";
import {
  runPurposeLifecycle,
  type RunTargetRow,
} from "~/server/domains/run/repo/purpose-lifecycle";
import { getRunHeaderByShortcode } from "~/server/domains/run/repo/run";
import { DEBUG_EVENT_KIND } from "~/server/domains/run/repo/run-operation";

import { loadRunFindings } from "./run-finding";
import { listRunTargetOutcomes, readMailRunGapCategories } from "./run-target";

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
    gapCategories,
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
    run.purpose === "mail_import"
      ? readMailRunGapCategories(database, run.id)
      : Promise.resolve(new Map<string, never>()),
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
  const agentPurpose = agentImportRunPurpose.safeParse(header.purpose);
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
      agentPurpose.success && !runInputsErased(run.retirementReason)
        ? {
            purpose: header.purpose,
            trigger: "manual",
            coordinatorModel: coordinatorModelFor(agentPurpose.data),
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
      category:
        target.entityKind === "email"
          ? (gapCategories.get(target.entityId) ?? null)
          : null,
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
