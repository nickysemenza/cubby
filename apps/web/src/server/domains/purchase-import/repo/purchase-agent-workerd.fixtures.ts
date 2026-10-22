import { runEntityId } from "@cubby/schemas/identifiers";
import { sleep } from "@cubby/shared/retry";
import { and, eq } from "drizzle-orm";
import {
  type ScriptedScenario,
  scenarioControls,
} from "tooling/purchase-agent-workerd-harness";
import type { TestDbContext } from "tooling/test-setup";
import {
  openWorkerdRuntime,
  type WorkerdRuntimeOptions,
} from "tooling/workerd-runtime";
import type { TestHarness } from "wrangler";

import { account } from "~/server/db/auth.schema";
import { getDb } from "~/server/db/helpers";
import {
  aiUsage,
  assessmentState,
  oauthRefreshToken,
  photoGroupProposal,
  run as runTable,
  runOperation,
  session,
} from "~/server/db/schema";
import {
  ensurePurchaseAgentOAuthClient,
  PURCHASE_AGENT_OAUTH_CLIENT_ID,
} from "~/server/domains/purchase-import/repo/agent-auth";
import { setMailImport } from "~/server/domains/purchase-import/repo/mail-import-settings";
import {
  isRunFinding,
  runFindingColumns,
} from "~/server/domains/purchase-import/repo/run-finding";

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

/** A connected synthetic mailbox with automatic Mail import on. */
export async function enableSyntheticMailImport(
  context: Pick<TestDbContext, "db" | "actor">,
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
  await setMailImport(context.db, { mailboxId, enabled: true });
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
      // Findings retain the review reason beside the Run-owned display history.
      getDb(db)
        .select({
          kind: runFindingColumns.kind,
          summary: runFindingColumns.summary,
        })
        .from(assessmentState)
        .where(and(isRunFinding, eq(assessmentState.runId, id))),
      getDb(db)
        .select({ history: runTable.progressHistory })
        .from(runTable)
        .where(eq(runTable.id, id))
        .then((rows) => rows[0]?.history ?? []),
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
 * real background consumers. Pass `objectStorage: undefined` when a scenario
 * never reads or writes objects. Call `close()` in `afterEach`.
 */
export async function startScenarioHarness(
  databaseUrl: string,
  scenario: ScriptedScenario,
  profile: "purchase-agent" | "gmail-research" = "purchase-agent",
  options: Pick<
    WorkerdRuntimeOptions,
    "coordinatorModels" | "objectStorage"
  > = {},
) {
  const { runtime, prepared: controls } = await openWorkerdRuntime(
    {
      profile,
      database: { borrowed: databaseUrl },
      objectStorage: {},
      ...options,
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
