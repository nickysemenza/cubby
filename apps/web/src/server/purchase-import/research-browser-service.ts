import { parseEntityId, runEntityId } from "@cubby/schemas/identifiers";
import {
  BROWSER_BRIDGE_PROTOCOL,
  browserBridgeRequest,
  browserBridgeResult,
  type BrowserBridgeResult,
} from "@cubby/schemas/purchase-import";
import { retainedResearchObservation } from "@cubby/schemas/research";
import {
  researchWorkObserve,
  type ResearchWorkObserveInput,
} from "@cubby/schemas/research-tools";
import { validateExternalHttpUrl } from "@cubby/shared/external-fetch";
import { sha256Hex, sha256Uuid } from "@cubby/shared/sha256";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import type { Database, DrizzleClient, DrizzleTransaction } from "~/server/db";
import {
  ledgerParty,
  run,
  runEvidence,
  runOperation,
  runTarget,
  vendorAccount,
} from "~/server/db/schema";
import type { AgentSignal } from "~/server/purchase-agent/signals";
import {
  getDb,
  notDeleted,
  withTransaction,
} from "~/server/repo/database-helpers";
import {
  completeOperation,
  failOperation,
  insertOperation,
  readOperation,
  setOperationResult,
  type OperationKey,
} from "~/server/repo/run-operation";

import { resolveResearchBrowserOperation } from "./agent-browser-command";
import {
  browserCommandRecord,
  browserRecovery,
  materializeCapture,
  productionBrowserEvidenceStorage,
  type BrowserCommandRecord,
} from "./browser-results";
import { assertResearchWork } from "./research-evidence";
import type { ResearchObservationPorts } from "./research-observations";
import type { PurchaseImportDurableObjectRpc } from "./rpc";

type Client = DrizzleClient | DrizzleTransaction;
export type ResearchBrowserEnvironment = Pick<Env, "R2_KEY_PREFIX"> & {
  PURCHASE_IMPORT: {
    getByName(
      name: string,
    ): Pick<
      PurchaseImportDurableObjectRpc,
      "connected" | "enqueue" | "result" | "requestAuthentication"
    >;
  };
};
const activeStates = ["pending", "prepared", "needs_evidence"];
const waiting = (workRef: string) => ({
  status: "waiting" as const,
  workRef,
  reason: "browser" as const,
});
const offline = (workRef: string) => ({
  status: "browser_pending" as const,
  workRef,
  reason: "offline" as const,
});
const observation = (record: BrowserCommandRecord) => {
  if (!record.page)
    throw new Error("Browser command has no retained observation.");
  return { workRef: record.workRef, ...record.page.research };
};
const retainedStop = (record: BrowserCommandRecord) => {
  const outcome = record.serverResult?.outcome;
  return outcome?.status === "failed" &&
    outcome.code === "client_update_required"
    ? {
        status: "stopped" as const,
        workRef: record.workRef,
        reason: outcome.code,
      }
    : null;
};

async function ownedRun(client: Client, runId: string) {
  const [owned] = await client
    .select({ run, memberId: ledgerParty.id })
    .from(run)
    .innerJoin(
      ledgerParty,
      and(
        eq(ledgerParty.id, run.ledgerPartyId),
        eq(ledgerParty.userId, run.actorUserId),
        eq(ledgerParty.kind, "member"),
        notDeleted(ledgerParty),
      ),
    )
    .where(and(eq(run.id, runEntityId.parse(runId)), notDeleted(run)))
    .limit(1);
  if (!owned) throw new Error("Research Run ownership is unavailable.");
  return { ...owned.run, ledgerPartyId: owned.memberId };
}

async function workStop(
  client: Client,
  scope: Awaited<ReturnType<typeof ownedRun>>,
  workRef: string,
) {
  if (scope.retiredAt)
    return { status: "stopped" as const, workRef, reason: "retired" };
  if (scope.status === "paused_auth") return waiting(workRef);
  if (!["running", "paused_offline"].includes(scope.status))
    return { status: "stopped" as const, workRef, reason: scope.status };
  const [target] = await client
    .select({ state: runTarget.state })
    .from(runTarget)
    .where(and(eq(runTarget.runId, scope.id), eq(runTarget.id, workRef)))
    .limit(1);
  if (!target)
    throw new Error("Research browser work does not belong to this Run.");
  return activeStates.includes(target.state)
    ? null
    : { status: "stopped" as const, workRef, reason: "work_settled" };
}

async function records(client: Client, runId: string) {
  const rows = await client
    .select({
      operationId: runOperation.operationId,
      state: runOperation.state,
      result: runOperation.result,
    })
    .from(runOperation)
    .where(
      and(
        eq(runOperation.runId, runEntityId.parse(runId)),
        eq(runOperation.kind, "browser_command"),
      ),
    )
    .orderBy(asc(runOperation.createdAt), asc(runOperation.id));
  return rows.map((row) => ({
    ...row,
    record: browserCommandRecord.parse(row.result),
  }));
}

const pending = (entry: Awaited<ReturnType<typeof records>>[number]) =>
  entry.state !== "failed" &&
  !entry.record.observationDelivered &&
  !entry.record.retries?.length;

/** A cached observation remains in flight until the harness durably accepts its signal. */
export async function readPendingBrowserWork(
  db: Database,
  runId: string,
): Promise<string[]> {
  const database = getDb(db);
  await ownedRun(database, runId);
  const targets = await database
    .select({ id: runTarget.id })
    .from(runTarget)
    .where(
      and(
        eq(runTarget.runId, runEntityId.parse(runId)),
        inArray(runTarget.state, activeStates),
      ),
    );
  const open = new Set(targets.map((target) => target.id));
  return [
    ...new Set(
      (await records(database, runId))
        .filter((entry) => pending(entry) && open.has(entry.record.workRef))
        .map((entry) => entry.record.workRef),
    ),
  ];
}

/** Task readiness is independent of the SDK's delivery receipt. */
export async function readResearchBrowserTasks(db: Database, runId: string) {
  const database = getDb(db);
  await ownedRun(database, runId);
  const open = await database
    .select({ id: runTarget.id })
    .from(runTarget)
    .where(
      and(
        eq(runTarget.runId, runEntityId.parse(runId)),
        inArray(runTarget.state, activeStates),
      ),
    );
  const openIds = new Set(open.map((target) => target.id));
  const entries = (await records(database, runId)).filter(
    (entry) => openIds.has(entry.record.workRef) && entry.state !== "failed",
  );
  const blockedWorkRefs = new Set(
    entries
      .filter(
        (entry) =>
          pending(entry) &&
          (!entry.record.page ||
            entry.record.page.research.observation.authenticationRequired),
      )
      .map((entry) => entry.record.workRef),
  );
  const retainedByWork = new Map<
    string,
    z.infer<typeof retainedResearchObservation>
  >();
  for (const workRef of openIds) {
    if (blockedWorkRefs.has(workRef)) continue;
    const source = await latestSource(database, runId, workRef);
    const exact =
      source &&
      entries.find(
        ({ record }) =>
          record.workRef === workRef &&
          record.brokerAccountId &&
          record.brokerAccountId === source.brokerAccountId &&
          record.page?.research.evidenceId === source.research.evidenceId &&
          record.page.research.observation.observationId ===
            source.research.observation.observationId &&
          !record.page.research.observation.authenticationRequired,
      );
    if (exact?.record.page)
      retainedByWork.set(workRef, exact.record.page.research);
  }
  return { blockedWorkRefs, retainedByWork };
}

/** Private command identity projection supports historical wake fences, never command execution. */
export async function researchBrowserSettlement(db: Database, runId: string) {
  const database = getDb(db);
  const scope = await ownedRun(database, runId);
  const raw = await database
    .select({ result: runOperation.result })
    .from(runOperation)
    .where(
      and(
        eq(runOperation.runId, scope.id),
        eq(runOperation.kind, "browser_command"),
      ),
    );
  const commandIdentity = browserCommandRecord
    .pick({ commandId: true, brokerAccountId: true })
    .loose();
  const commands = raw.flatMap(({ result }) => {
    const parsed = commandIdentity.safeParse(result);
    if (!parsed.success) return [];
    const accountId = parsed.data.brokerAccountId ?? scope.vendorAccountId;
    return accountId ? [{ commandId: parsed.data.commandId, accountId }] : [];
  });
  const accounts = [
    ...new Set([
      ...(scope.vendorAccountId ? [scope.vendorAccountId] : []),
      ...commands.map((command) => command.accountId),
    ]),
  ];
  if (accounts.length) {
    const owned = await database
      .select({ id: vendorAccount.id })
      .from(vendorAccount)
      .where(
        and(
          inArray(
            vendorAccount.id,
            accounts.map((id) => parseEntityId("vendorAccount", id)),
          ),
          eq(vendorAccount.ledgerPartyId, scope.ledgerPartyId),
          notDeleted(vendorAccount),
        ),
      );
    if (owned.length !== accounts.length)
      throw new Error(
        "Browser settlement transport is no longer owned and available.",
      );
  }
  const open = await database
    .select({ id: runTarget.id })
    .from(runTarget)
    .where(
      and(
        eq(runTarget.runId, scope.id),
        inArray(runTarget.state, activeStates),
      ),
    );
  const openIds = new Set(open.map((target) => target.id));
  const deliveryPending = raw.some(({ result }) => {
    const parsed = browserCommandRecord.safeParse(result);
    return (
      parsed.success &&
      openIds.has(parsed.data.workRef) &&
      !parsed.data.observationDelivered &&
      !parsed.data.retries?.length &&
      Boolean(parsed.data.page)
    );
  });
  return { accounts: accounts.sort(), commands, deliveryPending };
}

/** Pause only when every remaining task lacks an available browser result or transport. */
export async function waitForPendingBrowserWork(
  db: Database,
  env: ResearchBrowserEnvironment,
  runId: string,
) {
  return withTransaction(db, async (tx) => {
    await tx
      .select({ id: run.id })
      .from(run)
      .where(eq(run.id, runEntityId.parse(runId)))
      .for("update");
    const scope = await ownedRun(tx, runId);
    if (scope.retiredAt)
      return { status: "stopped" as const, reason: "retired" };
    if (!["running", "paused_offline"].includes(scope.status))
      return { status: "stopped" as const, reason: scope.status };
    const targets = await tx
      .select({ id: runTarget.id })
      .from(runTarget)
      .where(
        and(
          eq(runTarget.runId, scope.id),
          inArray(runTarget.state, activeStates),
        ),
      );
    const open = new Set(targets.map((target) => target.id));
    const entries = (await records(tx, runId)).filter(
      (entry) => pending(entry) && open.has(entry.record.workRef),
    );
    const workRefs = [...new Set(entries.map((entry) => entry.record.workRef))];
    let allOffline = workRefs.length > 0 && workRefs.length === open.size;
    for (const { record } of entries) {
      // Retained results await delivery, not a sleeping Mac.
      if (record.page || record.serverResult) {
        allOffline = false;
        break;
      }
      if (record.brokerAccountId) {
        await accountFor(tx, env, scope, record.brokerAccountId);
        if (
          await env.PURCHASE_IMPORT.getByName(
            record.brokerAccountId,
          ).connected()
        ) {
          allOffline = false;
          break;
        }
      }
    }
    if (allOffline)
      await tx
        .update(run)
        .set({ status: "paused_offline", updatedAt: new Date() })
        .where(and(eq(run.id, scope.id), eq(run.status, "running")));
    return { status: "waiting" as const, reason: "browser" as const, workRefs };
  });
}

function resultSignal(signal: AgentSignal) {
  if (signal.type !== "purchase-import.browser_result") return null;
  const body = z
    .object({ commandId: z.uuid(), eventId: z.string().min(1) })
    .parse(JSON.parse(signal.body));
  if (
    body.eventId !== `browser-result:${body.commandId}` ||
    (signal.attributes?.eventId && signal.attributes.eventId !== body.eventId)
  )
    throw new Error(
      "Browser result signal identity does not match its command.",
    );
  return body;
}

function validateRecord(record: BrowserCommandRecord, key: OperationKey) {
  if (
    record.commandId !== record.command.id ||
    record.command.runID !== key.runId ||
    record.command.operationId !== key.operationId
  )
    throw new Error(
      "Browser command does not belong to this operation and Run.",
    );
}

async function findCommand(client: Client, runId: string, commandId: string) {
  const entry = (await records(client, runId)).find(
    (row) => row.record.commandId === commandId,
  );
  if (!entry)
    throw new Error("Browser signal command does not belong to this Run.");
  const key = {
    runId: runEntityId.parse(runId),
    operationId: entry.operationId,
  };
  validateRecord(entry.record, key);
  return { key, record: entry.record };
}

/** Called only after durable harness submission; settled targets remain acknowledgeable. */
export async function acknowledgeResearchBrowserObservation(
  db: Database,
  runId: string,
  signal: AgentSignal,
) {
  const parsed = resultSignal(signal);
  if (!parsed) return;
  await withTransaction(db, async (tx) => {
    await ownedRun(tx, runId);
    const found = await findCommand(tx, runId, parsed.commandId);
    const current = await readOperation(tx, found.key, { forUpdate: true });
    const record = browserCommandRecord.parse(current?.result);
    validateRecord(record, found.key);
    if (!record.page || record.page.research.observation.authenticationRequired)
      return;
    await setOperationResult(tx, found.key, {
      ...record,
      observationDelivered: true,
    });
  });
}

async function latestSource(client: Client, runId: string, workRef: string) {
  const [row] = await client
    .select({ metadata: runEvidence.sourceMetadata })
    .from(runEvidence)
    .where(
      and(
        eq(runEvidence.runId, runEntityId.parse(runId)),
        eq(runEvidence.targetId, workRef),
        eq(runEvidence.kind, "browser_capture"),
      ),
    )
    .orderBy(desc(runEvidence.createdAt), desc(runEvidence.id))
    .limit(1);
  return row
    ? z
        .object({
          brokerAccountId: z.uuid().optional(),
          research: retainedResearchObservation,
        })
        .parse(row.metadata)
    : null;
}

function browserURL(raw: string) {
  const url = validateExternalHttpUrl(raw);
  if (url.protocol !== "https:")
    throw new Error("Browser source must be an ordinary HTTPS URL.");
  return url;
}

function sourcePlan(
  input: ResearchWorkObserveInput,
  latest: Awaited<ReturnType<typeof latestSource>>,
) {
  const action = input.action;
  const current = latest?.research.observation;
  const url =
    action.kind === "navigate"
      ? browserURL(action.url)
      : current?.servedURL
        ? browserURL(current.servedURL)
        : null;
  if (!url)
    throw new Error(
      "Navigate to an explicit source before reading this work item.",
    );
  const hosts = new Set([url.hostname]);
  const navigationURL = actionNavigationURL(action, current);
  if (navigationURL) hosts.add(browserURL(navigationURL).hostname);
  return {
    allowedHosts: [...hosts],
    recoveryURL:
      action.kind === "navigate"
        ? undefined
        : (current?.servedURL ?? undefined),
  };
}

function actionNavigationURL(
  action: ResearchWorkObserveInput["action"],
  current:
    | z.infer<typeof retainedResearchObservation>["observation"]
    | undefined,
) {
  if (["click", "type", "select"].includes(action.kind)) {
    if (
      !("observationId" in action) ||
      !current ||
      current.observationId !== action.observationId
    )
      throw new Error(
        "Browser action refers to a stale or other-work observation.",
      );
    const control = current.actions.find(
      (candidate) => candidate.ref === action.ref,
    );
    if (!control || control.disabled)
      throw new Error(
        "Browser action reference is unavailable in this observation.",
      );
    if (
      action.kind === "type" &&
      !["textbox", "searchbox"].includes(control.kind)
    )
      throw new Error("Browser typing requires an observed text control.");
    if (action.kind === "select") {
      const option = current.actions.find(
        (candidate) => candidate.ref === action.optionRef,
      );
      if (
        control.kind !== "select" ||
        option?.kind !== "option" ||
        option.parentRef !== control.ref ||
        option.disabled
      )
        throw new Error(
          "Browser option does not belong to the observed select.",
        );
    }
    return control.navigationURL;
  }
  return undefined;
}

async function accountFor(
  client: Client,
  env: ResearchBrowserEnvironment,
  scope: Awaited<ReturnType<typeof ownedRun>>,
  requiredId?: string,
) {
  const accounts = await client
    .select()
    .from(vendorAccount)
    .where(
      and(
        eq(vendorAccount.ledgerPartyId, scope.ledgerPartyId),
        eq(vendorAccount.browser, "chrome"),
        notDeleted(vendorAccount),
      ),
    )
    .orderBy(asc(vendorAccount.createdAt), asc(vendorAccount.id));
  const enabled = accounts.filter((account) => account.status !== "disabled");
  const bound = requiredId ?? scope.vendorAccountId;
  const preferred = bound
    ? enabled.find((account) => account.id === bound)
    : undefined;
  if (requiredId && !preferred)
    throw new Error(
      "Observed browser transport is no longer owned and available.",
    );
  if (preferred) return preferred.id;
  for (const account of [
    ...enabled.filter((account) => account.browserSyncEnabled),
    ...enabled.filter((account) => !account.browserSyncEnabled),
  ])
    if (await env.PURCHASE_IMPORT.getByName(account.id).connected())
      return account.id;
  return enabled.find((account) => account.browserSyncEnabled)?.id;
}

const blocked = (
  record: BrowserCommandRecord,
  outcome: Extract<BrowserBridgeResult["outcome"], { status: "failed" }>,
) => ({
  status: "blocked" as const,
  workRef: record.workRef,
  reason: outcome.code,
  diagnostic: outcome.message,
});

/** Owns browser authority and durable command replay; the model receives observations only. */
export function researchBrowserFor(
  db: Database,
  env: ResearchBrowserEnvironment,
  rawRunId: string,
  observations: ResearchObservationPorts = {},
) {
  const runId = runEntityId.parse(rawRunId);
  const database = getDb(db);
  const updateRecord = async (
    key: OperationKey,
    update: (current: BrowserCommandRecord) => BrowserCommandRecord,
    completed = false,
  ) =>
    withTransaction(db, async (tx) => {
      const stored = await readOperation(tx, key, { forUpdate: true });
      const current = browserCommandRecord.parse(stored?.result);
      validateRecord(current, key);
      const next = update(current);
      if (completed && stored?.state !== "failed")
        await completeOperation(tx, key, next);
      else await setOperationResult(tx, key, next);
      return next;
    });
  const brokerFor = async (record: BrowserCommandRecord) => {
    const scope = await ownedRun(database, runId);
    if (!record.brokerAccountId) return null;
    await accountFor(database, env, scope, record.brokerAccountId);
    return env.PURCHASE_IMPORT.getByName(record.brokerAccountId);
  };
  const pause = async (status: "paused_offline" | "paused_auth") => {
    await database
      .update(run)
      .set({ status, updatedAt: new Date() })
      .where(
        and(
          eq(run.id, runId),
          inArray(run.status, ["running", "paused_offline"]),
        ),
      );
  };
  const dispatch = async (key: OperationKey, record: BrowserCommandRecord) => {
    const scope = await ownedRun(database, runId);
    const fenced = await workStop(database, scope, record.workRef);
    if (fenced) return fenced;
    if (!record.brokerAccountId) {
      const accountId = await accountFor(database, env, scope);
      if (accountId) {
        record = await updateRecord(key, (current) => ({
          ...current,
          brokerAccountId: current.brokerAccountId ?? accountId,
        }));
      }
    }
    const broker = await brokerFor(record);
    if (!broker) return offline(record.workRef);
    const connected = await broker.connected();
    await broker.enqueue(record.command);
    const current = await updateRecord(key, (saved) => saved, true);
    const stopped = retainedStop(current);
    if (!connected && !current.page && !stopped) return offline(record.workRef);
    return stopped ?? waiting(record.workRef);
  };
  const reconcile = async (
    key: OperationKey,
    record: BrowserCommandRecord,
    eventId: string,
  ) => {
    const operationId = `research-read:${await sha256Uuid(`${record.commandId}:${eventId}`)}`;
    const childKey = { runId, operationId };
    const source = await latestSource(database, runId, record.workRef);
    const recoveryURL =
      record.command.operation.type === "navigate"
        ? record.command.operation.url
        : record.command.operation.type === "read"
          ? record.command.operation.recoveryURL
          : (source?.research.observation.servedURL ?? undefined);
    if (!recoveryURL || !("allowedHosts" in record.command.operation))
      throw new Error("Browser recovery has no explicit same-work source.");
    const commandId = await sha256Uuid(
      `research-browser:${runId}:${operationId}`,
    );
    const command = browserBridgeRequest.parse({
      protocolVersion: BROWSER_BRIDGE_PROTOCOL,
      id: commandId,
      operationId,
      runID: runId,
      deadline: new Date(Date.now() + 25 * 60 * 60_000).toISOString(),
      operation: {
        type: "read",
        allowedHosts: record.command.operation.allowedHosts,
        screenshot: "preferred",
        recoveryURL,
        evidenceScope: {
          runId: (await ownedRun(database, runId)).shortcode,
          targetId: record.workRef,
        },
      },
    });
    const child: BrowserCommandRecord = {
      commandId,
      command,
      workRef: record.workRef,
      brokerAccountId: record.brokerAccountId,
      recoveryDepth: (record.recoveryDepth ?? 0) + 1,
    };
    const fingerprint = await sha256Hex(
      JSON.stringify({ parent: record.commandId, eventId }),
    );
    await withTransaction(db, async (tx) => {
      const existing = await readOperation(tx, childKey, { forUpdate: true });
      if (!existing)
        await insertOperation(tx, {
          ...childKey,
          kind: "browser_command",
          inputFingerprint: fingerprint,
          result: child,
        });
      else if (existing.inputFingerprint !== fingerprint)
        throw new Error(
          "Browser recovery identity was replayed with different input.",
        );
      const current = await readOperation(tx, key, { forUpdate: true });
      const parent = browserCommandRecord.parse(current?.result);
      await setOperationResult(tx, key, {
        ...parent,
        retries: [...new Set([...(parent.retries ?? []), operationId])],
      });
    });
    const persisted = browserCommandRecord.parse(
      (await readOperation(database, childKey))?.result,
    );
    if (!persisted.page) await dispatch(childKey, persisted);
    return waiting(record.workRef);
  };
  const consumeFailure = async (
    key: OperationKey,
    record: BrowserCommandRecord,
    result: BrowserBridgeResult,
    outcome: Extract<BrowserBridgeResult["outcome"], { status: "failed" }>,
  ) => {
    record = await updateRecord(key, (current) => ({
      ...current,
      serverResult: current.serverResult ?? result,
    }));
    const recovery = browserRecovery(outcome, record.recoveryDepth ?? 0);
    if (
      (outcome.code === "action_outcome_unknown" ||
        recovery.action === "retry") &&
      (record.recoveryDepth ?? 0) < 1
    )
      return reconcile(key, record, `result:${record.commandId}`);
    if (recovery.action === "pause") {
      await updateRecord(key, (current) => ({
        ...current,
        pausedAt: recovery.reason,
      }));
      await pause(recovery.status);
      return waiting(record.workRef);
    }
    await failOperation(database, key, outcome.message);
    if (recovery.action === "stop_outdated_client") {
      await database
        .update(run)
        .set({ status: "failed", endedAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(run.id, runId),
            inArray(run.status, ["running", "paused_offline"]),
          ),
        );
      return {
        status: "stopped" as const,
        workRef: record.workRef,
        reason: outcome.code,
      };
    }
    return blocked(record, outcome);
  };
  const consume = async (key: OperationKey, record: BrowserCommandRecord) => {
    const stopped = retainedStop(record);
    if (stopped) return stopped;
    const scope = await ownedRun(database, runId);
    const fenced = await workStop(database, scope, record.workRef);
    if (fenced) return fenced;
    if (record.page)
      return record.page.research.observation.authenticationRequired
        ? waiting(record.workRef)
        : observation(record);
    if (record.retries?.length) return waiting(record.workRef);
    const broker = await brokerFor(record);
    const rawResult =
      record.serverResult ?? (await broker?.result(record.commandId));
    if (!rawResult) return waiting(record.workRef);
    const result = browserBridgeResult.parse(rawResult);
    if (
      result.commandID !== record.commandId ||
      result.operationID !== key.operationId ||
      result.runID !== runId
    )
      throw new Error(
        "Browser result does not belong to this command and Run.",
      );
    if (result.outcome.status === "failed")
      return consumeFailure(key, record, result, result.outcome);
    await assertResearchWork(db, runId, record.workRef);
    await database
      .update(run)
      .set({ status: "running", updatedAt: new Date() })
      .where(and(eq(run.id, runId), eq(run.status, "paused_offline")));
    const page = await materializeCapture(db, {
      key,
      runShortcode: scope.shortcode,
      record,
      result,
      allowedHosts:
        "allowedHosts" in record.command.operation
          ? record.command.operation.allowedHosts
          : [],
      storage: observations.storage ?? productionBrowserEvidenceStorage,
    });
    await withTransaction(db, async (tx) => {
      const current = browserCommandRecord.parse(
        (await readOperation(tx, key, { forUpdate: true }))?.result,
      );
      await completeOperation(tx, key, {
        ...current,
        page,
        pausedAt: page.research.observation.authenticationRequired
          ? "auth"
          : undefined,
      });
    });
    if (page.research.observation.authenticationRequired) {
      await pause("paused_auth");
      await broker?.requestAuthentication(runId);
      return waiting(record.workRef);
    }
    return { workRef: record.workRef, ...page.research };
  };
  return {
    async observe(raw: ResearchWorkObserveInput, rawCallId: string) {
      const input = researchWorkObserve.parse(raw);
      const callId = z.string().trim().min(1).max(200).parse(rawCallId);
      const key = { runId, operationId: callId };
      const fingerprint = await sha256Hex(JSON.stringify(input));
      const record = await withTransaction(db, async (tx) => {
        await tx
          .select({ id: run.id })
          .from(run)
          .where(eq(run.id, runId))
          .for("update");
        const scope = await ownedRun(tx, runId);
        if (scope.retiredAt)
          return {
            status: "stopped" as const,
            workRef: input.workRef,
            reason: "retired",
          };
        const existing = await readOperation(tx, key, { forUpdate: true });
        if (existing) {
          if (
            existing.kind !== "browser_command" ||
            existing.inputFingerprint !== fingerprint
          )
            throw new Error(
              "Browser call was replayed with different work or action input.",
            );
          const saved = browserCommandRecord.parse(existing.result);
          validateRecord(saved, key);
          return saved;
        }
        if (
          scope.retiredAt ||
          !["running", "paused_offline"].includes(scope.status)
        )
          throw new Error("Research browser Run is fenced.");
        const [target] = await tx
          .select()
          .from(runTarget)
          .where(
            and(eq(runTarget.id, input.workRef), eq(runTarget.runId, runId)),
          )
          .for("update");
        if (!target || !activeStates.includes(target.state))
          throw new Error(
            "Research browser work is settled or belongs to another Run.",
          );
        const source = await latestSource(tx, runId, input.workRef);
        const plan = sourcePlan(input, source);
        const observedId =
          "observationId" in input.action ? input.action.observationId : null;
        if (
          (await records(tx, runId)).some((entry) => {
            if (!pending(entry) || entry.record.workRef !== input.workRef)
              return false;
            // A valid action on this retained page proves the agent received
            // it, even when the durable-submit acknowledgement is still racing.
            // It does not acknowledge delivery or bypass another pending command.
            const page = entry.record.page?.research;
            return !(
              observedId &&
              page &&
              source &&
              !page.observation.authenticationRequired &&
              page.observation.observationId === observedId &&
              source.research.observation.observationId === observedId &&
              page.evidenceId === source.research.evidenceId &&
              entry.record.brokerAccountId &&
              entry.record.brokerAccountId === source.brokerAccountId
            );
          })
        )
          throw new Error("Research work already has browser work in flight.");
        const accountId = await accountFor(
          tx,
          env,
          scope,
          input.action.kind === "navigate"
            ? undefined
            : source?.brokerAccountId,
        );
        const commandId = await sha256Uuid(
          `research-browser:${runId}:${callId}`,
        );
        const command = browserBridgeRequest.parse({
          protocolVersion: BROWSER_BRIDGE_PROTOCOL,
          id: commandId,
          operationId: callId,
          runID: runId,
          deadline: new Date(Date.now() + 25 * 60 * 60_000).toISOString(),
          operation: resolveResearchBrowserOperation(input.action, {
            ...plan,
            runShortcode: scope.shortcode,
            workRef: input.workRef,
          }),
        });
        const saved: BrowserCommandRecord = {
          commandId,
          command,
          workRef: input.workRef,
          brokerAccountId: accountId,
        };
        await insertOperation(tx, {
          ...key,
          kind: "browser_command",
          inputFingerprint: fingerprint,
          result: saved,
        });
        return saved;
      });
      if ("status" in record) return record;
      if (record.page || record.retries?.length || record.serverResult)
        return consume(key, record);
      return dispatch(key, record);
    },
    async resume(signal: AgentSignal) {
      const result = resultSignal(signal);
      if (result) {
        const scope = await ownedRun(database, runId);
        if (scope.retiredAt)
          return { status: "stopped" as const, reason: "retired" };
        const found = await findCommand(database, runId, result.commandId);
        return consume(found.key, found.record);
      }
      if (
        ![
          "purchase-import.start_or_resume",
          "purchase-import.browser_connected",
        ].includes(signal.type)
      )
        return null;
      const scope = await ownedRun(database, runId);
      const allowedStates =
        signal.type === "purchase-import.browser_connected"
          ? ["running", "paused_offline"]
          : ["running"];
      if (scope.retiredAt || !allowedStates.includes(scope.status)) return null;
      const event = z
        .object({ eventId: z.string().min(1).max(256) })
        .parse(JSON.parse(signal.body));
      if (
        signal.attributes?.eventId &&
        signal.attributes.eventId !== event.eventId
      )
        throw new Error("Browser recovery signal event identity changed.");
      for (const entry of (await records(database, runId)).filter(pending)) {
        if (await workStop(database, scope, entry.record.workRef)) continue;
        const key = { runId, operationId: entry.operationId };
        if (entry.record.pausedAt)
          await reconcile(key, entry.record, event.eventId);
        else await dispatch(key, entry.record);
      }
      return null;
    },
  };
}
