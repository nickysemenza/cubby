import { runShortcode } from "@cubby/schemas/identifiers";
import type {
  MailImportStatus,
  SetMailImportInput,
} from "@cubby/schemas/mail-import-settings";
import { runPurpose, runStatus } from "@cubby/schemas/run-fields";
import type { SweepFamilyScope } from "@cubby/schemas/run-fields";
import type { SweepStartInput } from "@cubby/schemas/sweep";
import { and, eq, isNull } from "drizzle-orm";
import type { z } from "zod";

import { runContract } from "~/contracts/run.contract";
import { listAiUsageForRun } from "~/server/ai/repo/ai-usage";
import { getDb, withTransactionDatabase } from "~/server/db/helpers";
import { oauthRefreshToken, run as runTable } from "~/server/db/schema";
import { startControlledMailImport } from "~/server/domains/purchase-import/operations/gmail/controlled-import";
import { startMailDiscovery } from "~/server/domains/purchase-import/operations/gmail/discovery";
import { commitPurchaseImport } from "~/server/domains/purchase-import/operations/import-orders";
import {
  findActivePurchaseAgentGrant,
  PURCHASE_AGENT_OAUTH_CLIENT_ID,
} from "~/server/domains/purchase-import/repo/agent-auth";
import { readMailCoverage } from "~/server/domains/purchase-import/repo/gmail/mail-coverage";
import { withMailSearchProgress } from "~/server/domains/purchase-import/repo/gmail/search-progress";
import { listMemberMailboxes } from "~/server/domains/purchase-import/repo/gmail/targets";
import {
  readMailImportSettings,
  resumeControlledMailImport,
  setMailImport,
} from "~/server/domains/purchase-import/repo/mail-import-settings";
import {
  controlRun,
  loadRunDetail,
  loadRunLog,
  pauseAuthorizedRuns,
} from "~/server/domains/purchase-import/repo/run-service";
import {
  listRuns,
  listProductRuns,
  reportRunTargetDeviceWork,
  resolveProductImportTarget,
  resolvePurchaseImportTarget,
} from "~/server/domains/purchase-import/repo/run-target";
import { readPurchaseAgentConversation } from "~/server/domains/purchase-import/service/agent-proxy";
import { readRunCatalogActivity } from "~/server/domains/run/repo/catalog-activity";
import {
  findOwnedMailDiscovery,
  loadMailDiscoveryRead,
} from "~/server/domains/run/repo/run-discovery-read";
import { loadMailReclassificationRead } from "~/server/domains/run/repo/run-reclassification-read";
import { readRunSteps } from "~/server/domains/run/repo/run-step";
import { getRunWorkProgress } from "~/server/domains/run/repo/work-progress";
import { assertPaidOverride } from "~/server/domains/run/service/paid-override";
import { createAppError } from "~/server/errors/app-error";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";
import type { AuthenticatedRequestContext } from "~/server/http/request-context";
import { implementOperationDomain } from "~/server/operation-runtime/operation-domain.server";
import { isExecutedRunPurpose } from "~/server/workflows/runs/contract";

/** Import runs belong to a household member's ledger party. */
async function memberParty(context: AuthenticatedRequestContext) {
  const party = await context.currentParty();
  if (!party)
    throw new Error("This login is not linked to a member ledger party yet.");
  return party;
}

/** Resolve public entity scopes before estimating or creating any Sweep work. */
async function sweepScopes(
  db: AuthenticatedRequestContext["db"],
  input: SweepStartInput,
): Promise<SweepFamilyScope[]> {
  return Promise.all(
    input.families.map(async (entry): Promise<SweepFamilyScope> => {
      switch (entry.family) {
        case "transfer_pair":
        case "statement_transaction":
          return {
            family: entry.family,
            scope: {
              ...(entry.family === "statement_transaction" &&
                entry.importId && {
                  importId: await resolveOrThrow(
                    db,
                    "transactionImport",
                    entry.importId,
                  ),
                }),
              ...(entry.accountIds?.length && {
                accountIds: await Promise.all(
                  entry.accountIds.map((code) =>
                    resolveOrThrow(db, "financialAccount", code),
                  ),
                ),
              }),
              ...(entry.since && { since: entry.since }),
            },
          };
        case "recommendation":
          return {
            family: entry.family,
            scope: entry.entityKinds?.length
              ? { entityKinds: entry.entityKinds }
              : {},
          };
        case "field":
          return {
            family: entry.family,
            scope: entry.targets?.length ? { targets: entry.targets } : {},
          };
      }
    }),
  );
}

async function controlRunOperation(
  context: AuthenticatedRequestContext,
  { runId, ...input }: z.infer<typeof runContract.ops.control.input>,
): Promise<z.input<typeof runContract.ops.control.output>> {
  await memberParty(context);
  if (input.action === "run_now_paid")
    await assertPaidOverride(context.db, input.paidOverBudgetUsd);
  else if (input.paidOverBudgetUsd !== undefined)
    throw createAppError(
      "RUN_CONTROL_UNSUPPORTED",
      "paidOverBudgetUsd applies only to run_now_paid.",
    );
  const [target] = await getDb(context.db)
    .select({ purpose: runTable.purpose })
    .from(runTable)
    .where(eq(runTable.shortcode, runShortcode.parse(runId)))
    .limit(1);
  if (target?.purpose === "mail_search")
    throw new Error(
      "Historical vendor-search Runs cannot execute again; start current research instead.",
    );
  // A Workflow executes these Runs: cancel and retry act on its instance.
  if (target && isExecutedRunPurpose(target.purpose)) {
    const { controlWorkflowRun } =
      await import("~/server/workflows/runs/control");
    await controlWorkflowRun(
      context.db,
      context.actorContext,
      { runPublicId: runId, ...input },
      target.purpose,
    );
    return { run: await loadRunDetail(context.db, runId), successor: null };
  }
  const control = await controlRun(context.db, context.actorContext, {
    runPublicId: runId,
    ...input,
  });
  return {
    run: await loadRunDetail(context.db, runId),
    successor:
      "successorRunPublicId" in control && control.successorRunPublicId
        ? {
            publicId: control.successorRunPublicId,
            status: control.successorStatus,
            created: control.created,
          }
        : null,
  };
}

/** The member's connected Google mailboxes with their switches and search progress. */
async function mailImportStatusFor(
  context: Parameters<typeof memberParty>[0],
): Promise<MailImportStatus> {
  const party = await memberParty(context);
  const [members, settings] = await Promise.all([
    listMemberMailboxes(context.db),
    readMailImportSettings(context.db),
  ]);
  const connected = members.filter(
    (member) =>
      member.userId === context.auth.userId &&
      member.ledgerPartyId === party.id,
  );
  return {
    mailboxes: await withMailSearchProgress(
      context.db,
      party.id,
      connected.map(({ mailboxId, name }, index) => ({
        mailboxId,
        label: `${name} · Gmail${connected.length > 1 ? ` ${index + 1}` : ""}`,
        enabled: settings.enabledMailboxes.includes(mailboxId),
      })),
    ),
  };
}

async function changeMailImport(
  context: Parameters<typeof memberParty>[0],
  change:
    | ({ kind: "switch" } & SetMailImportInput)
    | ({ kind: "resume" } & Pick<SetMailImportInput, "mailboxId">),
): Promise<MailImportStatus> {
  const { mailboxes } = await mailImportStatusFor(context);
  if (!mailboxes.some((mailbox) => mailbox.mailboxId === change.mailboxId))
    throw new Error(
      `Mailbox ${change.mailboxId} is not connected to this member.`,
    );
  await withTransactionDatabase(context.db, async (tx) => {
    if (change.kind === "switch") await setMailImport(tx, change);
    else await resumeControlledMailImport(tx, change.mailboxId);
    await (
      await import("~/server/workflows/background-tasks/publish")
    ).publishBackgroundTasks(
      tx,
      [
        {
          kind: "maintenance.purchase-discovery",
          requestedAt: new Date().toISOString(),
        },
      ],
      { source: "mail-import-setting" },
    );
  });
  return mailImportStatusFor(context);
}

export const runHandlers = implementOperationDomain(runContract, {
  mailCoverage: async (context) =>
    readMailCoverage(context.db, context.auth.userId),
  controlledMailImport: async (context, input) => {
    await memberParty(context);
    return startControlledMailImport(context.db, context.actorContext, input);
  },
  resumeControlledMailImport: async (context, input) =>
    changeMailImport(context, { kind: "resume", ...input }),
  catalogActivity: async (context) => readRunCatalogActivity(context.db),
  mailImport: async (context) => mailImportStatusFor(context),
  setMailImport: async (context, input) =>
    changeMailImport(context, { kind: "switch", ...input }),
  discoverMail: async (context, input) => {
    const party = await memberParty(context);
    if (input.paidAllowed)
      await assertPaidOverride(context.db, input.paidOverBudgetUsd);
    else if (input.paidOverBudgetUsd !== undefined)
      throw createAppError(
        "RUN_CONTROL_UNSUPPORTED",
        "paidOverBudgetUsd applies only with paidAllowed.",
      );
    return startMailDiscovery(context.db, {
      target: {
        ledgerPartyId: party.id,
        userId: context.auth.userId,
        mailboxId: input.mailboxId,
      },
      ...(input.paidAllowed && {
        paidGrant: {
          actor: context.actorContext,
          paidOverBudgetUsd: input.paidOverBudgetUsd,
        },
      }),
    });
  },
  transcript: async (context, input) => {
    const party = await memberParty(context);
    const discovery = await findOwnedMailDiscovery(context.db, input.runId, {
      userId: context.auth.userId,
      ledgerPartyId: party.id,
    });
    if (discovery)
      return runContract.ops.transcript.output.parse({
        status: "absent",
        messages: [],
        settlements: [],
        nextCursor: null,
      });
    const conversation = await readPurchaseAgentConversation({
      publicId: input.runId,
      context,
      party,
    });
    const end = input.cursor + input.limit;
    return {
      status: conversation.status,
      messages: conversation.messages.slice(input.cursor, end),
      settlements: conversation.settlements.slice(input.cursor, end),
      nextCursor:
        end <
        Math.max(conversation.messages.length, conversation.settlements.length)
          ? end
          : null,
    };
  },
  workSnapshot: async (context, input) => {
    const party = await context.currentParty();
    const mailDiscovery = await loadMailDiscoveryRead(
      context.db,
      input.runId,
      party ? { userId: context.auth.userId, ledgerPartyId: party.id } : null,
      { cursor: input.emailCursor, limit: input.emailLimit },
    );
    const mailReclassification = await loadMailReclassificationRead(
      context.db,
      input.runId,
      party ? { userId: context.auth.userId, ledgerPartyId: party.id } : null,
    );
    const run = await loadRunDetail(context.db, input.runId);
    const workProgress = await getRunWorkProgress(context.db, input.runId);
    if (!workProgress) throw new Error("Run progress was not found");
    const steps = await readRunSteps(
      context.db,
      await resolveOrThrow(context.db, "run", input.runId),
    );
    return {
      runId: input.runId,
      purpose: runPurpose.parse(run.purpose),
      status: runStatus.parse(run.status),
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      retirementReason: run.retirementReason,
      coordinatorModel: run.coordinatorModel,
      agentModelMs: run.agentModelMs,
      ordersSeen: run.ordersSeen,
      imported: run.imported,
      updated: run.updated,
      skipped: run.skipped,
      findings: run.findings,
      targetsTotal: run.targets.length,
      targetsCompleted: run.targets.filter(
        (target) => target.state === "completed" || target.state === "skipped",
      ).length,
      workProgress,
      targets: run.targets.map((target) => ({
        targetType: target.targetType,
        targetShortcode: target.targetShortcode,
        targetName: target.targetName,
        state: target.state,
        outcome: target.outcome,
        warning: target.warning,
        completedAt: target.completedAt,
      })),
      progress: run.progress,
      operations: run.operations,
      stepFailures: steps
        .filter((step) => step.failed > 0)
        .map((step) => ({
          key: step.key,
          label: step.label,
          failed: step.failed,
          errors: step.errors ?? [],
        })),
      mailDiscovery,
      mailReclassification,
    };
  },
  history: async (context, input) => {
    const party = await memberParty(context);
    const purchaseId = input.purchaseId
      ? await resolvePurchaseImportTarget(context.db, input.purchaseId)
      : undefined;
    if (purchaseId === null) throw new Error("Purchase was not found");
    const productId = input.productId
      ? await resolveProductImportTarget(context.db, input.productId)
      : undefined;
    if (productId === null) throw new Error("Product was not found");
    const runs = productId
      ? await listProductRuns(context.db, party.id, productId)
      : await listRuns(context.db, party.id, purchaseId);
    return {
      runs: runs.map((run) => ({
        ...run,
        purpose: runPurpose.parse(run.purpose),
        startedAt: run.startedAt.toISOString(),
        endedAt: run.endedAt?.toISOString() ?? null,
      })),
    };
  },
  work: async (context, input) => {
    await memberParty(context);
    return loadRunDetail(context.db, input.runId);
  },
  commitPrepared: async (context, { runId, operationId, ...input }) => {
    await memberParty(context);
    return commitPurchaseImport(
      context.db,
      {
        ...input,
        _runExecution: { run: runId, operationId },
      },
      context.actorContext,
    );
  },
  control: controlRunOperation,
  sweep: async (context, input) => {
    await memberParty(context);
    const { startSweep } = await import("../service/sweep");
    const runId = await startSweep(context.db, context.actorContext, {
      trigger: "manual",
      families: await sweepScopes(context.db, input),
    });
    const [row] = await getDb(context.db)
      .select({ shortcode: runTable.shortcode })
      .from(runTable)
      .where(eq(runTable.id, runId));
    return { runId: runShortcode.parse(row?.shortcode) };
  },
  sweepEstimate: async (context, input) => {
    await memberParty(context);
    const { estimateSweep } = await import("../service/sweep");
    return {
      families: await estimateSweep(
        context.db,
        await sweepScopes(context.db, input),
      ),
    };
  },
  retryStep: async (context, { runId, stepKey }) => {
    await memberParty(context);
    const [target] = await getDb(context.db)
      .select({ id: runTable.id })
      .from(runTable)
      .where(eq(runTable.shortcode, runShortcode.parse(runId)))
      .limit(1);
    if (!target) throw new Error(`Run ${runId} was not found`);
    const { retryRunStep } = await import("../service/step-run");
    await retryRunStep(context.db, target.id, stepKey);
    return { run: await loadRunDetail(context.db, runId) };
  },
  lifecycle: (context, { controlAction, ...input }) =>
    controlRunOperation(context, { ...input, action: controlAction }),
  logs: async (context, input) => {
    await memberParty(context);
    return loadRunLog(context.db, input.runId);
  },
  agentConnection: async (context) => {
    const grant = await findActivePurchaseAgentGrant(
      context.db,
      context.auth.userId,
    );
    return {
      authorized: grant !== null,
      expiresAt: grant?.expiresAt?.toISOString() ?? null,
    };
  },
  disconnectAgent: async (context) => {
    await getDb(context.db)
      .update(oauthRefreshToken)
      .set({ revoked: new Date() })
      .where(
        and(
          eq(oauthRefreshToken.clientId, PURCHASE_AGENT_OAUTH_CLIENT_ID),
          eq(oauthRefreshToken.userId, context.auth.userId),
          isNull(oauthRefreshToken.revoked),
        ),
      );
    await pauseAuthorizedRuns(context.db, context.auth.userId);
    return { authorized: false, expiresAt: null };
  },
  aiUsage: async (context, input) =>
    listAiUsageForRun(
      context.db,
      await resolveOrThrow(context.db, "run", input.runId),
      { cursor: input.cursor, limit: input.limit },
    ),
  reportDeviceWork: async (context, input) => {
    await memberParty(context);
    return reportRunTargetDeviceWork(context.db, {
      run: input.run,
      image: input.image,
      state: input.state,
      error: input.error,
    });
  },
});
