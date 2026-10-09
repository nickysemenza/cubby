import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { browserBridgeResult } from "@cubby/schemas/purchase-import";
import { retainedResearchObservation } from "@cubby/schemas/research";
import { researchWorkResolve } from "@cubby/schemas/research-tools";
import { researchObjectivesRunInput } from "@cubby/schemas/run-fields";
import { eq } from "drizzle-orm";
import {
  captureE2ERunIdentity,
  writeE2ERunBundle,
  type E2ERunIdentity,
} from "tooling/e2e-run-bundle";
import {
  from,
  type ScriptStep,
  type ScriptValue,
} from "tooling/purchase-agent-script";
import { withTestDb } from "tooling/test-setup";
import {
  HOLD_WORKERD_HARNESS_TIMEOUT_MS,
  holdWorkerdHarness,
} from "tooling/workerd-harness";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { z } from "zod";

import {
  expense,
  importSourceClaim,
  importSourceOrder,
  inventoryEntry,
  product,
  purchase,
  run,
  runEvidence,
  runOperation,
  runTarget,
} from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

import { browserCommandRecord } from "./browser-results";
import { capturedHtml } from "./browser.fixtures";
import {
  authorizePurchaseAgent,
  startScenarioHarness,
  waitFor,
  workerdDiagnostic,
  type ScenarioHarness,
} from "./purchase-agent-workerd.fixtures";
import { startOrResumeRun } from "./run-service";

// PR1760: a short numeric account row with literal onclick must remain a
// usable source, then lead to an owned detail observation and safe Purchase.
// The model gate prevents any write until this test verifies actual detail
// capture. One chosen order does not prove exhaustion of account history.
const listingURL = "https://history.example.test/account/orders";
const detailURL = "https://history.example.test/account/orders/opaque-token";
const rowRef = "row-54321";
const retained = z.looseObject({ research: retainedResearchObservation });
const repoRoot = fileURLToPath(new URL("../../../../../", import.meta.url));
const observed = (field: string): ScriptValue => ({
  $signal: "research_observation",
  path: field,
});
const step = (
  call: string,
  tool: string,
  args: Record<string, ScriptValue> = {},
): ScriptStep => ({ call, tool, args });

const proposal = researchWorkResolve.parse({
  workRef: "11111111-1111-4111-8111-111111111111",
  status: "partially_verified",
  identity: {
    evidenceIds: ["11111111-1111-4111-8111-111111111111"],
    reasoning:
      "Numeric order 54321 is printed on the retained detail with one annual maintenance service and its total.",
  },
  orders: [
    {
      vendor: {
        name: "Synthetic History Shop",
        website: "https://history.example.test",
      },
      evidenceIds: ["11111111-1111-4111-8111-111111111111"],
      reasoning:
        "Numeric order 54321 names the annual maintenance service, date and USD 12 total in its retained detail.",
      candidate: {
        orderId: "54321",
        orderedAt: "2026-09-12T12:00:00Z",
        merchant: "Synthetic History Shop",
        currency: "USD",
        printedGrandTotal: 12,
        lines: [
          {
            title: "Annual maintenance service",
            amount: 12,
            lineKind: "principal",
            quantity: 1,
          },
        ],
        payments: [],
        allShipmentsDelivered: false,
      },
      productResolutions: [{ kind: "expense_only", lineIndex: 0 }],
      defaultTrade: "other",
    },
  ],
  progress: {
    scopeExhausted: false,
    evidenceIds: ["11111111-1111-4111-8111-111111111111"],
    gaps: [
      "Only the selected order detail was verified; complete account-history exhaustion was not established.",
    ],
  },
  detail:
    "Imported one supported numeric order without claiming complete account history or inventing inventory.",
});
const steps: ScriptStep[] = [
  step("numeric-next", "work_next"),
  step("numeric-listing", "work_observe", {
    workRef: from("numeric-next", "work.workRef"),
    action: { kind: "navigate", url: listingURL },
  }),
  step("numeric-click", "work_observe", {
    workRef: from("numeric-next", "work.workRef"),
    action: {
      kind: "click",
      observationId: observed("observation.observationId"),
      ref: observed("observation.actions.0.ref"),
    },
  }),
  { check: "numeric-click", includes: "waiting" },
  { gate: "detail-evidence-verified" },
  step("numeric-resolve", "work_resolve", {
    ...proposal,
    workRef: from("numeric-next", "work.workRef"),
    identity: { ...proposal.identity, evidenceIds: [observed("evidenceId")] },
    orders: proposal.orders.map((order) => ({
      ...order,
      evidenceIds: [observed("evidenceId")],
    })),
    progress: { ...proposal.progress!, evidenceIds: [observed("evidenceId")] },
  }),
];

describe("research account-history clickable numeric row", () => {
  const ctx = withTestDb();
  let releaseHarness: (() => void) | undefined;
  beforeAll(async () => {
    releaseHarness = await holdWorkerdHarness();
  }, HOLD_WORKERD_HARNESS_TIMEOUT_MS);
  afterAll(() => releaseHarness?.());
  let runtime: ScenarioHarness | undefined;
  let started: E2ERunIdentity;
  let status = "failed";
  let activeRunId: string | undefined;
  let boundaries: Array<{ boundary: string; result: boolean | number }> = [];
  beforeEach(() => {
    started = captureE2ERunIdentity(repoRoot);
    boundaries = [];
    status = "failed";
    activeRunId = undefined;
  });
  afterEach(async () => {
    // These peers and every stored source are synthetic; preserve the actual
    // command/evidence/model boundary before shutting down the gated harness.
    const diagnostic =
      runtime && activeRunId
        ? {
            state: await workerdDiagnostic(
              ctx.db,
              activeRunId,
              runtime.harness,
            ),
            emitted: await runtime.emitted(),
            violations: await runtime.violations(),
            evidence: await getDb(ctx.db)
              .select({
                id: runEvidence.id,
                targetId: runEvidence.targetId,
                sourceMetadata: runEvidence.sourceMetadata,
              })
              .from(runEvidence)
              .where(eq(runEvidence.runId, activeRunId)),
            purchaseCount: (
              await getDb(ctx.db).select({ id: purchase.id }).from(purchase)
            ).length,
          }
        : null;
    await runtime?.close();
    runtime = undefined;
    const outputDir = `/tmp/cubby-research-numeric-history-${Date.now()}`;
    mkdirSync(outputDir, { recursive: true });
    const evidence = path.join(outputDir, "boundary-results.json");
    writeFileSync(
      evidence,
      JSON.stringify(
        {
          status,
          source:
            "Synthetic account, browser and model peers; actual Worker research admission/retention/writes",
          boundaries,
          diagnostic,
        },
        null,
        2,
      ),
    );
    writeE2ERunBundle({
      repoRoot,
      outputDir,
      evidence: [evidence],
      kind: "browser",
      status,
      command: [
        "pnpm",
        "--dir",
        "apps/web",
        "test:postgres",
        "src/server/purchase-import/purchase-research-account-history.integration.test.ts",
        "--project",
        "integration-workerd",
      ],
      profile: "purchase-agent",
      scenario: "pr1760-research-clickable-numeric-history",
      started,
      cases: [
        {
          name: "PR1760 researcher numeric row to retained detail to Purchase",
          status,
        },
      ],
    });
  });

  it("imports the supported detail reached by a short numeric clickable account row without claiming full history", async () => {
    const member = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic history member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const seller = await insertWithShortcode(ctx.db, "vendor", {
      name: "Synthetic History Shop",
      website: "https://history.example.test",
      browserDomains: ["history.example.test"],
    });
    const account = await insertWithShortcode(ctx.db, "vendorAccount", {
      label: "Synthetic numeric history account",
      vendorId: seller.id,
      ledgerPartyId: member.id,
      browserSyncEnabled: true,
    });
    await authorizePurchaseAgent(ctx.db, ctx.actor.userId);
    const listing = await capturedHtml({
      sourceURL: listingURL,
      title: "Synthetic account history",
      html: `<table><tr onclick="window.location.href='${detailURL}'"><td>#54321</td><td>September 12, 2026</td><td>USD 12.00</td></tr></table>`,
    });
    if (listing.status !== "completed" || !listing.snapshot)
      throw new Error("Synthetic listing capture missing");
    listing.snapshot.actions = [
      {
        ref: rowRef,
        kind: "button",
        label: "#54321 September 12, 2026 USD 12.00",
        disabled: false,
      },
    ];
    const detail = await capturedHtml({
      sourceURL: detailURL,
      title: "Order #54321",
      html: "<h1>Order #54321</h1><p>Ordered September 12, 2026.</p><p>Annual maintenance service. Quantity 1. USD 12.00.</p><p>Total USD 12.00.</p>",
    });
    // Validate synthetic wire/setup before the expensive Worker boundary.
    for (const outcome of [listing, detail])
      browserBridgeResult.parse({
        protocolVersion: 4,
        commandID: crypto.randomUUID(),
        operationID: "synthetic-setup",
        runID: crypto.randomUUID(),
        completedAt: new Date().toISOString(),
        outcome,
      });
    runtime = await startScenarioHarness(ctx.databaseUrl, { steps });
    started = captureE2ERunIdentity(repoRoot);
    const gateway = runtime.harness.getWorker("cubby-test-gateway");
    const configured = await gateway.fetch("https://gateway.test/configure", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        extractions: [],
        assessments: [
          {
            match: "Numeric order 54321",
            output: {
              identityVerified: true,
              scopeCompletionVerified: false,
              acceptedFacts: [],
              acceptedIdentifiers: [],
              acceptedIdentifierClaims: [],
              acceptedImages: [],
              acceptedOrders: [0],
              acceptedEmailLinks: [],
              rejected: [],
            },
          },
        ],
      }),
    });
    expect(configured.ok).toBe(true);
    const peer = runtime.harness.getWorker("cubby-queue-producer");
    const connected = await peer.fetch("https://queue.test/browser-connect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        vendorAccountId: account.id,
        ledgerPartyId: member.id,
        userId: ctx.actor.userId,
        outcomes: { [listingURL]: listing },
        actionOutcomes: { [rowRef]: detail },
      }),
    });
    expect(connected.status).toBe(202);
    const admitted = await startOrResumeRun(ctx.db, {
      ledgerPartyId: member.id,
      vendorAccountId: account.id,
      trigger: "manual",
    });
    activeRunId = admitted.id;
    const [scope] = await getDb(ctx.db)
      .select()
      .from(run)
      .where(eq(run.id, admitted.id));
    if (!scope?.dispatchEventId)
      throw new Error("Synthetic history admission missing dispatch");
    const objectives = researchObjectivesRunInput.parse(scope.input);
    expect(objectives.objectives).toMatchObject([
      { kind: "account_history", vendorAccountId: account.id },
    ]);
    await runtime.dispatch({
      version: 1,
      type: "start_or_resume",
      purpose: "account_sync",
      runId: admitted.id,
      eventId: scope.dispatchEventId,
    });
    await waitFor(
      async () =>
        (
          await getDb(ctx.db)
            .select()
            .from(runEvidence)
            .where(eq(runEvidence.runId, admitted.id))
        ).length === 2,
      "Two owned numeric history observations",
      15_000,
    );
    const evidence = await getDb(ctx.db)
      .select()
      .from(runEvidence)
      .where(eq(runEvidence.runId, admitted.id));
    const pages = evidence.map((row) => ({
      row,
      value: retained.parse(row.sourceMetadata).research,
    }));
    const accountPage = pages.find(
      (page) => page.value.observation.sourceURL === listingURL,
    );
    expect(accountPage?.value.observation.links).toMatchObject([
      { url: detailURL, label: "#54321" },
    ]);
    const detailPage = pages.find(
      (page) => page.value.observation.servedURL === detailURL,
    );
    expect(detailPage?.value.observation.readableText).toContain(
      "Annual maintenance service",
    );
    const targets = await getDb(ctx.db)
      .select()
      .from(runTarget)
      .where(eq(runTarget.runId, admitted.id));
    expect(targets).toHaveLength(1);
    expect(evidence.map((row) => row.targetId)).toEqual([
      targets[0]?.id,
      targets[0]?.id,
    ]);
    boundaries.push({
      boundary: "Numeric literal row and owned detail retained before import",
      result: true,
    });
    const operations = await getDb(ctx.db)
      .select()
      .from(runOperation)
      .where(eq(runOperation.runId, admitted.id));
    const browser = operations
      .filter((row) => row.kind === "browser_command")
      .map((row) => browserCommandRecord.parse(row.result));
    expect(browser).toHaveLength(2);
    expect(
      browser.filter((record) => record.command.operation.type === "click"),
    ).toMatchObject([
      {
        workRef: targets[0]?.id,
        command: {
          operation: {
            type: "click",
            ref: rowRef,
            observationId: listing.snapshot.observationId,
          },
        },
      },
    ]);
    await runtime.release("detail-evidence-verified");
    await waitFor(
      async () =>
        (
          await getDb(ctx.db)
            .select({ status: run.status })
            .from(run)
            .where(eq(run.id, admitted.id))
        )[0]?.status === "needs_review",
      "Supported numeric order and honest incomplete history settlement",
      15_000,
    );
    const saved = await getDb(ctx.db).select().from(purchase);
    expect(saved).toHaveLength(1);
    expect(saved[0]?.orderId).toBe("54321");
    expect(saved[0]?.vendorId).toBe(seller.id);
    const lines = await getDb(ctx.db).select().from(expense);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.purchaseId).toBe(saved[0]?.id);
    expect(
      lines.reduce(
        (sum, line) => sum + (line.cost === null ? Number.NaN : line.cost),
        0,
      ),
    ).toBe(12);
    expect(await getDb(ctx.db).select().from(product)).toEqual([]);
    expect(await getDb(ctx.db).select().from(inventoryEntry)).toEqual([]);
    const associations = await getDb(ctx.db)
      .select({
        purchaseId: importSourceOrder.purchaseId,
        ledgerPartyId: importSourceClaim.ledgerPartyId,
        firstRunId: importSourceClaim.firstRunId,
      })
      .from(importSourceOrder)
      .innerJoin(
        importSourceClaim,
        eq(importSourceOrder.sourceClaimId, importSourceClaim.id),
      );
    expect(associations).toHaveLength(1);
    expect(associations[0]?.purchaseId).toBe(saved[0]?.id);
    expect(associations[0]?.ledgerPartyId).toBe(member.id);
    expect(associations[0]?.firstRunId).toBe(admitted.id);
    expect(await runtime.violations()).toEqual([]);
    boundaries.push({
      boundary:
        "One supported Purchase, recorded spend and no fabricated inventory",
      result: 12,
    });
    status = "passed";
  }, 90_000);
});
