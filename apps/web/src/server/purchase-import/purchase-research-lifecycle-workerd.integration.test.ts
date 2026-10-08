import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { importRunAgentIdentity } from "@cubby/schemas/import-run-agent";
import type { PurchaseAgentEvent } from "@cubby/schemas/purchase-import";
import { productResearchRunInput } from "@cubby/schemas/run-fields";
import { and, eq, getTableColumns } from "drizzle-orm";
import {
  captureE2ERunIdentity,
  writeE2ERunBundle,
  type E2ERunIdentity,
} from "tooling/e2e-run-bundle";
import { sanitizeWorkerdLogs } from "tooling/e2e-workerd-logs";
import { from, type ScriptStep } from "tooling/purchase-agent-script";
import { withTestDb } from "tooling/test-setup";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { scrubErrorMessage } from "~/lib/error-diagnostics";
import {
  expense,
  inventoryEntry,
  oauthRefreshToken,
  product,
  purchase,
  run,
  runEvidence,
  runFactEvidence,
  runOperation,
  runTarget,
} from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import {
  createProductFixture,
  makeProductInput,
} from "~/server/repo/repo.fixtures";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

import {
  findActivePurchaseAgentGrant,
  PURCHASE_AGENT_OAUTH_CLIENT_ID,
} from "./agent-auth";
import { browserCommandRecord } from "./browser-results";
import { completedCapture } from "./browser.fixtures";
import { startProductResearch } from "./product-research-run";
import {
  authorizePurchaseAgent,
  startScenarioHarness,
  waitFor,
  workerdDiagnostic,
  type ScenarioHarness,
} from "./purchase-agent-workerd.fixtures";
import { controlRun } from "./run-service";

// Real admission, Queue, coordinator, broker and domain storage must fence a
// revoked grant before a model turn, and a cancelled Run before late capture
// retention, resolution or revival. Only model decisions and Mac capture are peers.
const repoRoot = fileURLToPath(new URL("../../../../../", import.meta.url));
const pageURL = "https://maker.example.test/small-fan";
const coordinatorReceipt = z.object({ accepted: z.boolean() });
const brokerState = z.object({
  connected: z.boolean(),
  pending: z.array(z.object({ requestId: z.uuid(), createdAt: z.number() })),
  result: z
    .object({
      commandID: z.uuid(),
      operationID: z.string(),
      runID: z.uuid(),
      outcome: z.object({ status: z.literal("completed") }),
    })
    .nullable(),
});

describe("current research authorization and cancellation through the built Worker", () => {
  const ctx = withTestDb();
  let runtime: ScenarioHarness | undefined;
  let started: E2ERunIdentity;
  let status = "failed";
  let scenario = "synthetic-research-lifecycle";
  let runId: typeof run.$inferSelect.id | undefined;
  let boundaries: Array<{ name: string; passed: boolean }> = [];
  let browserBoundary:
    | {
        before: z.infer<typeof brokerState>;
        completed?: z.infer<typeof brokerState>;
        replayReceipts: z.infer<typeof coordinatorReceipt>[];
      }
    | undefined;

  const factsForRun = (id: typeof run.$inferSelect.id) =>
    getDb(ctx.db)
      .select(getTableColumns(runFactEvidence))
      .from(runFactEvidence)
      .innerJoin(runTarget, eq(runFactEvidence.targetId, runTarget.id))
      .where(eq(runTarget.runId, id));

  beforeEach(() => {
    started = captureE2ERunIdentity(repoRoot);
    status = "failed";
    runId = undefined;
    boundaries = [];
    browserBoundary = undefined;
  });

  afterEach(async () => {
    const diagnostic = await (async () => {
      try {
        return {
          emitted: await runtime?.emitted(),
          violations: await runtime?.violations(),
          gateway: await runtime?.gatewayCalls(),
          state: runId
            ? await workerdDiagnostic(ctx.db, runId, runtime?.harness)
            : null,
          facts: runId ? await factsForRun(runId) : [],
          logs: sanitizeWorkerdLogs(runtime?.harness.getLogs() ?? []),
        };
      } catch (error) {
        return {
          diagnosticError: scrubErrorMessage(
            error instanceof Error ? error.message : String(error),
          ),
        };
      }
    })();
    try {
      await runtime?.close();
    } finally {
      runtime = undefined;
      const outputDir = path.join(
        repoRoot,
        "artifacts/purchase-research-lifecycle",
        new Date().toISOString().replace(/[:.]/gu, "-"),
      );
      mkdirSync(outputDir, { recursive: true });
      const evidence = path.join(outputDir, "boundary-results.json");
      writeFileSync(
        evidence,
        `${JSON.stringify({ synthetic: true, status, boundaries, browserBoundary, diagnostic }, null, 2)}\n`,
      );
      writeE2ERunBundle({
        repoRoot,
        outputDir,
        evidence: [evidence],
        started,
        kind: "browser",
        status,
        profile: "purchase-agent",
        scenario,
        cases: [{ name: scenario, status }],
        command: [
          "pnpm",
          "--dir",
          "apps/web",
          "test:postgres",
          "src/server/purchase-import/purchase-research-lifecycle-workerd.integration.test.ts",
          "--project",
          "integration-workerd",
        ],
      });
    }
  });

  async function fixture(browser = false) {
    const member = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic lifecycle member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const item = await createProductFixture(
      ctx.db,
      makeProductInput({
        name: "Synthetic small fan",
        manufacturer: "Example Works",
        model: "",
      }),
      ctx.actor,
    );
    const vendor = browser
      ? await insertWithShortcode(ctx.db, "vendor", {
          name: "Synthetic browser maker",
          website: "https://maker.example.test",
          browserDomains: ["maker.example.test"],
        })
      : null;
    const account = vendor
      ? await insertWithShortcode(ctx.db, "vendorAccount", {
          label: "Synthetic lifecycle browser",
          vendorId: vendor.id,
          ledgerPartyId: member.id,
          browserSyncEnabled: true,
        })
      : null;
    await authorizePurchaseAgent(ctx.db, ctx.actor.userId);
    const events: PurchaseAgentEvent[] = [];
    const [admitted] = await startProductResearch(
      ctx.db,
      {
        ledgerPartyId: member.id,
        userId: ctx.actor.userId,
        productIds: [item.entityId],
        cause: "member_request",
        preferredBrowserAccountId: account?.id,
      },
      { send: async (event) => void events.push(event) },
    );
    if (!admitted)
      throw new Error("Synthetic Product research was not admitted");
    runId = admitted.runId;
    const [saved] = await getDb(ctx.db)
      .select()
      .from(run)
      .where(eq(run.id, admitted.runId));
    if (!saved) throw new Error("Synthetic admitted Run disappeared");
    expect(productResearchRunInput.parse(saved.input)).toMatchObject({
      kind: "product_research",
      products: [{ productId: item.entityId }],
    });
    expect(events).toHaveLength(1);
    const event = events[0];
    if (!event)
      throw new Error("Synthetic admission did not publish its event");
    expect(event).toMatchObject({
      type: "start_or_resume",
      runId: saved.id,
      purpose: "product_enrichment",
      eventId: saved.dispatchEventId,
    });
    return { member, item, account, saved, event };
  }

  it("pauses an admitted Product Run before any model turn or effect when its live grant is revoked before dispatch", async () => {
    scenario = "revoked-grant-before-current-dispatch";
    expect(started.build.sourceFresh).toBe(true);
    const f = await fixture();
    runtime = await startScenarioHarness(ctx.databaseUrl, {
      steps: [{ call: "unauthorized-next", tool: "work_next", args: {} }],
    });
    expect(
      await findActivePurchaseAgentGrant(ctx.db, ctx.actor.userId),
    ).not.toBeNull();
    await getDb(ctx.db)
      .update(oauthRefreshToken)
      .set({ revoked: new Date() })
      .where(
        and(
          eq(oauthRefreshToken.userId, ctx.actor.userId),
          eq(oauthRefreshToken.clientId, PURCHASE_AGENT_OAUTH_CLIENT_ID),
        ),
      );
    expect(
      await findActivePurchaseAgentGrant(ctx.db, ctx.actor.userId),
    ).toBeNull();
    await runtime.dispatch(f.event);
    await waitFor(async () => {
      const [row] = await getDb(ctx.db)
        .select({ status: run.status })
        .from(run)
        .where(eq(run.id, f.saved.id));
      return row?.status === "paused_auth";
    }, "Revoked grant did not pause current research before execution");
    expect(await runtime.emitted()).toEqual([]);
    expect(await runtime.gatewayCalls()).toEqual([]);
    expect(await runtime.violations()).toEqual([]);
    expect(
      await getDb(ctx.db)
        .select()
        .from(runOperation)
        .where(eq(runOperation.runId, f.saved.id)),
    ).toEqual([]);
    expect(
      await getDb(ctx.db)
        .select()
        .from(runEvidence)
        .where(eq(runEvidence.runId, f.saved.id)),
    ).toEqual([]);
    expect(await factsForRun(f.saved.id)).toEqual([]);
    expect(
      await getDb(ctx.db)
        .select({ model: product.model })
        .from(product)
        .where(eq(product.id, f.item.entityId)),
    ).toEqual([{ model: "" }]);
    expect(
      await getDb(ctx.db).select({ id: purchase.id }).from(purchase),
    ).toEqual([]);
    expect(
      await getDb(ctx.db).select({ id: expense.id }).from(expense),
    ).toEqual([]);
    expect(
      await getDb(ctx.db)
        .select({ id: inventoryEntry.id })
        .from(inventoryEntry),
    ).toEqual([]);
    const [target] = await getDb(ctx.db)
      .select()
      .from(runTarget)
      .where(eq(runTarget.runId, f.saved.id));
    expect(target).toMatchObject({
      entityKind: "product",
      entityId: f.item.entityId,
      state: "pending",
      outcome: null,
    });
    boundaries.push({
      name: "authorization-before-model-or-effect",
      passed: true,
    });
    status = "passed";
  }, 30_000);

  it("keeps cancellation immutable when the pending broker later completes and redelivers its result", async () => {
    scenario = "cancel-current-task-before-late-broker-result";
    expect(started.build.sourceFresh).toBe(true);
    const f = await fixture(true);
    if (!f.account) throw new Error("Synthetic browser transport missing");
    const steps: ScriptStep[] = [
      { call: "cancel-next", tool: "work_next", args: {} },
      {
        call: "cancel-browser",
        tool: "work_observe",
        args: {
          workRef: from("cancel-next", "work.workRef"),
          action: { kind: "navigate", url: pageURL },
        },
      },
      { check: "cancel-browser", includes: "browser_pending" },
      { await: ["research_observation"] },
      {
        call: "forbidden-late-resolve",
        tool: "work_resolve",
        args: {
          workRef: from("cancel-next", "work.workRef"),
          status: "researched_with_gaps",
          identity: {
            evidenceIds: [
              { $signal: "research_observation", path: "evidenceId" },
            ],
            reasoning:
              "The retained original identifies Example Works small fan model F17SB.",
          },
          facts: [
            {
              evidenceId: {
                $signal: "research_observation",
                path: "evidenceId",
              },
              fieldPath: "model",
              value: "F17SB",
              support: {
                observation: "Example Works small fan model F17SB.",
                reasoning:
                  "The assigned Product matches this exact small model.",
              },
            },
          ],
          detail: "Only the model is supported; other facts remain gaps.",
        },
      },
    ];
    runtime = await startScenarioHarness(ctx.databaseUrl, {
      steps,
      assessments: [
        {
          match: "F17SB",
          output: {
            identityVerified: true,
            acceptedFacts: [0],
            acceptedIdentifiers: [],
            acceptedImages: [],
            acceptedOrders: [],
            acceptedEmailLinks: [],
            rejected: [],
          },
        },
      ],
    });
    await runtime.dispatch(f.event);
    await waitFor(
      async () =>
        (await runtime?.emitted())?.includes("await:research_observation") ??
        false,
      "Current researcher never waited for its queued browser observation",
    );
    const [operation] = await getDb(ctx.db)
      .select()
      .from(runOperation)
      .where(
        and(
          eq(runOperation.runId, f.saved.id),
          eq(runOperation.kind, "browser_command"),
        ),
      );
    if (!operation) throw new Error("Current browser command was not recorded");
    const command = browserCommandRecord.parse(operation.result);
    expect(command).toMatchObject({
      brokerAccountId: f.account.id,
      command: {
        runID: f.saved.id,
        operation: { type: "navigate", url: pageURL },
      },
    });
    const peer = runtime.harness.getWorker("cubby-queue-producer");
    const post = async (endpoint: string, body: string) => {
      const response = await peer.fetch(
        new URL(endpoint, "https://queue.test"),
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        },
      );
      expect({ status: response.status, ok: response.ok }).toMatchObject({
        ok: true,
      });
      return response;
    };
    const readBroker = async () =>
      brokerState.parse(
        await (
          await post(
            "/broker-state",
            JSON.stringify({
              vendorAccountId: f.account?.id,
              runId: f.saved.id,
              commandId: command.commandId,
            }),
          )
        ).json(),
      );
    browserBoundary = { before: await readBroker(), replayReceipts: [] };
    expect(browserBoundary.before).toMatchObject({
      connected: false,
      result: null,
      pending: [{ requestId: command.commandId }],
    });
    const cancelled = await controlRun(ctx.db, ctx.actor, {
      runPublicId: f.saved.shortcode,
      action: "cancel",
    });
    expect(cancelled).toMatchObject({
      status: "failed",
      cancelledBrowserCommandIds: [command.commandId],
    });
    const readState = async () => ({
      run: await getDb(ctx.db).select().from(run).where(eq(run.id, f.saved.id)),
      targets: await getDb(ctx.db)
        .select()
        .from(runTarget)
        .where(eq(runTarget.runId, f.saved.id)),
      product: await getDb(ctx.db)
        .select()
        .from(product)
        .where(eq(product.id, f.item.entityId)),
      purchases: await getDb(ctx.db).select().from(purchase),
      expenses: await getDb(ctx.db).select().from(expense),
      stock: await getDb(ctx.db).select().from(inventoryEntry),
      facts: await factsForRun(f.saved.id),
      evidence: await getDb(ctx.db)
        .select()
        .from(runEvidence)
        .where(eq(runEvidence.runId, f.saved.id)),
      operations: await getDb(ctx.db)
        .select()
        .from(runOperation)
        .where(eq(runOperation.runId, f.saved.id)),
    });
    const before = await readState();
    expect(before.run).toMatchObject([
      { status: "failed", failureCode: "user_cancelled" },
    ]);
    expect(before.product).toMatchObject([{ model: "" }]);
    expect(before.evidence).toEqual([]);
    expect(before.facts).toEqual([]);
    const emittedBefore = await runtime.emitted();
    await runtime.connectBrowser({
      vendorAccountId: f.account.id,
      ledgerPartyId: f.member.id,
      userId: ctx.actor.userId,
      outcomes: {
        [pageURL]: await completedCapture(pageURL, {
          title: "Example Works small fan",
          text: "Example Works small fan. Model F17SB. Selected variant: small, blue.",
        }),
      },
    });
    await waitFor(
      async () => (await readBroker()).result !== null,
      "Actual broker never stored the late completed result",
    );
    const completed = await readBroker();
    browserBoundary.completed = completed;
    expect(completed).toMatchObject({
      pending: [],
      result: {
        commandID: command.commandId,
        operationID: command.command.operationId,
        runID: f.saved.id,
        outcome: { status: "completed" },
      },
    });
    const event: PurchaseAgentEvent = {
      version: 1,
      type: "browser_result",
      runId: f.saved.id,
      eventId: `browser-result:${command.commandId}`,
      commandId: command.commandId,
    };
    // A synchronous replay of the broker's actual event proves the host fence
    // consumed it; queue publication alone is not a consumption receipt.
    for (let delivery = 0; delivery < 2; delivery++) {
      const response = await post(
        "/coordinator-dispatch",
        JSON.stringify({
          agentId: importRunAgentIdentity(f.saved.id, "product_enrichment"),
          purpose: "product_enrichment",
          event,
        }),
      );
      const receipt = coordinatorReceipt.parse(await response.json());
      browserBoundary.replayReceipts.push(receipt);
    }
    expect(await readState()).toEqual(before);
    expect(await runtime.emitted()).toEqual(emittedBefore);
    expect(await runtime.gatewayCalls()).toEqual([]);
    expect(await runtime.violations()).toEqual([]);
    boundaries.push(
      {
        name: "actual-pending-broker-completed-after-public-cancel",
        passed: true,
      },
      {
        name: "late-and-replayed-event-no-model-write-or-revival",
        passed: true,
      },
    );
    status = "passed";
  }, 40_000);
});
