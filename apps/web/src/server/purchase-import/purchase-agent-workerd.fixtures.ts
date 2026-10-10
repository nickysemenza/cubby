import { executionAuthorizationInput } from "@cubby/schemas/execution-authorization";
import { type LedgerPartyId, runEntityId } from "@cubby/schemas/identifiers";
import { sleep } from "@cubby/shared/retry";
import { and, eq } from "drizzle-orm";
import {
  type ScriptedScenario,
  scenarioControls,
} from "tooling/purchase-agent-workerd-harness";
import type { TestDbContext } from "tooling/test-setup";
import { openWorkerdRuntime } from "tooling/workerd-runtime";
import type { TestHarness } from "wrangler";

import { account } from "~/server/db/auth.schema";
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
import { issueExecutionAuthorization } from "~/server/runs/execution-authorization";

import {
  ensurePurchaseAgentOAuthClient,
  PURCHASE_AGENT_OAUTH_CLIENT_ID,
} from "./agent-auth";

type Db = TestDbContext["db"];

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

/** Scripted inference uses real durable admission and synthetic funds. */
export async function authorizeSyntheticBackfill(
  context: Pick<TestDbContext, "db" | "actor">,
  memberId: LedgerPartyId,
  mailboxId: string,
) {
  const database = getDb(context.db);
  const [connected] = await database
    .select({ id: account.id })
    .from(account)
    .where(
      and(
        eq(account.userId, context.actor.userId),
        eq(account.providerId, "google"),
        eq(account.accountId, mailboxId),
      ),
    );
  if (!connected)
    await database.insert(account).values({
      id: crypto.randomUUID(),
      accountId: mailboxId,
      providerId: "google",
      userId: context.actor.userId,
      updatedAt: new Date(),
    });
  return issueExecutionAuthorization(
    context.db,
    context.actor,
    executionAuthorizationInput.parse({
      kind: "execution_authorization",
      version: 1,
      owner: { userId: context.actor.userId, ledgerPartyId: memberId },
      scope: { kind: "backfill", mailboxId, discovery: "all_history" },
      meteredBudget: { period: "lifetime", limitMicroUSD: 10_000_000 },
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    }),
  );
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
 * Start the built Worker with deterministic purchase-agent peers and load one
 * scenario: the scripted model's steps and the gateway's extraction, audit
 * and decision outputs. `gmail-research` adds the local Google provider and
 * real background consumers. Call `close()` in `afterEach`.
 */
export async function startScenarioHarness(
  databaseUrl: string,
  scenario: ScriptedScenario,
  profile: "purchase-agent" | "gmail-research" = "purchase-agent",
) {
  const { runtime, prepared: controls } = await openWorkerdRuntime(
    {
      profile,
      database: { borrowed: databaseUrl },
      objectStorage: {},
    },
    async ({ harness }) => {
      const controls = scenarioControls(harness);
      await controls.configure(scenario);
      return controls;
    },
  );
  return {
    harness: runtime.harness,
    origin: runtime.origin,
    googleProvider: runtime.googleProvider,
    ...controls,
    close: runtime.close,
  };
}
