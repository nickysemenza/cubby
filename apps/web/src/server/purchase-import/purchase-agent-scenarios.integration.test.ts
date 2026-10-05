/* eslint-disable anti-slop/no-unsafe-dictionary-type -- Browser outcomes and extractor outputs are external wire payloads. */
import { parseEntityId, runEntityId } from "@cubby/schemas/identifiers";
import { chargeRunStartInput } from "@cubby/schemas/order-mail-review";
import { and, eq, inArray } from "drizzle-orm";
import {
  awaitBrowserResult,
  awaitEvent,
  call,
  from,
  mcp,
  mcpRead,
  type ScriptStep,
} from "tooling/purchase-agent-script";
import {
  HOLD_WORKERD_HARNESS_TIMEOUT_MS,
  holdWorkerdHarness,
} from "tooling/purchase-agent-workerd-harness";
import { type TestDbContext, withTestDb } from "tooling/test-setup";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  aiUsage,
  auditLog,
  entityAttachment,
  expense,
  financialTransaction,
  financialTransactionAllocation,
  image,
  importSourceClaim,
  inventoryEntry,
  merchantVendorRule,
  oauthRefreshToken,
  orderMail,
  orderMailEvent,
  photoGroupProposal,
  product,
  purchase,
  purchasePaymentEvidence,
  run as runTable,
  runApproval,
  runFinding,
  runOperation,
  runOrderCandidate,
  runProgress,
  runTarget,
} from "~/server/db/schema";
import { approvePhotoGroupProposals } from "~/server/photo-import-run/proposals";
import { getDb, withTransaction } from "~/server/repo/database-helpers";
import {
  createImageFixture,
  createProductFixture,
  makeProductInput,
} from "~/server/repo/repo.fixtures";
import { getRunLiveProgress } from "~/server/repo/run-progress";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

import { startSelectedChargeRun } from "./charge-runs";
import { learnPurchaseProductExternalId } from "./external-id-learning";
import {
  startOrderMailImport,
  startSelectedOrderMailImport,
} from "./gmail/import";
import { discoverImportHunts } from "./hunts";
import {
  authorizePurchaseAgent,
  mailCommit,
  mailPrepare,
  readyExtraction,
  type ScenarioHarness,
  startScenarioHarness,
  waitFor,
  workerdDiagnostic,
} from "./purchase-agent-workerd.fixtures";
import {
  approvalWakeEvent,
  controlRun,
  startOrResumeRun,
  startPhotoInventoryCoordinator,
  startPhotoInventoryRun,
  startTargetedRun,
} from "./run-service";

// Each scenario drives the production import-run agent, its tools, the MCP server,
// queue delivery, the browser broker, and the web Worker's writers end to
// end. Only the coordinator model and the web Worker's extractor/audit model
// are scripted, so these prove orchestration and server fences — never model
// judgment (see purchase-decision-eval.live-eval.ts for that).

const SHOP_HOST = "shop.example.test";
const PANTRY_SKU = "OATS-1KG";
const orderUrl = (orderId: string) =>
  `https://${SHOP_HOST}/order-details?orderId=${orderId}`;

const capturedOrder = (orderId: string, readableText: string) => ({
  status: "completed",
  capture: {
    sourceURL: orderUrl(orderId),
    title: `Order ${orderId}`,
    capturedAt: "2026-09-25T12:00:00.000Z",
    captureVersion: 1,
    readableText,
    links: [],
    images: [],
    paymentEvidence: [],
    evidence: [],
    variantMarkers: [],
  },
});

const unreadableExtraction = (detail: string) => ({
  status: "unreadable",
  candidate: null,
  reason: null,
  detail,
});

async function protectedBusinessSnapshot(
  db: TestDbContext["db"],
  input: {
    purchaseId: typeof purchase.$inferSelect.id;
    productId: typeof product.$inferSelect.id;
  },
) {
  const database = getDb(db);
  const values = await Promise.all([
    database.select().from(purchase).where(eq(purchase.id, input.purchaseId)),
    database
      .select()
      .from(expense)
      .where(eq(expense.purchaseId, input.purchaseId)),
    database.select().from(product).where(eq(product.id, input.productId)),
    database.select().from(image),
    database
      .select()
      .from(entityAttachment)
      .where(eq(entityAttachment.entityId, input.purchaseId)),
    database
      .select()
      .from(entityAttachment)
      .where(eq(entityAttachment.entityId, input.productId)),
    database.select().from(importSourceClaim),
    database.select().from(purchasePaymentEvidence),
    database.select().from(financialTransaction),
    database.select().from(financialTransactionAllocation),
    database.select().from(auditLog),
  ]);
  return JSON.stringify(values);
}

let scenario: ScenarioHarness | undefined;
let scenarioRunId: string | undefined;

describe("purchase-agent scripted scenarios", () => {
  const ctx = withTestDb();
  let releaseHarness: (() => void) | undefined;
  beforeAll(async () => {
    releaseHarness = await holdWorkerdHarness();
  }, HOLD_WORKERD_HARNESS_TIMEOUT_MS);
  afterAll(() => releaseHarness?.());

  afterEach(async ({ task }) => {
    // A failed scenario prints what the model was told to do, what the server
    // recorded, and the runtime logs: the evidence a rerun would rediscover.
    if (task.result?.state === "fail" && scenario && scenarioRunId)
      console.error(
        `[scenario] ${task.name}\nemitted=${JSON.stringify(await scenario.emitted())}\nviolations=${JSON.stringify(await scenario.violations())}\ngateway=${JSON.stringify(await scenario.gatewayCalls())}\n${await workerdDiagnostic(ctx.db, scenarioRunId, scenario.harness)}`,
      );
    await scenario?.close();
    scenario = undefined;
    scenarioRunId = undefined;
  });

  const waitForRun = async (
    runId: string,
    predicate: () => Promise<boolean>,
    message: string,
    timeoutMs = 20_000,
  ) => {
    try {
      await waitFor(predicate, message, timeoutMs);
    } catch (error) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\nemitted=${JSON.stringify(await scenario?.emitted())}\nviolations=${JSON.stringify(await scenario?.violations())}\ngateway=${JSON.stringify(await scenario?.gatewayCalls())}\n${await workerdDiagnostic(ctx.db, runId, scenario?.harness)}`,
        { cause: error },
      );
    }
  };

  const runRow = async (runId: string) => {
    const [row] = await getDb(ctx.db)
      .select({
        status: runTable.status,
        failureCode: runTable.failureCode,
      })
      .from(runTable)
      .where(eq(runTable.id, runEntityId.parse(runId)));
    if (!row) throw new Error("Scenario run disappeared");
    return row;
  };

  const waitForStatus = (runId: string, status: string) =>
    waitForRun(
      runId,
      async () => (await runRow(runId)).status === status,
      `Run never reached ${status}`,
    );

  const waitForEmitted = (runId: string, entry: string) =>
    waitForRun(
      runId,
      async () => (await scenario?.emitted())?.includes(entry) ?? false,
      `Scripted model never reached ${entry}`,
    );

  /** Nothing the harness can observe changes for a bounded quiet window. */
  const expectQuiet = async (observe: () => Promise<object>) => {
    const before = JSON.stringify(await observe());
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      expect(JSON.stringify(await observe())).toBe(before);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };

  const findings = (runId: string) =>
    getDb(ctx.db)
      .select({ summary: runFinding.summary, status: runFinding.status })
      .from(runFinding)
      .where(eq(runFinding.runId, runId));

  const purchaseGraph = async (
    vendorId: typeof purchase.$inferSelect.vendorId,
  ) => {
    const purchases = await getDb(ctx.db)
      .select({
        id: purchase.id,
        shortcode: purchase.shortcode,
        orderId: purchase.orderId,
      })
      .from(purchase)
      .where(eq(purchase.vendorId, vendorId));
    const expenses = purchases.length
      ? await getDb(ctx.db)
          .select({
            purchaseId: expense.purchaseId,
            cost: expense.cost,
            lineKind: expense.lineKind,
            productId: expense.productId,
          })
          .from(expense)
          .where(
            inArray(
              expense.purchaseId,
              purchases.map(({ id }) => id),
            ),
          )
      : [];
    const claims = purchases.length
      ? await getDb(ctx.db)
          .select({ id: importSourceClaim.id })
          .from(importSourceClaim)
          .where(
            inArray(
              importSourceClaim.purchaseId,
              purchases.map(({ id }) => id),
            ),
          )
      : [];
    const inventory = await getDb(ctx.db)
      .select({ id: inventoryEntry.id })
      .from(inventoryEntry);
    return { purchases, expenses, claims, inventory };
  };

  /** One member, one browser-synced account, and a recorded order listing. */
  const seedAccountSync = async (
    orders: Array<{ orderId: string; orderedAt: string }>,
  ) => {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Scenario member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    // No website or saved hints: once the listing is worked, claim reports
    // `none` instead of walking more history.
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: `Scenario garden shop ${crypto.randomUUID()}`,
      browserDomains: [SHOP_HOST],
    });
    const account = await insertWithShortcode(ctx.db, "vendorAccount", {
      label: "Scenario shop account",
      vendorId: vendor.id,
      ledgerPartyId: party.id,
      browserSyncEnabled: true,
    });
    const run = await startOrResumeRun(ctx.db, {
      ledgerPartyId: party.id,
      vendorAccountId: account.id,
      trigger: "manual",
    });
    if (!run.dispatchEventId) throw new Error("Run has no dispatch generation");
    scenarioRunId = run.id;
    if (orders.length > 0)
      await getDb(ctx.db)
        .insert(runOrderCandidate)
        .values(
          orders.map((order) => ({
            runId: run.id,
            orderId: order.orderId,
            orderUrl: orderUrl(order.orderId),
            orderedAt: order.orderedAt,
            state: "pending",
          })),
        );
    await authorizePurchaseAgent(ctx.db, ctx.actor.userId);
    // A product this vendor already sold the household, by its exact SKU.
    // It is deliberately not food, so no Project trade is inherited: the
    // principal line's trade comes from the import call's defaultTrade, as it
    // does for purchase_import.commit.
    const pantry = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Scenario rolled oats, 1 kg" }),
      ctx.actor,
    );
    await withTransaction(ctx.db, (tx) =>
      learnPurchaseProductExternalId(tx, {
        productId: pantry.entityId,
        source: `vendor-${vendor.id}`,
        kind: "retailer_sku",
        externalId: PANTRY_SKU,
      }),
    );
    const start = {
      version: 1,
      type: "start_or_resume",
      runId: run.id,
      eventId: run.dispatchEventId,
    };
    const browser = {
      vendorAccountId: account.id,
      ledgerPartyId: party.id,
      userId: ctx.actor.userId,
    };
    return {
      party,
      vendor,
      account,
      run,
      start,
      browser,
      pantryProductId: pantry.entityId,
    };
  };

  /** claim → capture → (pause offline) → claim on connect → import. */
  const captureAndImport = (orderId: string, suffix: string): ScriptStep[] => [
    call(`claim-${suffix}`, "claim_next_import_work"),
    { check: `claim-${suffix}`, includes: orderId },
    call(`browser-${suffix}`, "issue_browser_command", {
      command: { kind: "capture_order", target: orderUrl(orderId) },
    }),
    awaitBrowserResult(`browser-${suffix}`),
    call(`import-${suffix}`, "import_browser_order_evidence", {
      commandId: from(`browser-${suffix}`, "commandId"),
      defaultTrade: "other",
    }),
  ];

  /** The first command pauses offline; the browser connects afterwards. */
  const firstCapture = (orderId: string): ScriptStep[] => [
    call("claim-1", "claim_next_import_work"),
    { check: "claim-1", includes: orderId },
    call("browser-1", "issue_browser_command", {
      command: { kind: "capture_order", target: orderUrl(orderId) },
    }),
    awaitEvent("browser_connected", "browser_result"),
    // The connect event resumes a `paused_offline` run through claim.
    call("claim-resume", "claim_next_import_work"),
    awaitBrowserResult("browser-1"),
    call("import-1", "import_browser_order_evidence", {
      commandId: from("browser-1", "commandId"),
      defaultTrade: "other",
    }),
  ];

  const settlementRead = (id: string) =>
    mcpRead(id, "finance_read", { action: "statement_rows" });

  const connectAfterPause = async (
    seeded: Awaited<ReturnType<typeof seedAccountSync>>,
    outcomes: Record<string, unknown>,
    delayMs?: number,
  ) => {
    await waitForStatus(seeded.run.id, "paused_offline");
    await scenario?.connectBrowser({ ...seeded.browser, outcomes, delayMs });
  };

  it("account sync: captures one order through the browser broker, imports it, verifies settlement, and completes", async () => {
    const seeded = await seedAccountSync([
      { orderId: "SCN10001", orderedAt: "2026-09-20" },
    ]);
    scenario = await startScenarioHarness(ctx.databaseUrl, {
      steps: [
        ...firstCapture("SCN10001"),
        { check: "import-1", includes: "SCN10001" },
        settlementRead("settlement-1"),
        call("claim-done", "claim_next_import_work"),
        { check: "claim-done", includes: "none" },
        call("finish-1", "finish_import_run"),
      ],
      extractions: [
        {
          match: "SCN10001",
          output: readyExtraction("SCN10001", "2026-09-20T12:00:00.000Z", [
            {
              title: "Scenario rolled oats, 1 kg",
              amount: 12,
              lineKind: "principal",
              sku: PANTRY_SKU,
            },
            { title: "Sales tax", amount: 1, lineKind: "tax" },
          ]),
        },
      ],
    });
    await scenario.dispatch(seeded.start);
    await connectAfterPause(seeded, {
      [orderUrl("SCN10001")]: capturedOrder(
        "SCN10001",
        "Order SCN10001 placed September 20, 2026. Scenario rolled oats, 1 kg (SKU OATS-1KG) $12.00. Sales tax $1.00. Order total $13.00.",
      ),
    });
    await waitForStatus(seeded.run.id, "completed");

    const graph = await purchaseGraph(seeded.vendor.id);
    expect(graph.purchases).toMatchObject([{ orderId: "SCN10001" }]);
    expect(
      graph.expenses
        .map(({ cost, lineKind, productId }) => [lineKind, cost, productId])
        .sort(),
    ).toEqual([
      ["principal", 12, seeded.pantryProductId],
      ["tax", 1, null],
    ]);
    expect(graph.claims).toHaveLength(1);
    expect(graph.inventory).toEqual([]);
    expect(
      await getDb(ctx.db)
        .select({ state: runOrderCandidate.state })
        .from(runOrderCandidate)
        .where(eq(runOrderCandidate.runId, seeded.run.id)),
    ).toEqual([{ state: "imported" }]);
    expect(
      (await findings(seeded.run.id)).filter((f) => f.status === "open"),
    ).toEqual([]);
    expect(await scenario.gatewayCalls()).toEqual(
      expect.arrayContaining([
        { feature: "purchase-import-extraction", matched: "SCN10001" },
        { feature: "purchase-import-audit", matched: "audit" },
      ]),
    );
    expect(await scenario.violations()).toEqual([]);

    // Redelivery: the same start event is fenced by its acknowledged
    // generation and the same browser result by the agent's idempotency key, so
    // neither reaches the model or writes again.
    const emittedBefore = await scenario.emitted();
    const [command] = await getDb(ctx.db)
      .select({ result: runOperation.result })
      .from(runOperation)
      .where(
        and(
          eq(runOperation.runId, seeded.run.id),
          eq(runOperation.kind, "browser_command"),
        ),
      );
    const { commandId } = z
      .object({ commandId: z.uuid() })
      .parse(command?.result);
    await scenario.dispatch(seeded.start);
    await scenario.dispatch({
      version: 1,
      type: "browser_result",
      runId: seeded.run.id,
      eventId: `browser-result:${commandId}`,
      commandId,
    });
    await expectQuiet(async () => [
      await scenario?.emitted(),
      await purchaseGraph(seeded.vendor.id),
      (await runRow(seeded.run.id)).status,
    ]);
    expect(await scenario.emitted()).toEqual(emittedBefore);
  }, 90_000);

  it("account sync: imports the first of two orders exactly once, defers the unreadable second, and ends in review naming it", async () => {
    const seeded = await seedAccountSync([
      { orderId: "SCN20001", orderedAt: "2026-09-22" },
      { orderId: "SCN20002", orderedAt: "2026-09-21" },
    ]);
    scenario = await startScenarioHarness(ctx.databaseUrl, {
      steps: [
        ...firstCapture("SCN20001"),
        // Replay the same evidence under a new operation id, as a crashed
        // and resumed coordinator would: the source claim must hold.
        call("import-1-replay", "import_browser_order_evidence", {
          commandId: from("browser-1", "commandId"),
          defaultTrade: "other",
        }),
        settlementRead("settlement-1"),
        ...captureAndImport("SCN20002", "2"),
        { check: "import-2", includes: "unreadable" },
        call("defer-2", "defer_order_for_review", {
          orderId: "SCN20002",
          detail: "The order detail page stayed unreadable after capture.",
        }),
        call("claim-done", "claim_next_import_work"),
        { check: "claim-done", includes: "none" },
        call("finish-1", "finish_import_run"),
      ],
      extractions: [
        {
          match: "SCN20001",
          output: readyExtraction("SCN20001", "2026-09-22T12:00:00.000Z", [
            {
              title: "Scenario rolled oats, 1 kg",
              amount: 8.5,
              lineKind: "principal",
              sku: PANTRY_SKU,
            },
            { title: "Shipping", amount: 1.5, lineKind: "shipping" },
          ]),
        },
        {
          match: "SCN20002",
          output: unreadableExtraction(
            "The capture shows a loading placeholder instead of order lines.",
          ),
        },
      ],
    });
    await scenario.dispatch(seeded.start);
    await connectAfterPause(
      seeded,
      {
        [orderUrl("SCN20001")]: capturedOrder(
          "SCN20001",
          "Order SCN20001 placed September 22, 2026. Scenario rolled oats, 1 kg (SKU OATS-1KG) $8.50. Shipping $1.50. Order total $10.00.",
        ),
        [orderUrl("SCN20002")]: capturedOrder(
          "SCN20002",
          "Order SCN20002. Loading order details…",
        ),
      },
      // No capture delay: the browser may answer before the submission that
      // issued the command settles, and the run must keep working.
    );
    await waitForStatus(seeded.run.id, "needs_review");

    const graph = await purchaseGraph(seeded.vendor.id);
    expect(graph.purchases).toMatchObject([{ orderId: "SCN20001" }]);
    expect(
      graph.expenses
        .map(({ cost, lineKind, productId }) => [lineKind, cost, productId])
        .sort(),
    ).toEqual([
      ["principal", 8.5, seeded.pantryProductId],
      ["shipping", 1.5, null],
    ]);
    expect(graph.claims).toHaveLength(1);
    expect(graph.inventory).toEqual([]);
    const open = (await findings(seeded.run.id)).filter(
      (f) => f.status === "open",
    );
    expect(open).toHaveLength(1);
    expect(open[0]?.summary).toContain("SCN20002");
    expect(
      (
        await getDb(ctx.db)
          .select({
            orderId: runOrderCandidate.orderId,
            state: runOrderCandidate.state,
          })
          .from(runOrderCandidate)
          .where(eq(runOrderCandidate.runId, seeded.run.id))
      ).sort((a, b) => a.orderId.localeCompare(b.orderId)),
    ).toEqual([
      { orderId: "SCN20001", state: "imported" },
      { orderId: "SCN20002", state: "skipped" },
    ]);
    expect(await scenario.violations()).toEqual([]);
  }, 90_000);

  it("approval: a generic mutation pauses, a grant replays it exactly once after the member continues, and a rejection never writes", async () => {
    const seeded = await seedAccountSync([]);
    const target = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Scenario watering can" }),
      ctx.actor,
    );
    const [targetRow] = await getDb(ctx.db)
      .select({ shortcode: product.shortcode })
      .from(product)
      .where(eq(product.id, target.entityId));
    if (!targetRow) throw new Error("Expected scenario Product");
    const note = (id: string, notes: string) =>
      mcp(
        id,
        "entity",
        seeded.run.id,
        {
          action: "update",
          entity: "product",
          id: targetRow.shortcode,
          data: { notes },
        },
        { operationId: id.replace(/-(?:propose|replay)$/u, "") },
      );
    const awaitApproval = (id: string) =>
      call(id, "report_agent_progress", {
        phase: "awaiting_approval",
        awaitingApproval: true,
        detail: "A Product note needs member approval.",
      });
    scenario = await startScenarioHarness(ctx.databaseUrl, {
      steps: [
        call("claim-1", "claim_next_import_work"),
        note("note-granted-propose", "Granted scenario note"),
        awaitApproval("await-granted"),
        { await: [":approved"] },
        note("note-granted-replay", "Granted scenario note"),
        note("note-rejected-propose", "Rejected scenario note"),
        awaitApproval("await-rejected"),
        { await: [":rejected"] },
        call("finish-1", "finish_import_run"),
      ],
    });
    await scenario.dispatch(seeded.start);
    await waitForStatus(seeded.run.id, "paused_approval");
    await waitForEmitted(seeded.run.id, "await-granted");
    const approve = await controlRun(ctx.db, ctx.actor, {
      runPublicId: seeded.run.publicId,
      action: "approve",
      operationId: "note-granted",
    });
    expect(approve).toMatchObject({ decision: "approved" });
    // The decision's own wake event resumes the parked conversation; no
    // member prompt is needed (the run-control handler dispatches it).
    const approvalWake = approvalWakeEvent(approve);
    if (!approvalWake) throw new Error("A grant must wake the coordinator");
    await scenario.dispatch(approvalWake);
    await waitForEmitted(seeded.run.id, "await-rejected");
    await waitForStatus(seeded.run.id, "paused_approval");
    // Reject immediately: a settle event from the parked submission that
    // lands after the decision must not move the run to review.
    const reject = await controlRun(ctx.db, ctx.actor, {
      runPublicId: seeded.run.publicId,
      action: "reject",
      operationId: "note-rejected",
    });
    expect((await runRow(seeded.run.id)).status).toBe("running");
    const rejectionWake = approvalWakeEvent(reject);
    if (!rejectionWake)
      throw new Error("A rejection must wake the coordinator");
    await scenario.dispatch(rejectionWake);
    await waitForStatus(seeded.run.id, "completed");

    const [updated] = await getDb(ctx.db)
      .select({ notes: product.notes })
      .from(product)
      .where(eq(product.id, target.entityId));
    expect(updated?.notes).toBe("Granted scenario note");
    expect(
      (
        await getDb(ctx.db)
          .select({
            operationId: runApproval.operationId,
            state: runApproval.state,
          })
          .from(runApproval)
          .where(eq(runApproval.runId, seeded.run.id))
      ).sort((a, b) => a.operationId.localeCompare(b.operationId)),
    ).toEqual([
      { operationId: "note-granted", state: "consumed" },
      { operationId: "note-rejected", state: "rejected" },
    ]);
    expect(
      (
        await getDb(ctx.db)
          .select({
            operationId: runOperation.operationId,
            state: runOperation.state,
          })
          .from(runOperation)
          .where(
            and(
              eq(runOperation.runId, seeded.run.id),
              inArray(runOperation.operationId, [
                "note-granted",
                "note-rejected",
              ]),
            ),
          )
      ).sort((a, b) => a.operationId.localeCompare(b.operationId)),
    ).toEqual([
      { operationId: "note-granted", state: "completed" },
      { operationId: "note-rejected", state: "failed" },
    ]);
    expect(await scenario.violations()).toEqual([]);
  }, 90_000);

  // Regression: the pi-durable move dropped the submission-start marker the
  // settle report keyed on, so every settle was ignored and a coordinator
  // that simply stopped left its run `running` until the two-hour sweep.
  it("stall: a coordinator that stops without finishing moves the run to review once it settles", async () => {
    const seeded = await seedAccountSync([]);
    scenario = await startScenarioHarness(ctx.databaseUrl, {
      steps: [
        call("claim-1", "claim_next_import_work"),
        { await: ["scenario-event-that-never-arrives"] },
      ],
    });
    await scenario.dispatch(seeded.start);
    await waitForRun(
      seeded.run.id,
      async () => (await runRow(seeded.run.id)).status === "needs_review",
      "Run never reached needs_review",
      // Settlement is polled every ten seconds.
      40_000,
    );
    expect(await findings(seeded.run.id)).toEqual([
      {
        summary: "Coordinator ended without finishing the run",
        status: "open",
      },
    ]);
    expect(await scenario.violations()).toEqual([]);
  }, 90_000);

  it("cancellation: cancelling during a pending browser command fails the run and a late browser result writes nothing", async () => {
    const seeded = await seedAccountSync([
      { orderId: "SCN40001", orderedAt: "2026-09-23" },
    ]);
    scenario = await startScenarioHarness(ctx.databaseUrl, {
      // The script keeps going after the cancel, as a model that missed it
      // would; the server fences must refuse every step.
      steps: [
        ...firstCapture("SCN40001"),
        call("finish-1", "finish_import_run"),
      ],
      extractions: [
        {
          match: "SCN40001",
          output: readyExtraction("SCN40001", "2026-09-23T12:00:00.000Z", [
            { title: "Synthetic plant ties", amount: 4, lineKind: "principal" },
          ]),
        },
      ],
    });
    await scenario.dispatch(seeded.start);
    await waitForStatus(seeded.run.id, "paused_offline");
    const cancelled = await controlRun(ctx.db, ctx.actor, {
      runPublicId: seeded.run.publicId,
      action: "cancel",
    });
    expect(cancelled).toMatchObject({ status: "failed" });
    expect(
      "cancelledBrowserCommandIds" in cancelled
        ? cancelled.cancelledBrowserCommandIds
        : undefined,
    ).toHaveLength(1);
    // The browser was already executing: its result reaches the broker after
    // the cancellation (the route's broker cancel lost the race).
    await scenario.connectBrowser({
      ...seeded.browser,
      outcomes: {
        [orderUrl("SCN40001")]: capturedOrder(
          "SCN40001",
          "Order SCN40001 placed September 23, 2026. Synthetic plant ties $4.00. Order total $4.00.",
        ),
      },
    });
    await waitForEmitted(seeded.run.id, "script-complete");
    expect(await runRow(seeded.run.id)).toMatchObject({
      status: "failed",
      failureCode: "user_cancelled",
    });
    const graph = await purchaseGraph(seeded.vendor.id);
    expect(graph.purchases).toEqual([]);
    expect(graph.expenses).toEqual([]);
    expect(
      (await scenario.gatewayCalls()).filter(
        ({ feature }) => feature === "purchase-import-extraction",
      ),
    ).toEqual([]);
    expect(
      await getDb(ctx.db)
        .select({ state: runOrderCandidate.state })
        .from(runOrderCandidate)
        .where(eq(runOrderCandidate.runId, seeded.run.id)),
    ).toEqual([{ state: "pending" }]);
    expect(await scenario.violations()).toEqual([]);
  }, 90_000);

  /** A saved order confirmation and its browser-independent run. */
  const seedOrderMail = async (orderId: string, bodyText: string) => {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Scenario mail member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: `Scenario mail shop ${crypto.randomUUID()}`,
    });
    const [mail] = await getDb(ctx.db)
      .insert(orderMail)
      .values({
        ledgerPartyId: party.id,
        vendorId: vendor.id,
        messageId: `scenario-confirmation-${crypto.randomUUID()}`,
        sender: "orders@mail-shop.example.test",
        subject: `Order ${orderId} confirmed`,
        receivedAt: new Date("2026-09-24T12:00:00Z"),
        rawChecksum: "c".repeat(64),
        content: { snippet: null, bodyHtml: null, bodyText },
      })
      .returning();
    if (!mail) throw new Error("Missing scenario mail");
    const [event] = await getDb(ctx.db)
      .insert(orderMailEvent)
      .values({
        orderMailId: mail.id,
        event: "placed",
        orderId,
        amount: 9,
        currency: "USD",
        sourceKey: `scenario:${mail.id}`,
      })
      .returning();
    if (!event) throw new Error("Missing scenario mail event");
    const sent: Array<Record<string, unknown>> = [];
    const started = await startOrderMailImport(
      ctx.db,
      { eventId: event.id, evidenceChecksum: mail.rawChecksum },
      ctx.actor,
      { send: async (value) => void sent.push(value) },
    );
    const [run] = await getDb(ctx.db)
      .select({ id: runTable.id })
      .from(runTable)
      .where(eq(runTable.shortcode, started.runId));
    if (!run || !sent[0]) throw new Error("Mail import did not dispatch");
    scenarioRunId = run.id;
    await authorizePurchaseAgent(ctx.db, ctx.actor.userId);
    return { vendor, runId: run.id, start: sent[0] };
  };

  it("mail evidence: a confirmation with no itemization stops for review without preparing anything", async () => {
    const seeded = await seedOrderMail(
      "SCN50001",
      "Thanks for your order SCN50001! We will email you when it ships.",
    );
    scenario = await startScenarioHarness(ctx.databaseUrl, {
      steps: [
        call("claim-1", "claim_next_import_work"),
        call("extract-1", "extract_run_evidence"),
        { check: "extract-1", includes: "unreadable" },
        call("stop-1", "stop_import_run_for_review", {
          reason: "unreadable_evidence",
          detail: "The confirmation for SCN50001 lists no items or total.",
        }),
      ],
      extractions: [
        {
          match: "SCN50001",
          output: unreadableExtraction(
            "The confirmation names the order but lists no items or total.",
          ),
        },
      ],
    });
    await scenario.dispatch(seeded.start);
    await waitForStatus(seeded.runId, "needs_review");

    expect((await purchaseGraph(seeded.vendor.id)).purchases).toEqual([]);
    expect(
      await getDb(ctx.db)
        .select({ kind: runOperation.kind })
        .from(runOperation)
        .where(
          and(
            eq(runOperation.runId, seeded.runId),
            eq(runOperation.kind, "prepare_purchase_import"),
          ),
        ),
    ).toEqual([]);
    const open = (await findings(seeded.runId)).filter(
      (f) => f.status === "open",
    );
    expect(open).toHaveLength(1);
    expect(open[0]?.summary).toContain("SCN50001");
    expect(await scenario.violations()).toEqual([]);
  }, 90_000);

  // A new coordinator once checked the member's grant by listing MCP tools
  // before its first turn; it now mounts tools without listing, so the
  // preflight is an explicit `authorize` and must still run first.
  it("authorization: a new coordinator without a live grant pauses the run before any model turn or effect", async () => {
    const seeded = await seedOrderMail(
      "SCN50002",
      "Thanks for your order SCN50002! Rolled oats 1 kg, $6.50.",
    );
    await getDb(ctx.db)
      .delete(oauthRefreshToken)
      .where(eq(oauthRefreshToken.userId, ctx.actor.userId));
    scenario = await startScenarioHarness(ctx.databaseUrl, {
      steps: [call("claim-1", "claim_next_import_work")],
    });
    await scenario.dispatch(seeded.start);
    await waitForStatus(seeded.runId, "paused_auth");

    expect(await scenario.emitted()).toEqual([]);
    expect(
      await getDb(ctx.db)
        .select({ kind: runOperation.kind })
        .from(runOperation)
        .where(eq(runOperation.runId, seeded.runId)),
    ).toEqual([]);
  }, 90_000);

  it("browser evidence: an unreadable single-order capture stops the run for review with no speculative writes", async () => {
    const seeded = await seedAccountSync([
      { orderId: "SCN60001", orderedAt: "2026-09-25" },
    ]);
    scenario = await startScenarioHarness(ctx.databaseUrl, {
      steps: [
        ...firstCapture("SCN60001"),
        { check: "import-1", includes: "unreadable" },
        call("stop-1", "stop_import_run_for_review", {
          reason: "unreadable_evidence",
          detail: "Order SCN60001 rendered no readable lines.",
        }),
      ],
      extractions: [
        {
          match: "SCN60001",
          output: unreadableExtraction("Only a sign-in banner was captured."),
        },
      ],
    });
    await scenario.dispatch(seeded.start);
    await connectAfterPause(seeded, {
      [orderUrl("SCN60001")]: capturedOrder(
        "SCN60001",
        "Order SCN60001. Sign in to see your order.",
      ),
    });
    await waitForStatus(seeded.run.id, "needs_review");

    const graph = await purchaseGraph(seeded.vendor.id);
    expect(graph.purchases).toEqual([]);
    expect(graph.expenses).toEqual([]);
    const open = (await findings(seeded.run.id)).filter(
      (f) => f.status === "open",
    );
    expect(open).toHaveLength(1);
    expect(open[0]?.summary).toContain("SCN60001");
    expect(await scenario.violations()).toEqual([]);
  }, 90_000);

  it("mail evidence: one run over two selected confirmations imports the readable one, defers the unreadable one, and finishes for review", async () => {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Scenario mail member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: `Scenario mail shop ${crypto.randomUUID()}`,
    });
    const seedEvent = async (
      orderId: string,
      receivedAt: string,
      bodyText: string,
    ) => {
      const [mail] = await getDb(ctx.db)
        .insert(orderMail)
        .values({
          ledgerPartyId: party.id,
          vendorId: vendor.id,
          messageId: `scenario-confirmation-${crypto.randomUUID()}`,
          sender: "orders@mail-shop.example.test",
          subject: `Order ${orderId} confirmed`,
          receivedAt: new Date(receivedAt),
          rawChecksum: crypto.randomUUID().replaceAll("-", "").repeat(2),
          content: { snippet: null, bodyHtml: null, bodyText },
        })
        .returning();
      if (!mail) throw new Error("Missing scenario mail");
      const [event] = await getDb(ctx.db)
        .insert(orderMailEvent)
        .values({
          orderMailId: mail.id,
          event: "placed",
          orderId,
          amount: 9,
          currency: "USD",
          sourceKey: `scenario:${mail.id}`,
        })
        .returning();
      if (!event) throw new Error("Missing scenario mail event");
      return { eventId: event.id, evidenceChecksum: mail.rawChecksum };
    };
    const sent: Array<Record<string, unknown>> = [];
    const started = await startSelectedOrderMailImport(
      ctx.db,
      {
        orders: [
          await seedEvent(
            "SCN70001",
            "2026-09-24T12:00:00Z",
            "Order SCN70001. Synthetic pruning saw, SKU SAW-30, quantity 1, $9.00. Grand Total $9.00 USD.",
          ),
          await seedEvent(
            "SCN70002",
            "2026-09-25T12:00:00Z",
            "Thanks for your order SCN70002! We will email you when it ships.",
          ),
        ],
      },
      ctx.actor,
      { send: async (value) => void sent.push(value) },
    );
    const [row] = await getDb(ctx.db)
      .select({ id: runTable.id })
      .from(runTable)
      .where(eq(runTable.shortcode, started.runId));
    if (!row || !sent[0]) throw new Error("Selected mail did not dispatch");
    const runId = row.id;
    scenarioRunId = runId;
    await authorizePurchaseAgent(ctx.db, ctx.actor.userId);
    scenario = await startScenarioHarness(ctx.databaseUrl, {
      steps: [
        call("claim-1", "claim_next_import_work"),
        { check: "claim-1", includes: "SCN70001" },
        call("extract-1", "extract_run_evidence"),
        mailPrepare("extract-1", "1", runId),
        mailCommit("extract-1", "1", runId),
        // A coordinator that lost the commit response re-issues it under the
        // same operation id: the recorded result answers and nothing is
        // written again. A changed payload under that id is refused.
        mailCommit("extract-1", "1", runId, "commit-1-replay"),
        { check: "commit-1-replay", includes: "findingCount" },
        mcp(
          "commit-1-changed",
          "purchase_import",
          runId,
          {
            action: "commit",
            prepareOperationId: "prepare-1",
            defaultTrade: "other",
            resolutions: [],
          },
          { operationId: "commit-1" },
        ),
        {
          check: "commit-1-changed",
          includes: "Operation id was replayed with different input",
        },
        settlementRead("settlement-1"),
        call("claim-2", "claim_next_import_work"),
        { check: "claim-2", includes: "SCN70002" },
        call("extract-2", "extract_run_evidence"),
        { check: "extract-2", includes: "unreadable" },
        call("defer-2", "defer_order_for_review", {
          orderId: "SCN70002",
          detail: "The confirmation names the order but lists no items.",
        }),
        call("claim-done", "claim_next_import_work"),
        { check: "claim-done", includes: "none" },
        call("finish-1", "finish_import_run"),
      ],
      extractions: [
        {
          match: "SCN70001",
          output: readyExtraction("SCN70001", "2026-09-24T12:00:00.000Z", [
            {
              title: "Synthetic pruning saw",
              amount: 9,
              lineKind: "principal",
              sku: "SAW-30",
            },
          ]),
        },
        {
          match: "SCN70002",
          output: unreadableExtraction(
            "The confirmation names the order but lists no items or total.",
          ),
        },
      ],
    });
    await scenario.dispatch(sent[0]);
    await waitForStatus(runId, "needs_review");

    const graph = await purchaseGraph(vendor.id);
    expect(graph.purchases).toMatchObject([{ orderId: "SCN70001" }]);
    expect(graph.expenses).toHaveLength(1);
    // The refused payload left the recorded commit as it was.
    expect(
      await getDb(ctx.db)
        .select({ state: runOperation.state, error: runOperation.error })
        .from(runOperation)
        .where(
          and(
            eq(runOperation.runId, runId),
            eq(runOperation.operationId, "commit-1"),
          ),
        ),
    ).toEqual([{ state: "completed", error: null }]);
    expect(
      await getDb(ctx.db)
        .select({
          orderId: runOrderCandidate.orderId,
          state: runOrderCandidate.state,
        })
        .from(runOrderCandidate)
        .where(eq(runOrderCandidate.runId, runId))
        .orderBy(runOrderCandidate.orderId),
    ).toEqual([
      { orderId: "SCN70001", state: "imported" },
      { orderId: "SCN70002", state: "skipped" },
    ]);
    expect(
      (await findings(runId)).filter((f) => f.status === "open"),
    ).toMatchObject([{ summary: expect.stringContaining("SCN70002") }]);
    expect(await scenario.violations()).toEqual([]);
  }, 90_000);

  it("charge search: one run over three selected charges settles one, records one as not found and one for review, and finishes for review", async () => {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Scenario charge member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const card = await insertWithShortcode(ctx.db, "financialAccount", {
      name: "Scenario card",
      identity: { kind: "credit_card", issuer: null, network: "visa" },
      ledgerPartyId: party.id,
    });
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: `Scenario charge shop ${crypto.randomUUID()}`,
      website: `https://${SHOP_HOST}/orders`,
      browserDomains: [SHOP_HOST],
      orderEvidence: "online_account",
    });
    await getDb(ctx.db).insert(merchantVendorRule).values({
      ledgerPartyId: party.id,
      normalizedMerchant: "scenario charge shop",
      vendorId: vendor.id,
      confirmedByUserId: ctx.actor.userId,
    });
    const account = await insertWithShortcode(ctx.db, "vendorAccount", {
      label: "Scenario charge account",
      vendorId: vendor.id,
      ledgerPartyId: party.id,
    });
    const charge = (amount: number, date: string) =>
      insertWithShortcode(ctx.db, "financialTransaction", {
        accountId: card.id,
        kind: "purchase",
        status: "posted",
        amount,
        merchant: "SCENARIO CHARGE SHOP",
        transactionDate: date,
        postedDate: date,
      });
    const [a, b, c] = [
      await charge(11, "2026-09-01"),
      await charge(22, "2026-09-02"),
      await charge(33, "2026-09-03"),
    ];
    await discoverImportHunts(ctx.db);
    const sent: Array<Record<string, unknown>> = [];
    const started = await startSelectedChargeRun(
      ctx.db,
      chargeRunStartInput.parse({
        vendorAccountId: account.shortcode,
        transactionIds: [a.shortcode, b.shortcode, c.shortcode],
      }),
      ctx.actor,
      { send: async (value) => void sent.push(value) },
    );
    const [row] = await getDb(ctx.db)
      .select({ id: runTable.id })
      .from(runTable)
      .where(eq(runTable.shortcode, started.runId));
    if (!row || !sent[0]) throw new Error("Selected charges did not dispatch");
    const runId = row.id;
    scenarioRunId = runId;
    // Another path settles the newest charge before the agent reaches it.
    const settled = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
      vendorAccountId: account.id,
      date: "2026-09-03",
      displayLabel: "Settled elsewhere",
    });
    await getDb(ctx.db)
      .insert(financialTransactionAllocation)
      .values({ transactionId: c.id, purchaseId: settled.id, amount: 33 });
    await authorizePurchaseAgent(ctx.db, ctx.actor.userId);
    scenario = await startScenarioHarness(ctx.databaseUrl, {
      steps: [
        call("claim-1", "claim_next_import_work"),
        { check: "claim-1", includes: "hunt" },
        call("settle-1", "settle_charge_hunt", {
          huntId: from("claim-1", "id"),
          outcome: "not_found",
          detail: "No order near this amount in the vendor history.",
        }),
        call("claim-2", "claim_next_import_work"),
        { check: "claim-2", includes: "hunt" },
        call("settle-2", "settle_charge_hunt", {
          huntId: from("claim-2", "id"),
          outcome: "needs_review",
          detail: "Two orders fit this amount and date.",
        }),
        call("claim-done", "claim_next_import_work"),
        { check: "claim-done", includes: "none" },
        call("finish-1", "finish_import_run"),
      ],
      extractions: [],
    });
    await scenario.dispatch(sent[0]);
    await waitForStatus(runId, "needs_review");

    const progress = await getRunLiveProgress(ctx.db, started.runId);
    expect(progress?.charges).toEqual([
      { chargeId: a.shortcode, outcome: "not_found" },
      { chargeId: b.shortcode, outcome: "deferred" },
      { chargeId: c.shortcode, outcome: "resolved" },
    ]);
    expect(
      (await findings(runId)).filter((f) => f.status === "open"),
    ).toMatchObject([{ summary: expect.stringContaining(b.shortcode) }]);
    expect(await scenario.violations()).toEqual([]);
  }, 90_000);

  it("photo inventory: dispatches through the agent and MCP, waits for review, then commits only on approval", async () => {
    await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic wardrobe member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const run = await startPhotoInventoryRun(ctx.db, {
      actorUserId: ctx.actor.userId,
    });
    const imageFixture = await createImageFixture(
      ctx.db,
      `synthetic-wardrobe-${crypto.randomUUID()}`,
    );
    await getDb(ctx.db)
      .insert(runTarget)
      .values({
        runId: runEntityId.parse(run.id),
        entityKind: "image",
        entityId: parseEntityId("image", imageFixture.id),
        position: 0,
        state: "pending",
        targetFingerprint: `synthetic-${crypto.randomUUID()}`,
      });
    const started = await startPhotoInventoryCoordinator(ctx.db, {
      publicId: run.publicId,
      actorUserId: ctx.actor.userId,
    });
    expect(started.created).toBe(true);
    expect(
      (
        await startPhotoInventoryCoordinator(ctx.db, {
          publicId: run.publicId,
          actorUserId: ctx.actor.userId,
        })
      ).eventId,
    ).toBe(started.eventId);

    await authorizePurchaseAgent(ctx.db, ctx.actor.userId);
    const productName = `Synthetic wardrobe item ${crypto.randomUUID()}`;
    scenario = await startScenarioHarness(ctx.databaseUrl, {
      steps: [
        call("photo-claim", "claim_next_import_work"),
        mcp("photo-propose", "photo_run", run.id, {
          action: "propose_groups",
          runId: run.publicId,
          groups: [
            {
              groupKey: "synthetic-wardrobe-item",
              images: [{ id: imageFixture.shortcode, purpose: "item" }],
              product: { kind: "create", create: { name: productName } },
              evidence:
                "Synthetic item photo; review the proposed identity before creating a Product.",
            },
          ],
        }),
        mcpRead("photo-list", "imports_read", {
          action: "photo_proposals",
          runId: run.publicId,
        }),
        call("photo-await", "report_agent_progress", {
          phase: "awaiting_approval",
          awaitingApproval: true,
          detail: "One synthetic item is ready for review",
        }),
      ],
    });
    await scenario.dispatch({
      version: 1,
      type: "start_or_resume",
      runId: run.id,
      // The persisted run, not a stale queue hint, selects the agent workflow.
      purpose: "account_sync",
      eventId: started.eventId,
    });
    await waitForRun(
      run.id,
      async () => {
        const [proposal, progress, startedProgress, usage] = await Promise.all([
          getDb(ctx.db)
            .select({ state: photoGroupProposal.state })
            .from(photoGroupProposal)
            .where(eq(photoGroupProposal.runId, run.id))
            .limit(1),
          getDb(ctx.db)
            .select({ phase: runProgress.phase })
            .from(runProgress)
            .where(
              and(
                eq(runProgress.runId, run.id),
                eq(runProgress.phase, "awaiting_approval"),
              ),
            )
            .limit(1),
          getDb(ctx.db)
            .select({ id: runProgress.id })
            .from(runProgress)
            .where(
              and(
                eq(runProgress.runId, run.id),
                eq(runProgress.detail, "Coordinator started"),
              ),
            )
            .limit(1),
          getDb(ctx.db)
            .select({ id: aiUsage.id })
            .from(aiUsage)
            .where(eq(aiUsage.runId, run.id))
            .limit(1),
        ]);
        return (
          proposal[0]?.state === "proposed" &&
          progress.length === 1 &&
          startedProgress.length === 1 &&
          usage.length === 1
        );
      },
      "Photo agent did not propose a group and wait for approval",
    );
    expect(
      await getDb(ctx.db)
        .select({ id: product.id })
        .from(product)
        .where(eq(product.name, productName)),
    ).toHaveLength(0);
    const [waitingRun] = await getDb(ctx.db)
      .select({ status: runTable.status })
      .from(runTable)
      .where(eq(runTable.id, run.id));
    expect(waitingRun?.status).toBe("running");
    const approval = await approvePhotoGroupProposals(
      ctx.db,
      { runId: run.publicId },
      ctx.actor,
    );
    expect(approval.results[0]?.outcome).toBe("committed");
    expect(
      await getDb(ctx.db)
        .select({ id: product.id })
        .from(product)
        .where(eq(product.name, productName)),
    ).toHaveLength(1);
    const [settled] = await getDb(ctx.db)
      .select({ status: runTable.status })
      .from(runTable)
      .where(eq(runTable.id, run.id));
    expect(settled?.status).toBe("completed");
    expect(await scenario.violations()).toEqual([]);
  }, 60_000);

  it("purchase validation: fences, pauses for browser evidence, resumes, and completes without business writes", async () => {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Workerd harness member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Workerd harness vendor",
      website: "https://shop.example.test/orders",
      browserDomains: ["shop.example.test"],
    });
    const account = await insertWithShortcode(ctx.db, "vendorAccount", {
      label: "Workerd harness account",
      vendorId: vendor.id,
      ledgerPartyId: party.id,
    });
    const targetPurchase = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
      vendorAccountId: account.id,
      orderId: "ORDER-WORKERD-1",
      date: "2026-09-20",
      displayLabel: "Workerd validation target",
      statedTotal: 12.34,
    });
    const targetProduct = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Workerd validation product" }),
      ctx.actor,
    );
    const [targetProductRow] = await getDb(ctx.db)
      .select({ shortcode: product.shortcode })
      .from(product)
      .where(eq(product.id, targetProduct.entityId));
    if (!targetProductRow) throw new Error("Expected validation Product");
    await insertWithShortcode(ctx.db, "expense", {
      purchaseId: targetPurchase.id,
      name: "Workerd validation product",
      cost: 12.34,
      date: "2026-09-20",
      lineKind: "principal",
      costType: "materials",
      trade: "other",
      future: false,
      productId: targetProduct.entityId,
      productQuantity: 1,
    });
    await authorizePurchaseAgent(ctx.db, ctx.actor.userId);
    const sourceExternalKey = "workerd:ORDER-WORKERD-1";
    const evidenceChecksum = "a".repeat(64);
    const started = await startTargetedRun(ctx.db, {
      ledgerPartyId: party.id,
      purpose: "purchase_validation",
      vendorId: vendor.id,
      vendorAccountId: account.id,
      trigger: "manual",
      targets: [
        {
          kind: "purchase",
          purchaseId: targetPurchase.id,
          vendorAccountId: account.id,
          sourceKind: "browser_order",
          sourceExternalKey,
          targetFingerprint: "a".repeat(64),
          evidenceFingerprint: evidenceChecksum,
        },
      ],
    });
    if (!started.created || !started.run.dispatchEventId)
      throw new Error("Expected targeted run dispatch generation");
    const runId = started.run.id;

    const before = await protectedBusinessSnapshot(ctx.db, {
      purchaseId: targetPurchase.id,
      productId: targetProduct.entityId,
    });
    scenario = await startScenarioHarness(ctx.databaseUrl, {
      steps: [
        call("claim-initial", "claim_next_import_work"),
        call("browser-1", "issue_browser_command", {
          operationId: "capture-order",
          command: {
            kind: "capture_order",
            target: "https://shop.example.test/orders/ORDER-WORKERD-1",
          },
        }),
        awaitEvent("browser_connected", "browser_result"),
        call("claim-resume", "claim_next_import_work"),
        awaitEvent("browser_result"),
        mcp(
          "prepare:workerd",
          "purchase_import",
          runId,
          {
            action: "prepare",
            orders: [
              {
                stableOrderId: "order-workerd",
                itemOperationId: "prepare-item:workerd",
                source: {
                  kind: "browser_order",
                  externalKey: sourceExternalKey,
                  checksum: evidenceChecksum,
                },
                evidenceChecksum,
                extractionRevision: "workerd@1",
                extraction: {
                  status: "ready",
                  candidate: {
                    orderId: "ORDER-WORKERD-1",
                    orderedAt: "2026-09-20T12:00:00.000Z",
                    merchant: "Workerd harness vendor",
                    currency: "USD",
                    printedGrandTotal: 12.34,
                    lines: [
                      {
                        title: "Workerd validation product",
                        amount: 12.34,
                        lineKind: "principal",
                        quantity: 1,
                      },
                    ],
                    payments: [],
                    allShipmentsDelivered: false,
                  },
                },
                lineIds: ["order-workerd:line-1"],
                primaryDocumentImageId: null,
                screenshotImageId: null,
              },
            ],
          },
          { itemOperationIds: ["prepare-item:workerd"] },
        ),
        mcp("validate:workerd", "purchase_import", runId, {
          action: "validate",
          prepareOperationId: "prepare:workerd",
          resolutions: [
            {
              stableOrderId: "order-workerd",
              stableLineId: "order-workerd:line-1",
              resolution: {
                kind: "existing",
                productId: targetProductRow.shortcode,
              },
            },
          ],
        }),
        // An unchanged Purchase must compare as `replayed`.
        { check: "validate:workerd", includes: "replayed" },
        call("finish-1", "finish_import_run", {
          operationId: "finish-after-validation",
        }),
      ],
    });
    await scenario.dispatch({
      version: 1,
      type: "start_or_resume",
      runId,
      purpose: "purchase_validation",
      eventId: started.run.dispatchEventId,
    });
    // Connect the browser only after the run has paused. The row exists
    // before the broker is consulted, so connecting on its first sight raced
    // the pause and let browser evidence join the still-open submission,
    // hiding how the agent settles a pending browser command.
    await waitForRun(
      runId,
      async () => {
        const [[operation], [run]] = await Promise.all([
          getDb(ctx.db)
            .select({ state: runOperation.state, result: runOperation.result })
            .from(runOperation)
            .where(
              and(
                eq(runOperation.runId, runId),
                eq(runOperation.kind, "browser_command"),
              ),
            )
            .limit(1),
          getDb(ctx.db)
            .select({ status: runTable.status })
            .from(runTable)
            .where(eq(runTable.id, runId)),
        ]);
        return (
          z.object({ commandId: z.uuid() }).safeParse(operation?.result)
            .success &&
          operation?.state === "completed" &&
          run?.status === "paused_offline"
        );
      },
      "Production service never paused for the browser command",
    );
    await scenario.connectBrowser({
      vendorAccountId: account.id,
      ledgerPartyId: party.id,
      userId: ctx.actor.userId,
    });
    await waitForRun(
      runId,
      async () => {
        const [run] = await getDb(ctx.db)
          .select({
            status: runTable.status,
            coordinatorStartedAt: runTable.coordinatorStartedAt,
          })
          .from(runTable)
          .where(eq(runTable.id, runId));
        return run?.status === "completed" && run.coordinatorStartedAt !== null;
      },
      "Production service never finalized targeted run",
    );
    expect(
      await protectedBusinessSnapshot(ctx.db, {
        purchaseId: targetPurchase.id,
        productId: targetProduct.entityId,
      }),
    ).toEqual(before);
    expect(await scenario.violations()).toEqual([]);
  }, 60_000);
});
