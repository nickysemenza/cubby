import type { ActorContext } from "@cubby/schemas/context";
import {
  userId,
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
  runShortcode,
  runPurpose,
  runScope,
} from "@cubby/schemas/purchase-import";
import { isMemberStartedRun } from "@cubby/schemas/run-fields";
import { ACTIVE_RUN_STATUSES } from "@cubby/shared/client-constants";
import {
  and,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  not,
  or,
  sql,
} from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import { advisoryXactLock } from "~/server/db/advisory-lock";
import { vendorAccountLabelSql } from "~/server/db/computed/vendor-account-label";
import { getDb, notDeleted, withTransaction } from "~/server/db/helpers";
import { outer, related } from "~/server/db/helpers/related";
import {
  ledgerParty,
  run as runTable,
  runControlEvent,
  vendor,
  vendorAccount,
} from "~/server/db/schema";
import {
  loadRunController,
  loadRunControlScopeByShortcode,
} from "~/server/domains/run/repo/control-scope";
import { dispatchStartedRun } from "~/server/domains/run/repo/coordinator-dispatch";
import { runPurposeLifecycle } from "~/server/domains/run/repo/purpose-lifecycle";
import {
  readRunPurpose,
  runPurposePolicy,
} from "~/server/domains/run/repo/purpose-policy";
import { failOperationsForRun } from "~/server/domains/run/repo/run-operation";
import { recordRunProgress } from "~/server/domains/run/repo/run-progress";
import { createAppError } from "~/server/errors/app-error";
import { recordChange } from "~/server/generic/changes/repo/change";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";

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
      await advisoryXactLock(tx, "run-vendor-account", scope.vendorAccountId);
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
        coordinatorModel: coordinatorModelFor(
          agentImportRunPurpose.parse(locked.purpose),
        ),
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
          coordinatorModel: coordinatorModelFor(
            agentImportRunPurpose.parse(locked.purpose),
          ),
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
        coordinatorModel: coordinatorModelFor(
          agentImportRunPurpose.parse(locked.purpose),
        ),
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
