/* eslint-disable anti-slop/no-unsafe-dictionary-type -- Browser outcomes and extractor outputs are external wire payloads. */
import { runEntityId } from "@cubby/schemas/identifiers";
import { importRunAgentIdentity } from "@cubby/schemas/import-run-agent";
import { testShortcode } from "@cubby/schemas/testing";
import { and, eq, inArray } from "drizzle-orm";
import { taxonomyShortcode } from "tooling/product-category-fixtures";
import {
  awaitBrowserResult,
  awaitEvent,
  call,
  from,
  mcp,
  mcpRead,
  type ScriptStep,
} from "tooling/purchase-agent-script";
import { withTestDb } from "tooling/test-setup";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  expense,
  importSourceClaim,
  inventoryEntry,
  orderMail,
  orderMailEvent,
  product,
  project,
  purchase,
  runApproval,
  runFinding,
  run as runTable,
  runOperation,
  runOrderCandidate,
} from "~/server/db/schema";
import { getDb, withTransaction } from "~/server/repo/database-helpers";
import {
  createProductFixture,
  makeProductInput,
} from "~/server/repo/repo.fixtures";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

import { learnPurchaseProductExternalId } from "./external-id-learning";
import { startOrderMailImport } from "./gmail/import";
import {
  authorizePurchaseAgent,
  type ScenarioHarness,
  startScenarioHarness,
  waitFor,
  workerdDiagnostic,
} from "./purchase-agent-workerd.fixtures";
import { controlRun, startOrResumeRun } from "./run-service";

// Each scenario drives the production Flue agent, its tools, the MCP server,
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

type Line = {
  title: string;
  amount: number;
  lineKind: "principal" | "tax" | "shipping";
  sku?: string;
};

/** The extractor's wire shape: every optional field is an explicit null. */
const readyExtraction = (
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

const unreadableExtraction = (detail: string) => ({
  status: "unreadable",
  candidate: null,
  reason: null,
  detail,
});

let scenario: ScenarioHarness | undefined;
let scenarioRunId: string | undefined;

describe("purchase-agent scripted Flue scenarios", () => {
  const ctx = withTestDb();

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
  ) => {
    try {
      await waitFor(predicate, message, 20_000);
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
    // A pantry staple this vendor already sold the household, by its exact
    // SKU. A principal Expense needs a trade, and the browser import path
    // supplies none of its own (reported finding): a food Product inherits
    // the household Project's trade, so re-buying one imports cleanly.
    await getDb(ctx.db)
      .insert(project)
      .values({
        shortcode: testShortcode("project", "PRJ-HSHD"),
        name: "Household project",
        defaultTrade: "other",
      });
    const pantry = await createProductFixture(
      ctx.db,
      makeProductInput({
        name: "Scenario rolled oats, 1 kg",
        categoryId: taxonomyShortcode("food"),
      }),
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
    // generation and the same browser result by Flue's idempotency key, so
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
      // A real capture takes seconds, so the submission that issued the
      // second command settles before its result. Finding: when the result
      // lands first, that submission's settle-time reconcile sees no pending
      // command and moves the still-working run to review.
      1_500,
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
        { await: ["Approval granted for note-granted"] },
        note("note-granted-replay", "Granted scenario note"),
        note("note-rejected-propose", "Rejected scenario note"),
        awaitApproval("await-rejected"),
        { await: ["Approval rejected for note-rejected"] },
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
    // Finding: a grant records the approval but delivers no queue event, so
    // the coordinator stays parked until a member speaks to it.
    await expectQuiet(async () => [
      await scenario?.emitted(),
      (await runRow(seeded.run.id)).status,
    ]);
    expect((await runRow(seeded.run.id)).status).toBe("paused_approval");
    const agentId = importRunAgentIdentity(seeded.run.id, "account_sync");
    await scenario.prompt(
      agentId,
      "Approval granted for note-granted; continue the run.",
    );
    await waitForEmitted(seeded.run.id, "await-rejected");
    await waitForStatus(seeded.run.id, "paused_approval");
    // Let the parked submission's settle event land first. A rejection
    // returns the run to `running` with no coordinator, so a settle processed
    // after it moves the run to review (reported as a finding).
    await expectQuiet(async () => [
      await scenario?.emitted(),
      (await runRow(seeded.run.id)).status,
    ]);
    await controlRun(ctx.db, ctx.actor, {
      runPublicId: seeded.run.publicId,
      action: "reject",
      operationId: "note-rejected",
    });
    expect((await runRow(seeded.run.id)).status).toBe("running");
    await scenario.prompt(
      agentId,
      "Approval rejected for note-rejected; do not retry it.",
    );
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

  it("mail evidence: prepares and commits the frozen confirmation unchanged, replays the commit by operation id, and completes", async () => {
    const seeded = await seedOrderMail(
      "SCN30001",
      "Order SCN30001. Synthetic pruning saw, SKU SAW-30, quantity 1, $9.00. Grand Total $9.00 USD.",
    );
    const runId = seeded.runId;
    const order = (path: string) => from("extract-1", path);
    const commit = (id: string) =>
      mcp(
        id,
        "purchase_import",
        runId,
        {
          action: "commit",
          prepareOperationId: "prepare-1",
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
        { operationId: "commit-1" },
      );
    scenario = await startScenarioHarness(ctx.databaseUrl, {
      steps: [
        call("claim-1", "claim_next_import_work"),
        { check: "claim-1", includes: "mail_evidence" },
        call("extract-1", "extract_run_evidence"),
        mcp(
          "prepare-1",
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
        ),
        commit("commit-1-first"),
        // The identical commit under the same operation id is a replay.
        commit("commit-1-replay"),
        settlementRead("settlement-1"),
        call("claim-2", "claim_next_import_work"),
        { check: "claim-2", includes: "settlement_verification" },
        call("finish-1", "finish_import_run"),
      ],
      extractions: [
        {
          match: "SCN30001",
          output: readyExtraction("SCN30001", "2026-09-24T12:00:00.000Z", [
            {
              title: "Synthetic pruning saw",
              amount: 9,
              lineKind: "principal",
              sku: "SAW-30",
            },
          ]),
        },
      ],
    });
    await scenario.dispatch(seeded.start);
    await waitForStatus(runId, "completed");

    const graph = await purchaseGraph(seeded.vendor.id);
    expect(graph.purchases).toMatchObject([{ orderId: "SCN30001" }]);
    expect(graph.expenses).toMatchObject([{ cost: 9, lineKind: "principal" }]);
    expect(graph.expenses[0]?.productId).not.toBeNull();
    expect(graph.claims).toHaveLength(1);
    expect(graph.inventory).toEqual([]);
    expect(
      await getDb(ctx.db)
        .select({ state: runOperation.state })
        .from(runOperation)
        .where(
          and(
            eq(runOperation.runId, runId),
            eq(runOperation.operationId, "commit-1"),
          ),
        ),
    ).toEqual([{ state: "completed" }]);
    expect(await scenario.violations()).toEqual([]);
  }, 90_000);

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
});
