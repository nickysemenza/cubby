/* eslint-disable anti-slop/no-unsafe-dictionary-type, anti-slop/no-object-parameters, anti-slop/no-unknown-returns, anti-slop/no-known-value-widening -- Queue events, browser outcomes, and peer fixtures are external wire payloads the harness forwards unchanged as JSON. */
import { runEntityId } from "@cubby/schemas/identifiers";
import { sleep } from "@cubby/shared/retry";
import { eq } from "drizzle-orm";
import type { ScriptStep } from "tooling/purchase-agent-script";
import { createWorkerdHarness } from "tooling/purchase-agent-workerd-harness";
import type { TestDbContext } from "tooling/test-setup";
import type { TestHarness } from "wrangler";
import { z } from "zod";

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
 * Start the coupled web + purchase-agent workerd harness and load one
 * scenario: the scripted model's steps and the web Worker's extractor/audit
 * outputs. Call `close()` in `afterEach`.
 */
export async function startScenarioHarness(
  databaseUrl: string,
  scenario: {
    steps: ScriptStep[];
    extractions?: Array<{ match: string; output: unknown }>;
    audit?: unknown;
  },
) {
  const hyperdrive = new Map(
    [
      "WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE",
      "WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE_CACHED",
    ].map((key) => [key, process.env[key]]),
  );
  for (const key of hyperdrive.keys()) process.env[key] = databaseUrl;
  const harness = createWorkerdHarness(databaseUrl);
  const restore = () => {
    for (const [key, value] of hyperdrive) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  try {
    const { url } = await harness.listen();
    const model = harness.getWorker("cubby-test-model");
    const gateway = harness.getWorker("cubby-test-gateway");
    type JsonPost = {
      method: "POST";
      headers: Record<string, string>;
      body: string;
    };
    type Sender = (
      path: string,
      init: JsonPost,
    ) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;
    const post = async (send: Sender, path: string, body: object) => {
      const response = await send(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok)
        throw new Error(`${path} ${response.status}: ${await response.text()}`);
    };
    const toModel: Sender = (path, init) => model.fetch(path, init);
    const toGateway: Sender = (path, init) => gateway.fetch(path, init);
    const toQueue: Sender = (path, init) => fetch(new URL(path, url), init);
    const toAgent: Sender = (path, init) =>
      harness.getWorker("purchase-agent").fetch(path, {
        ...init,
        headers: {
          ...init.headers,
          "x-cubby-agent-service": "purchase-import-proxy-v1",
        },
      });
    const readJson = async <T>(
      schema: z.ZodType<T>,
      send: () => Promise<{ json(): Promise<unknown> }>,
    ): Promise<T> => schema.parse(await (await send()).json());
    await post(toModel, "https://model.test/configure", {
      steps: scenario.steps,
    });
    const gatewayFixture: { extractions: unknown[]; audit?: unknown } = {
      extractions: scenario.extractions ?? [],
    };
    if (scenario.audit) gatewayFixture.audit = scenario.audit;
    await post(toGateway, "https://gateway.test/configure", gatewayFixture);
    return {
      harness,
      /** Deliver one purchase-agent queue event, as the web Worker would. */
      dispatch: (event: Record<string, unknown>) =>
        post(toQueue, "/dispatch", event),
      /** Connect a simulated Mac browser that answers commands by URL. */
      connectBrowser: (input: {
        vendorAccountId: string;
        ledgerPartyId: string;
        userId: string;
        outcomes?: Record<string, unknown>;
        delayMs?: number;
      }) => post(toQueue, "/browser-connect", input),
      /** Deliver a member's chat turn to the run's Flue conversation. */
      prompt: (agentId: string, body: string) =>
        post(
          toAgent,
          `https://purchase-agent.internal/internal/agents/purchase-import-run/${encodeURIComponent(agentId)}`,
          { kind: "user", body },
        ),
      violations: async () =>
        readJson(z.array(z.string()), () =>
          model.fetch("https://model.test/violations"),
        ),
      /** Each step the scripted model emitted: what Flue actually executed. */
      emitted: async () =>
        readJson(z.array(z.string()), () =>
          model.fetch("https://model.test/emitted"),
        ),
      gatewayCalls: async () =>
        readJson(
          z.array(
            z.object({ feature: z.string(), matched: z.string().nullable() }),
          ),
          () => gateway.fetch("https://gateway.test/calls"),
        ),
      close: async () => {
        try {
          await harness.close();
        } finally {
          restore();
        }
      },
    };
  } catch (error) {
    await harness.close();
    restore();
    throw error;
  }
}
