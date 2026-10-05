import { runEntityId } from "@cubby/schemas/identifiers";
import { sleep } from "@cubby/shared/retry";
import { eq } from "drizzle-orm";
import {
  from,
  mcp,
  type ScriptStep,
  type ScriptValue,
} from "tooling/purchase-agent-script";
import {
  type ScriptedScenario,
  scenarioControls,
} from "tooling/purchase-agent-workerd-harness";
import type { TestDbContext } from "tooling/test-setup";
import { openWorkerdRuntime } from "tooling/workerd-runtime";
import type { TestHarness } from "wrangler";

import {
  aiUsage,
  oauthRefreshToken,
  photoGroupProposal,
  runFinding,
  run as runTable,
  runOperation,
  runProgress,
  session,
} from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";

import {
  ensurePurchaseAgentOAuthClient,
  PURCHASE_AGENT_OAUTH_CLIENT_ID,
} from "./agent-auth";

type Db = TestDbContext["db"];

type Line = {
  title: string;
  amount: number;
  lineKind: "principal" | "tax" | "shipping";
  sku?: string;
};

/** The extractor's wire shape: every optional field is an explicit null. */
export const readyExtraction = (
  orderId: string,
  orderedAt: string,
  lines: Line[],
) => ({
  status: "ready",
  candidate: {
    orderId,
    orderedAt,
    merchant: "Scenario garden shop",
    currency: "USD",
    printedGrandTotal: lines.reduce((sum, line) => sum + line.amount, 0),
    lines: lines.map((line) => ({
      title: line.title,
      amount: line.amount,
      lineKind: line.lineKind,
      quantity: line.lineKind === "principal" ? 1 : null,
      productUrl: null,
      imageUrl: null,
      sku: line.sku ?? null,
      seller: null,
    })),
    payments: [],
    allShipmentsDelivered: false,
  },
  reason: null,
  detail: null,
});

/**
 * Prepare the order an `extract_run_evidence` call returned, unchanged, as
 * `prepare-<suffix>`; then the commit for its single line as a new Product.
 * Each commit step id is `commit-<suffix>`.
 */
export const mailPrepare = (
  extractCallId: string,
  suffix: string,
  runId: ScriptValue,
): ScriptStep => {
  const order = (path: string) => from(extractCallId, path);
  return mcp(
    `prepare-${suffix}`,
    "purchase_import",
    runId,
    {
      action: "prepare",
      orders: [
        {
          stableOrderId: order("stableOrderId"),
          itemOperationId: order("itemOperationId"),
          source: order("source"),
          evidenceChecksum: order("evidenceChecksum"),
          extractionRevision: order("extractionRevision"),
          extraction: order("extraction"),
          lineIds: order("lineIds"),
          primaryDocumentImageId: null,
          screenshotImageId: null,
        },
      ],
    },
    { itemOperationIds: [order("itemOperationId")] },
  );
};

/**
 * Commit `prepare-<suffix>` under operation id `commit-<suffix>`; `callId`
 * names the step, so a second call with the same suffix is a replay.
 */
export const mailCommit = (
  extractCallId: string,
  suffix: string,
  runId: ScriptValue,
  callId = `commit-${suffix}`,
): ScriptStep => {
  const order = (path: string) => from(extractCallId, path);
  return mcp(
    callId,
    "purchase_import",
    runId,
    {
      action: "commit",
      prepareOperationId: `prepare-${suffix}`,
      // A principal Expense needs a trade; nothing else supplies one.
      defaultTrade: "other",
      resolutions: [
        {
          stableOrderId: order("stableOrderId"),
          stableLineId: order("lineIds.0"),
          resolution: { kind: "new" },
        },
      ],
    },
    { operationId: `commit-${suffix}` },
  );
};

/** Poll a database predicate; a scenario never sleeps a fixed interval. */
export async function waitFor(
  predicate: () => Promise<boolean>,
  message: string,
  timeoutMs = 15_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(25);
  }
  throw new Error(message);
}

/** The member's active Purchase Agent grant, which MCP delegation requires. */
export async function authorizePurchaseAgent(db: Db, userId: string) {
  await ensurePurchaseAgentOAuthClient(db);
  const now = new Date();
  const sessionId = `purchase-agent-workerd-${crypto.randomUUID()}`;
  await getDb(db)
    .insert(session)
    .values({
      id: sessionId,
      token: `${sessionId}-token`,
      userId,
      expiresAt: new Date(now.getTime() + 60 * 60_000),
      createdAt: now,
      updatedAt: now,
    });
  await getDb(db)
    .insert(oauthRefreshToken)
    .values({
      id: `${sessionId}-grant`,
      token: `${sessionId}-refresh`,
      clientId: PURCHASE_AGENT_OAUTH_CLIENT_ID,
      sessionId,
      userId,
      expiresAt: new Date(now.getTime() + 60 * 60_000),
      createdAt: now,
      authTime: now,
      scopes: ["openid", "profile", "email", "offline_access"],
    });
}

export async function workerdDiagnostic(
  db: Db,
  runId: string,
  harness: TestHarness | undefined,
) {
  const id = runEntityId.parse(runId);
  const [run, operations, findings, progress, proposals, usage] =
    await Promise.all([
      getDb(db)
        .select({
          status: runTable.status,
          failureCode: runTable.failureCode,
          dispatchError: runTable.dispatchError,
          dispatchAttempts: runTable.dispatchAttempts,
          coordinatorStartedAt: runTable.coordinatorStartedAt,
        })
        .from(runTable)
        .where(eq(runTable.id, id)),
      getDb(db)
        .select({
          operationId: runOperation.operationId,
          kind: runOperation.kind,
          state: runOperation.state,
          result: runOperation.result,
          error: runOperation.error,
        })
        .from(runOperation)
        .where(eq(runOperation.runId, id)),
      // The review reason lives on the finding and the last progress report,
      // not on the run row.
      getDb(db)
        .select({ kind: runFinding.kind, summary: runFinding.summary })
        .from(runFinding)
        .where(eq(runFinding.runId, id)),
      getDb(db)
        .select({ phase: runProgress.phase, detail: runProgress.detail })
        .from(runProgress)
        .where(eq(runProgress.runId, id)),
      getDb(db)
        .select({ state: photoGroupProposal.state })
        .from(photoGroupProposal)
        .where(eq(photoGroupProposal.runId, id)),
      getDb(db)
        .select({ id: aiUsage.id })
        .from(aiUsage)
        .where(eq(aiUsage.runId, id)),
    ]);
  return JSON.stringify({
    run,
    operations,
    findings,
    progress,
    proposals,
    usage,
    logs: harness?.getLogs().slice(-60),
  });
}

export type ScenarioHarness = Awaited<ReturnType<typeof startScenarioHarness>>;

/**
 * Start the purchase-agent workerd harness and load one
 * scenario: the scripted model's steps and the web Worker's extractor/audit
 * outputs. Call `close()` in `afterEach`.
 */
export async function startScenarioHarness(
  databaseUrl: string,
  scenario: ScriptedScenario,
) {
  const { runtime, prepared: controls } = await openWorkerdRuntime(
    { profile: "purchase-agent", database: { borrowed: databaseUrl } },
    async ({ harness }) => {
      const controls = scenarioControls(harness);
      await controls.configure(scenario);
      return controls;
    },
  );
  return { harness: runtime.harness, ...controls, close: runtime.close };
}
