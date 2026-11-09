import { runEntityId, type RunId } from "@cubby/schemas/identifiers";
import {
  importRunAgentIdentity,
  importRunAgentManifest,
} from "@cubby/schemas/import-run-agent";
import { agentFailureCode } from "@cubby/schemas/purchase-agent-services";
import { mailResearchRunInput, runCause } from "@cubby/schemas/run-fields";
import { parseShortcodeFor } from "@cubby/shared";
import { sha256Hex } from "@cubby/shared/sha256";
import { eq, inArray } from "drizzle-orm";

import type { DrizzleClient, DrizzleTransaction } from "~/server/db";
import { run as runTable } from "~/server/db/schema";
import { waitForMailImportPermission } from "~/server/domains/purchase-import/repo/controlled-mail-import";
import {
  holdCancelledMailRunSources,
  importAttemptsExhausted,
  readMailRunRoster,
  releaseUnsettledMailRunSources,
  transferMailRunSources,
} from "~/server/domains/purchase-import/repo/mail-run-membership";
import { publishRunFinding } from "~/server/domains/purchase-import/repo/run-finding";
import { listRunTargetOutcomes } from "~/server/domains/purchase-import/repo/run-target";
import { dispatchStartedRun } from "~/server/domains/run/repo/coordinator-dispatch";
import type {
  RunPurposeLifecycle,
  RunTargetRow,
} from "~/server/domains/run/repo/purpose-lifecycle";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";

/**
 * A Mail import Run's frozen roster with each source's latest applicable
 * outcome. An erased Run has no targets; its outcome receipts never stand in
 * for the roster.
 */
async function mailRunTargets(
  client: DrizzleClient | DrizzleTransaction,
  runId: RunId,
): Promise<RunTargetRow[]> {
  const mail = (await readMailRunRoster(client, runId)) ?? [];
  const receipts = await listRunTargetOutcomes(client, [runId]);
  const ownerIds = [
    ...new Set(
      mail.flatMap(({ email, owned }) =>
        !owned && email.runId ? [email.runId] : [],
      ),
    ),
  ];
  const owners = ownerIds.length
    ? await client
        .select({ id: runTable.id, shortcode: runTable.shortcode })
        .from(runTable)
        .where(inArray(runTable.id, ownerIds))
    : [];
  return mail.map(({ email, orderMailId, checksum, position, owned }) => {
    const outcome = receipts
      .filter(
        (item) =>
          item.workKey === orderMailId &&
          (item.targetFingerprint === checksum ||
            // Migrated hashes include a retired research version. Their
            // original Run/source identity binds them to this frozen roster.
            (item.operationId.startsWith("migrated-target:") &&
              item.entityKind === "run" &&
              item.entityId === runId &&
              item.sourceKind === "mail_message" &&
              item.sourceExternalKey === orderMailId)),
      )
      .sort((a, b) =>
        (b.completedAt ?? "").localeCompare(a.completedAt ?? ""),
      )[0];
    return {
      id: email.id,
      entityId: email.id,
      entityKind: "email" as const,
      workKey: orderMailId,
      position,
      vendorAccountId: null,
      vendorAccountCode: null,
      vendorAccountLabel: null,
      sourceKind: "mail_message",
      sourceExternalKey: orderMailId,
      targetFingerprint: checksum,
      entityCode: parseShortcodeFor("email", email.shortcode),
      state:
        outcome?.state ??
        (owned && email.status === "completed"
          ? ("completed" as const)
          : owned && email.status === "researching"
            ? ("pending" as const)
            : ("unresolved" as const)),
      outcome: outcome
        ? outcome.outcome
        : owned && email.status === "completed"
          ? ("verified" as const)
          : null,
      warning: outcome
        ? outcome.warning
        : !owned
          ? email.runId
            ? `Moved to ${owners.find((owner) => owner.id === email.runId)?.shortcode ?? "another Run"}.`
            : "Returned to Mail discovery after this Run ended."
          : email.classificationReason,
      diff: null,
      completedAt: outcome
        ? outcome.completedAt
          ? new Date(outcome.completedAt)
          : null
        : owned && email.status === "completed"
          ? email.updatedAt
          : null,
    };
  });
}

/**
 * A transiently failed Mail import retries its unsettled Emails as one
 * successor on the escalation coordinator model. Only Emails this Run still
 * owns with unchanged evidence and an admission attempt left at that checksum
 * move (`MAIL_IMPORT_ATTEMPTS_PER_REVISION`, three in total); settled ones
 * stay. Null when nothing is left to retry.
 */
async function retryTransientMailImport(tx: DrizzleTransaction, runId: RunId) {
  const [locked] = await tx
    .select()
    .from(runTable)
    .where(eq(runTable.id, runId));
  if (!locked?.input) return null;
  const roster = mailResearchRunInput.parse(locked.input);
  const unsettled = (await readMailRunRoster(tx, runId))?.filter(
    (source) =>
      source.owned &&
      source.unchanged &&
      // The successor attempts this Run's revision again.
      !importAttemptsExhausted(source.email, roster.evidenceRevision) &&
      (source.email.status === "researching" ||
        source.email.status === "unsettled"),
  );
  if (!unsettled?.length) return null;
  const successorId = runEntityId.parse(crypto.randomUUID());
  const dispatchEventId = crypto.randomUUID();
  const manifest = importRunAgentManifest.mail_import;
  await insertWithShortcode(tx, "run", {
    id: successorId,
    ledgerPartyId: locked.ledgerPartyId,
    actorUserId: locked.actorUserId,
    actorName: locked.actorName,
    actorEmail: locked.actorEmail,
    actorLedgerPartyShortcode: locked.actorLedgerPartyShortcode,
    actorLedgerPartyName: locked.actorLedgerPartyName,
    actorLedgerPartyKind: locked.actorLedgerPartyKind,
    vendorAccountId: locked.vendorAccountId,
    vendorId: locked.vendorId,
    predecessorRunId: runId,
    parentRunId: locked.parentRunId,
    purpose: locked.purpose,
    trigger: locked.trigger,
    channel: locked.channel,
    cause: runCause.enum.retry,
    status: "running",
    startedAt: new Date(),
    input: mailResearchRunInput.parse({
      ...roster,
      sources: roster.sources.filter((source) =>
        unsettled.some((held) => held.orderMailId === source.orderMailId),
      ),
    }),
    dispatchEventId,
    coordinatorModel: manifest.escalationModel ?? manifest.model,
    skillRevision: locked.skillRevision,
    runtimeRevision: locked.runtimeRevision,
    decisionRevision: locked.decisionRevision + 1,
    agentSessionId: importRunAgentIdentity(successorId, "mail_import"),
  });
  await transferMailRunSources(
    tx,
    runId,
    successorId,
    unsettled.map((source) => source.orderMailId),
  );
  await dispatchStartedRun(tx, {
    id: successorId,
    eventId: dispatchEventId,
    purpose: locked.purpose,
  });
  return successorId;
}

/**
 * A Mail import hands its sources to successors through membership transfer,
 * holds them when cancelled and releases them when its coordinator never ran.
 */
export const mailRunLifecycle: RunPurposeLifecycle = {
  targets: mailRunTargets,
  handOff: async (tx, { from, to, carried, restart }) => {
    await transferMailRunSources(
      tx,
      from,
      to,
      restart ? undefined : carried.map((target) => target.workKey),
    );
  },
  retryInput: (input, carried) => {
    const roster = mailResearchRunInput.parse(input);
    return {
      ...roster,
      sources: roster.sources.filter((source) =>
        carried.some((target) => target.workKey === source.orderMailId),
      ),
    };
  },
  // A cancelled Run must not keep Emails `researching` with nothing working
  // them, and discovery must not readmit what the member stopped: they stay
  // with this Run as `unsettled` for its retry or restart.
  cancelled: async (tx, { runId, input }) => {
    if (input !== null) await holdCancelledMailRunSources(tx, runId);
  },
  /**
   * The failure class decides what follows (ADR 0011): a transient failure
   * retries as a successor Run until its third attempt; a deterministic one,
   * or a transient one out of attempts, leaves exactly one Run finding and
   * keeps its claimed Emails `unsettled`.
   */
  failed: async (tx, { runId, ledgerPartyId, failureCode, detail }) => {
    const retried =
      failureCode === agentFailureCode.enum.agent_transient
        ? await retryTransientMailImport(tx, runId)
        : null;
    if (
      !retried &&
      failureCode !== agentFailureCode.enum.agent_aborted &&
      ledgerPartyId
    ) {
      const summary = (detail ?? `Coordinator failed (${failureCode})`).slice(
        0,
        1_000,
      );
      await publishRunFinding(tx, {
        runId,
        ledgerPartyId,
        entityKind: "run",
        entityId: runId,
        kind: "other",
        summary,
        proposedFix: null,
        evidenceFingerprint: await sha256Hex(
          `coordinator-failure:${runId}:${failureCode}`,
        ),
      });
    }
    // Changed sources the retry could not carry return through release.
    await releaseUnsettledMailRunSources(tx, runId);
  },
  // Its coordinator never started, so nothing else would ever admit these Emails.
  dispatchFailed: async (tx, runId) => {
    await releaseUnsettledMailRunSources(tx, runId);
  },
  beforeCoordinatorAdmission: waitForMailImportPermission,
};
