import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseEntityId,
  runEntityId,
  runShortcode,
} from "@cubby/schemas/identifiers";
import type { PurchaseAgentEvent } from "@cubby/schemas/purchase-import";
import {
  CHARGE_HUNT_STATE,
  mailResearchRunInput,
} from "@cubby/schemas/run-fields";
import { sha256Hex } from "@cubby/shared/sha256";
import { and, asc, eq } from "drizzle-orm";
import {
  captureE2ERunIdentity,
  writeE2ERunBundle,
  type E2ERunIdentity,
} from "tooling/e2e-run-bundle";
import {
  call,
  from,
  mcp,
  mcpRead,
  type ScriptStep,
  type ScriptValue,
} from "tooling/purchase-agent-script";
import {
  TEST_HOME_SHORTCODE,
  type TestDbContext,
  withTestDb,
} from "tooling/test-setup";
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
  aiUsage,
  auditLog,
  entityAttachment,
  expense,
  financialTransaction,
  financialTransactionAllocation,
  image,
  imageProcessingJob,
  importHunt,
  importSourceClaim,
  importSourceOrder,
  inventoryEntry,
  mailboxMessage,
  orderMail,
  photoGroupProposal,
  product,
  purchase,
  purchasePaymentEvidence,
  vendorAccount,
  run as runTable,
  runOperation,
  runProgress,
  runTarget,
} from "~/server/db/schema";
import { approvePhotoGroupProposals } from "~/server/photo-import-run/proposals";
import { getDb } from "~/server/repo/database-helpers";
import { updateFinancialTransaction } from "~/server/repo/financial-transaction";
import { updateImageProcessingSettings } from "~/server/repo/image-processing-maintenance";
import {
  createImageFixture,
  createLocationFixture,
  createProductFixture,
  makeLocationInput,
  makeProductInput,
} from "~/server/repo/repo.fixtures";
import { getRunLiveProgress } from "~/server/repo/run-progress";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import { productionPhotoImportCommitPorts } from "~/server/services/photo-import-commit.service";

import { completedCapture } from "./browser.fixtures";
import { startSelectedChargeRun } from "./charge-runs";
import {
  authorizePurchaseAgent,
  startScenarioHarness,
  waitFor,
  workerdDiagnostic,
  type ScenarioHarness,
} from "./purchase-agent-workerd.fixtures";
import { admitPurchaseValidationResearch } from "./purchase-validation-research";
import {
  researchObjectiveKey,
  researchObjectivesOf,
} from "./research-objective";
import { startMailResearch } from "./research-run";
import {
  controlRun,
  finalizePhotoRun,
  startPhotoInventoryCoordinator,
  startPhotoInventoryRun,
} from "./run-service";

// Current coordinator boundaries still needing built-Worker coverage: reviewed
// photo stock, partial source retry, and a late canonical charge allocation.
// Numeric clickable rows and auth/cancel have dedicated current Worker suites.
const repoRoot = fileURLToPath(new URL("../../../../../", import.meta.url));
const step = (
  id: string,
  tool: string,
  args: Record<string, ScriptValue> = {},
): ScriptStep => ({ call: id, tool, args });
const noOperands = {
  identityVerified: false,
  acceptedFacts: [],
  acceptedIdentifiers: [],
  acceptedIdentifierClaims: [],
  acceptedImages: [],
  acceptedOrders: [],
  acceptedEmailLinks: [],
  rejected: [],
};
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
    database.select().from(importSourceOrder),
    database.select().from(purchasePaymentEvidence),
    database.select().from(financialTransaction),
    database.select().from(financialTransactionAllocation),
    database.select().from(auditLog),
  ]);
  return JSON.stringify(values);
}

let scenario: ScenarioHarness | undefined;
let scenarioRunId: string | undefined;
let identity: E2ERunIdentity;
let began = 0;
let diagnostic: string | undefined;
let photoApproval:
  | Awaited<ReturnType<typeof approvePhotoGroupProposals>>
  | undefined;
const readScenarioEvidence = async (active: ScenarioHarness | undefined) => ({
  emitted: await active?.emitted(),
  violations: await active?.violations(),
  gateway: await active?.gatewayCalls(),
});

describe("current purchase-agent system boundaries", () => {
  const ctx = withTestDb();
  let releaseHarness: (() => void) | undefined;
  beforeAll(async () => {
    releaseHarness = await holdWorkerdHarness();
  }, HOLD_WORKERD_HARNESS_TIMEOUT_MS);
  afterAll(() => releaseHarness?.());
  beforeEach(() => {
    identity = captureE2ERunIdentity(repoRoot);
    began = Date.now();
    diagnostic = undefined;
    photoApproval = undefined;
  });
  afterEach(async ({ task }) => {
    const outputDir = path.join(
      repoRoot,
      "artifacts/purchase-research-lifecycle",
      new Date().toISOString().replaceAll(":", "-"),
    );
    mkdirSync(outputDir, { recursive: true });
    let cleanupError: unknown;
    let observations:
      | Awaited<ReturnType<typeof readScenarioEvidence>>
      | undefined;
    try {
      observations = await readScenarioEvidence(scenario);
      if (scenarioRunId)
        diagnostic = await workerdDiagnostic(
          ctx.db,
          scenarioRunId,
          scenario?.harness,
        );
    } catch (error) {
      cleanupError = error;
    } finally {
      try {
        await scenario?.close();
      } catch (error) {
        cleanupError ??= error;
      }
      scenario = undefined;
      scenarioRunId = undefined;
      const failed = task.result?.state === "fail" || Boolean(cleanupError);
      writeFileSync(
        path.join(outputDir, "report.json"),
        JSON.stringify(
          {
            synthetic: true,
            result: failed ? "failed" : "passed",
            errors: task.result?.errors?.map((error) => error.message),
            cleanupError:
              cleanupError instanceof Error
                ? cleanupError.message
                : cleanupError,
            observations,
            diagnostic,
            photoApproval,
            durationMs: Date.now() - began,
            limits: [
              "External coordinator and semantic decisions are scripted; this does not measure model quality.",
              "Photo description processing is skipped at its external seam; approval readiness is covered by the photo proposal integration tests.",
            ],
          },
          null,
          2,
        ),
      );
      writeE2ERunBundle({
        repoRoot,
        outputDir,
        started: identity,
        evidence: [outputDir],
        kind: "browser",
        status: failed ? "failed" : "passed",
        profile: "purchase-agent",
        scenario: task.name,
        phase: "completed",
        command: [
          "pnpm",
          "--dir",
          repoRoot,
          "test:postgres",
          "src/server/purchase-import/purchase-agent-scenarios.integration.test.ts",
          "--project",
          "integration-workerd",
          "-t",
          task.name,
        ],
        cases: [
          {
            name: task.name,
            status: failed ? "failed" : "passed",
            durationMs: Date.now() - began,
          },
        ],
      });
    }
    if (cleanupError) throw cleanupError;
  });
  const runRow = async (runId: string) => {
    const [row] = await getDb(ctx.db)
      .select()
      .from(runTable)
      .where(eq(runTable.id, runEntityId.parse(runId)));
    if (!row) throw new Error("Synthetic Run missing");
    return row;
  };
  const waitForRun = (
    _runId: string,
    predicate: () => Promise<boolean>,
    message: string,
  ) => waitFor(predicate, message, 20_000);
  const waitForStatus = (runId: string, status: string) =>
    waitForRun(
      runId,
      async () => (await runRow(runId)).status === status,
      `Run did not settle as ${status}`,
    );
  it("photo inventory: dispatches through the agent and MCP, waits for review, then commits only on approval", async () => {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic wardrobe member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const run = await startPhotoInventoryRun(ctx.db, {
      actorUserId: ctx.actor.userId,
    });
    const bytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
      "base64",
    );
    const checksum = await sha256Hex(bytes);
    const imageFixture = await createImageFixture(
      ctx.db,
      `synthetic-wardrobe-${crypto.randomUUID()}`,
      {
        status: "PENDING",
        size: bytes.byteLength,
        sha256: checksum,
        width: 1,
        height: 1,
        renderStatus: null,
        storageStatus: "unverified",
      },
    );
    await updateImageProcessingSettings(ctx.db, {
      enabled: false,
      paused: true,
    });
    await finalizePhotoRun(
      ctx.db,
      {
        runId: runShortcode.parse(run.publicId),
        images: [
          {
            imageId: imageFixture.shortcode,
            position: 0,
            sha256: checksum,
            width: 1,
            height: 1,
          },
        ],
      },
      ctx.actor,
      {
        ...productionPhotoImportCommitPorts,
        getObject: async () => new Response(bytes),
        inspect: async () => ({
          contentType: "image/png",
          detectedContentType: "image/png",
          width: 1,
          height: 1,
          sha256: checksum,
          renderStatus: "verified",
          storageStatus: "available",
          verifiedAt: new Date(),
        }),
      },
    );
    const closet = await createLocationFixture(
      ctx.db,
      makeLocationInput({
        name: "Synthetic review closet",
        parentId: TEST_HOME_SHORTCODE,
      }),
      ctx.actor,
    );
    scenarioRunId = run.id;
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
              inventory: { locationId: closet.id, quantity: 1 },
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
    expect(await getDb(ctx.db).select().from(inventoryEntry)).toEqual([]);
    await getDb(ctx.db)
      .update(imageProcessingJob)
      .set({
        state: "skipped",
        completedAt: new Date(),
        lastError:
          "Synthetic lifecycle scenario skips external photo description",
      })
      .where(
        and(
          eq(
            imageProcessingJob.imageId,
            parseEntityId("image", imageFixture.id),
          ),
          eq(imageProcessingJob.kind, "describe_image"),
          eq(imageProcessingJob.sourceContentHash, checksum),
        ),
      );
    const approval = await approvePhotoGroupProposals(
      ctx.db,
      { runId: run.publicId },
      ctx.actor,
    );
    photoApproval = approval;
    expect(approval.results[0]).toMatchObject({ outcome: "committed" });
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
    const [created] = await getDb(ctx.db)
      .select({ id: product.id })
      .from(product)
      .where(eq(product.name, productName));
    if (!created) throw new Error("Approved Product missing");
    const entries = await getDb(ctx.db)
      .select()
      .from(inventoryEntry)
      .where(eq(inventoryEntry.productId, created.id));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      amountValue: 1,
      amountUnit: "each",
      ownershipMode: "person",
      ownerLedgerPartyId: party.id,
      locationId: closet.entityId,
    });
    const replay = await approvePhotoGroupProposals(
      ctx.db,
      { runId: run.publicId, groupKeys: ["synthetic-wardrobe-item"] },
      ctx.actor,
    );
    expect(replay.results).toEqual([
      { groupKey: "synthetic-wardrobe-item", outcome: "replayed" },
    ]);
    expect(
      await getDb(ctx.db)
        .select()
        .from(inventoryEntry)
        .where(eq(inventoryEntry.productId, created.id)),
    ).toEqual(entries);
    expect(await scenario.violations()).toEqual([]);
  }, 60_000);
  it("purchase validation: fences, waits for browser evidence, resumes, and completes without business writes", async () => {
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
      browserSyncEnabled: true,
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
    const started = await admitPurchaseValidationResearch(ctx.db, {
      ledgerPartyId: party.id,
      userId: ctx.actor.userId,
      purchaseIds: [targetPurchase.id],
    });
    if (!started.created || !started.row.dispatchEventId)
      throw new Error("Expected current validation dispatch generation");
    const runId = started.row.id;
    scenarioRunId = runId;
    const before = await protectedBusinessSnapshot(ctx.db, {
      purchaseId: targetPurchase.id,
      productId: targetProduct.entityId,
    });
    scenario = await startScenarioHarness(ctx.databaseUrl, {
      steps: [
        { call: "validation-next", tool: "work_next", args: {} },
        {
          call: "validation-browser",
          tool: "work_observe",
          args: {
            workRef: from("validation-next", "work.workRef"),
            action: {
              kind: "navigate",
              url: "https://shop.example.test/orders/ORDER-WORKERD-1",
            },
          },
        },
        { await: ["research_observation"] },
        { call: "validation-observed", tool: "work_next", args: {} },
        {
          call: "validation-resolve",
          tool: "work_resolve",
          args: {
            workRef: from("validation-observed", "work.workRef"),
            status: "verified",
            identity: {
              evidenceIds: [
                from(
                  "validation-observed",
                  "work.retainedObservation.evidenceId",
                ),
              ],
              reasoning: "The original names this unchanged recorded order.",
            },
            orders: [
              {
                purchaseRef: targetPurchase.shortcode,
                vendorRef: vendor.shortcode,
                evidenceIds: [
                  from(
                    "validation-observed",
                    "work.retainedObservation.evidenceId",
                  ),
                ],
                defaultTrade: "other",
                reasoning:
                  "The original supports the unchanged recorded order.",
                candidate: {
                  orderId: "ORDER-WORKERD-1",
                  orderedAt: "2026-09-20T12:00:00.000Z",
                  merchant: vendor.name,
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
                productResolutions: [
                  {
                    lineIndex: 0,
                    kind: "existing",
                    productId: targetProductRow.shortcode,
                  },
                ],
              },
            ],
            detail:
              "Validated the unchanged recorded order from retained browser evidence.",
          },
        },
        { check: "validation-resolve", includes: "verified" },
      ],
    });
    await scenario.harness
      .getWorker("cubby-test-gateway")
      .fetch("https://gateway.test/configure", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          extractions: [],
          assessments: [
            {
              match: "unchanged recorded order",
              output: {
                identityVerified: true,
                acceptedOrders: [0],
                acceptedEmailLinks: [],
                acceptedFacts: [],
                acceptedIdentifiers: [],
                acceptedIdentifierClaims: [],
                acceptedImages: [],
                rejected: [],
              },
            },
          ],
        }),
      });
    await scenario.dispatch({
      version: 1,
      type: "start_or_resume",
      runId,
      purpose: "purchase_validation",
      eventId: started.row.dispatchEventId,
    });
    await waitForRun(
      runId,
      async () => {
        const [operation] = await getDb(ctx.db)
          .select()
          .from(runOperation)
          .where(
            and(
              eq(runOperation.runId, runId),
              eq(runOperation.kind, "browser_command"),
            ),
          )
          .limit(1);
        return z
          .object({ commandId: z.uuid(), workRef: z.uuid() })
          .safeParse(operation?.result).success;
      },
      "Current research never retained a pending browser command",
    );
    expect(
      await protectedBusinessSnapshot(ctx.db, {
        purchaseId: targetPurchase.id,
        productId: targetProduct.entityId,
      }),
    ).toEqual(before);
    await scenario.connectBrowser({
      vendorAccountId: account.id,
      ledgerPartyId: party.id,
      userId: ctx.actor.userId,
      outcomes: {
        "https://shop.example.test/orders/ORDER-WORKERD-1":
          await completedCapture(
            "https://shop.example.test/orders/ORDER-WORKERD-1",
            {
              title: "Synthetic unchanged order",
              text: "ORDER-WORKERD-1: Workerd validation product, quantity 1, USD 12.34. Not delivered.",
            },
          ),
      },
    });
    await waitForRun(
      runId,
      async () => (await runRow(runId))?.status === "completed",
      "Current researcher did not complete supported unchanged validation",
    );
    expect(
      await protectedBusinessSnapshot(ctx.db, {
        purchaseId: targetPurchase.id,
        productId: targetProduct.entityId,
      }),
    ).toEqual(before);
    expect(await scenario.violations()).toEqual([]);
    diagnostic = await workerdDiagnostic(ctx.db, runId, scenario.harness);
  }, 60_000);

  it("partial mail: retries only unresolved sources after a supported import without replacing prior money or results", async () => {
    const database = getDb(ctx.db);
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic partial-source member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Synthetic service shop",
      website: "https://service.example.test",
      browserDomains: ["service.example.test"],
    });
    const sources = [];
    for (const [messageId, body] of [
      [
        "synthetic-supported-service",
        "Synthetic service shop. SERVICE-1, September 20 2026: annual service, quantity 1, USD 9.00. Total USD 9.00.",
      ],
      [
        "synthetic-ambiguous-source",
        "Synthetic service shop purchase inquiry. Exact order, itemization, date and amount absent.",
      ],
    ]) {
      const checksum = await sha256Hex(body!);
      const [mail] = await database
        .insert(orderMail)
        .values({
          ledgerPartyId: party.id,
          mailboxId: "synthetic-partial-mailbox",
          messageId: messageId!,
          sender: "orders@service.example.test",
          subject: "Synthetic service inquiry",
          receivedAt: new Date("2026-09-20T12:00:00Z"),
          rawChecksum: checksum,
          content: { snippet: null, bodyText: body!, bodyHtml: null },
        })
        .returning();
      if (!mail) throw new Error("Synthetic partial source missing");
      sources.push(mail);
      await database.insert(mailboxMessage).values({
        ledgerPartyId: party.id,
        mailboxId: mail.mailboxId,
        messageId: mail.messageId,
        checksum,
        classification: "related",
        classificationVersion: "synthetic-source-v1",
        status: "pending",
        orderMailId: mail.id,
      });
    }
    const supported = sources.find(
      (source) => source.messageId === "synthetic-supported-service",
    );
    const ambiguous = sources.find(
      (source) => source.messageId === "synthetic-ambiguous-source",
    );
    if (!supported || !ambiguous)
      throw new Error("Synthetic partial sources missing");
    const events: PurchaseAgentEvent[] = [];
    const [started] = await startMailResearch(
      ctx.db,
      {
        ledgerPartyId: party.id,
        userId: ctx.actor.userId,
        messageIds: sources.map((source) => source.id),
      },
      {
        send: async (event) => {
          events.push(event);
        },
      },
    );
    if (!started || events.length !== 1)
      throw new Error("Synthetic partial admission missing");
    const parent = await runRow(started.runId);
    scenarioRunId = parent.id;
    await authorizePurchaseAgent(ctx.db, ctx.actor.userId);
    const targets = await database
      .select()
      .from(runTarget)
      .where(eq(runTarget.runId, parent.id))
      .orderBy(asc(runTarget.createdAt), asc(runTarget.id));
    const ambiguousSteps = (prefix: string): ScriptStep[] => [
      step(`${prefix}-next`, "work_next"),
      step(`${prefix}-read`, "mail_read", {
        workRef: from(`${prefix}-next`, "work.workRef"),
        messageRef: ambiguous.id,
      }),
      step(`${prefix}-resolve`, "work_resolve", {
        workRef: from(`${prefix}-next`, "work.workRef"),
        status: "ambiguous",
        identity: {
          evidenceIds: [from(`${prefix}-read`, "evidenceId")],
          reasoning:
            "Exact ordered identity is absent in the retained original.",
        },
        detail:
          "Synthetic unresolved itemization has no supported order or amount.",
      }),
      { check: `${prefix}-resolve`, includes: "ambiguous" },
    ];
    const steps: ScriptStep[] = targets.flatMap((target, index) =>
      target.workKey === ambiguous.id
        ? ambiguousSteps(`partial-${index}`)
        : [
            step(`partial-${index}-next`, "work_next"),
            step(`partial-${index}-read`, "mail_read", {
              workRef: from(`partial-${index}-next`, "work.workRef"),
              messageRef: supported.id,
            }),
            step(`partial-${index}-resolve`, "work_resolve", {
              workRef: from(`partial-${index}-next`, "work.workRef"),
              status: "verified",
              identity: {
                evidenceIds: [from(`partial-${index}-read`, "evidenceId")],
                reasoning:
                  "SERVICE-1 identifies one annual service, quantity 1, USD 9.00.",
              },
              orders: [
                {
                  vendorRef: vendor.shortcode,
                  evidenceIds: [from(`partial-${index}-read`, "evidenceId")],
                  defaultTrade: "other",
                  reasoning:
                    "SERVICE-1 identifies one annual service, quantity 1, USD 9.00.",
                  candidate: {
                    orderId: "SERVICE-1",
                    orderedAt: "2026-09-20T12:00:00.000Z",
                    merchant: vendor.name,
                    currency: "USD",
                    printedGrandTotal: 9,
                    lines: [
                      {
                        title: "Annual service",
                        quantity: 1,
                        amount: 9,
                        lineKind: "principal",
                      },
                    ],
                    payments: [],
                    allShipmentsDelivered: false,
                  },
                  productResolutions: [{ lineIndex: 0, kind: "expense_only" }],
                },
              ],
              detail: "Supported synthetic service imported without stock.",
            }),
            { check: `partial-${index}-resolve`, includes: "verified" },
          ],
    );
    const assessments = [
      { match: "Synthetic unresolved itemization", output: noOperands },
      {
        match: "SERVICE-1 identifies one annual service",
        output: { ...noOperands, identityVerified: true, acceptedOrders: [0] },
      },
    ];
    scenario = await startScenarioHarness(ctx.databaseUrl, {
      steps,
      assessments,
    });
    await scenario.dispatch(events[0]!);
    await waitForStatus(parent.id, "needs_review");
    const settledTargets = await database
      .select()
      .from(runTarget)
      .where(eq(runTarget.runId, parent.id))
      .orderBy(asc(runTarget.position));
    expect(
      settledTargets.find((target) => target.workKey === supported.id),
    ).toMatchObject({ state: "completed", outcome: "verified" });
    expect(
      settledTargets.find((target) => target.workKey === ambiguous.id),
    ).toMatchObject({ state: "unresolved", outcome: "ambiguous" });
    const originalPurchases = await database.select().from(purchase);
    const originalExpenses = await database.select().from(expense);
    const originalAssociations = await database
      .select()
      .from(importSourceOrder);
    expect(originalPurchases).toHaveLength(1);
    expect(originalExpenses).toHaveLength(1);
    expect(originalExpenses[0]).toMatchObject({
      purchaseId: originalPurchases[0]!.id,
      cost: 9,
    });
    expect(originalAssociations).toHaveLength(1);
    expect(await database.select().from(inventoryEntry)).toEqual([]);
    const retried = await controlRun(ctx.db, ctx.actor, {
      runPublicId: parent.shortcode,
      action: "retry",
    });
    if (!("successorRunId" in retried) || !retried.successorRunId)
      throw new Error("Synthetic partial successor missing");
    const child = await runRow(retried.successorRunId);
    expect(child).toMatchObject({
      predecessorRunId: parent.id,
      attempt: parent.attempt === null ? null : parent.attempt + 1,
    });
    expect(mailResearchRunInput.parse(child.input).sources).toEqual([
      { orderMailId: ambiguous.id, checksum: ambiguous.rawChecksum },
    ]);
    expect((await runRow(parent.id)).input).toEqual(parent.input);
    expect(
      await database
        .select()
        .from(runTarget)
        .where(eq(runTarget.runId, parent.id))
        .orderBy(asc(runTarget.position)),
    ).toEqual(settledTargets);
    await scenario.configure({
      steps: ambiguousSteps("partial-retry"),
      assessments,
    });
    scenarioRunId = child.id;
    if (!child.dispatchEventId)
      throw new Error("Synthetic retry dispatch generation missing");
    await scenario.dispatch({
      version: 1,
      type: "start_or_resume",
      runId: child.id,
      eventId: child.dispatchEventId,
      purpose: child.purpose,
    });
    await waitForStatus(child.id, "needs_review");
    expect(await database.select().from(purchase)).toEqual(originalPurchases);
    expect(await database.select().from(expense)).toEqual(originalExpenses);
    expect(await database.select().from(importSourceOrder)).toEqual(
      originalAssociations,
    );
    expect(await database.select().from(inventoryEntry)).toEqual([]);
    const replay = await controlRun(ctx.db, ctx.actor, {
      runPublicId: parent.shortcode,
      action: "retry",
    });
    if (!("successorRunId" in replay))
      throw new Error("Synthetic partial replay successor missing");
    expect(replay.successorRunId).toBe(child.id);
    expect(await scenario.violations()).toEqual([]);
  }, 60_000);

  it("selected charges: retains not-found and ambiguous review outcomes without downgrading a late member allocation", async () => {
    const database = getDb(ctx.db);
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic charge member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Synthetic charge shop",
      website: "https://charge.example.test",
      browserDomains: ["charge.example.test"],
    });
    const account = await insertWithShortcode(ctx.db, "vendorAccount", {
      label: "Synthetic charge transport",
      vendorId: vendor.id,
      ledgerPartyId: party.id,
      browserSyncEnabled: true,
    });
    const card = await insertWithShortcode(ctx.db, "financialAccount", {
      name: "Synthetic charge card",
      ledgerPartyId: party.id,
      identity: { kind: "credit_card", issuer: null, network: "visa" },
    });
    const charges = [];
    for (const [index, amount] of [11, 22, 33].entries()) {
      const transaction = await insertWithShortcode(
        ctx.db,
        "financialTransaction",
        {
          accountId: card.id,
          kind: "purchase",
          status: "posted",
          amount,
          merchant: vendor.name,
          transactionDate: `2026-09-${String(index + 20).padStart(2, "0")}`,
          postedDate: `2026-09-${String(index + 20).padStart(2, "0")}`,
        },
      );
      const [hunt] = await database
        .insert(importHunt)
        .values({
          ledgerPartyId: party.id,
          financialTransactionId: transaction.id,
          vendorId: vendor.id,
          vendorAccountId: account.id,
          state: "pending_browser",
          dateFrom: "2026-09-01",
          dateTo: "2026-09-30",
        })
        .returning();
      if (!hunt) throw new Error("Synthetic selected hunt missing");
      charges.push({ transaction, hunt });
    }
    const [notFound, ambiguous, lateAllocated] = charges;
    if (!notFound || !ambiguous || !lateAllocated)
      throw new Error("Synthetic charge selection missing");
    const events: PurchaseAgentEvent[] = [];
    const started = await startSelectedChargeRun(
      ctx.db,
      {
        vendorAccountId: account.shortcode,
        transactionIds: charges.map((charge) => charge.transaction.shortcode),
      },
      ctx.actor,
      {
        send: async (event) => {
          events.push(event);
        },
      },
    );
    const [scope] = await database
      .select()
      .from(runTable)
      .where(eq(runTable.shortcode, started.runId));
    if (!scope || events.length !== 1)
      throw new Error("Synthetic selected-charge admission missing");
    const objectives = researchObjectivesOf(scope.input);
    if (!objectives)
      throw new Error("Selected charges were not typed objectives");
    expect(objectives.objectives.map((objective) => objective.kind)).toEqual([
      "charge_hunt",
      "charge_hunt",
      "charge_hunt",
    ]);
    const recorded = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
      vendorAccountId: account.id,
      orderId: "SYNTHETIC-ALREADY-RECORDED",
      date: "2026-09-22",
      displayLabel: "Synthetic allocated purchase",
      statedTotal: 33,
    });
    await insertWithShortcode(ctx.db, "expense", {
      purchaseId: recorded.id,
      name: "Synthetic recorded service",
      cost: 33,
      date: "2026-09-22",
      lineKind: "principal",
      costType: "materials",
      trade: "other",
      future: false,
    });
    // A real member allocation arrives after the frozen discovery admission.
    await updateFinancialTransaction(
      ctx.db,
      lateAllocated.transaction.shortcode,
      { purchaseId: recorded.shortcode },
      ctx.actor,
    );
    const before = {
      purchases: await database.select().from(purchase),
      expenses: await database.select().from(expense),
      transactions: await database.select().from(financialTransaction),
      allocations: await database.select().from(financialTransactionAllocation),
      cursor: (
        await database
          .select()
          .from(vendorAccount)
          .where(eq(vendorAccount.id, account.id))
      )[0]!.cursor,
    };
    await authorizePurchaseAgent(ctx.db, ctx.actor.userId);
    scenarioRunId = scope.id;
    const targets = await database
      .select()
      .from(runTarget)
      .where(eq(runTarget.runId, scope.id))
      .orderBy(asc(runTarget.createdAt), asc(runTarget.id));
    const steps: ScriptStep[] = targets.flatMap((target, index) => {
      const objective = objectives.objectives.find(
        (value) => researchObjectiveKey(value) === target.workKey,
      );
      if (!objective || objective.kind !== "charge_hunt")
        throw new Error("Synthetic charge objective missing");
      const isAmbiguous = objective.huntId === ambiguous.hunt.id;
      return [
        step(`charge-${index}-next`, "work_next"),
        step(`charge-${index}-read`, "web_read", {
          workRef: from(`charge-${index}-next`, "work.workRef"),
          url: `https://charge.example.test/evidence/${index}`,
        }),
        step(`charge-${index}-resolve`, "work_resolve", {
          workRef: from(`charge-${index}-next`, "work.workRef"),
          status: isAmbiguous ? "ambiguous" : "no_source_found",
          identity: {
            evidenceIds: [from(`charge-${index}-read`, "evidenceId")],
            reasoning:
              "The frozen selected charge has no supported order identity on this retained page.",
          },
          progress: {
            scopeExhausted: true,
            evidenceIds: [from(`charge-${index}-read`, "evidenceId")],
            gaps: isAmbiguous
              ? ["Two candidate identities remain unproven."]
              : [],
          },
          detail: isAmbiguous
            ? "Synthetic selected-charge identity remains ambiguous."
            : "Synthetic selected-charge investigation found no supported order.",
        }),
        {
          check: `charge-${index}-resolve`,
          includes: isAmbiguous ? "ambiguous" : "no_source_found",
        },
      ];
    });
    const assessments = [
      {
        match: "frozen selected charge",
        output: { ...noOperands, scopeCompletionVerified: true },
      },
    ];
    scenario = await startScenarioHarness(ctx.databaseUrl, {
      steps,
      assessments,
    });
    const configured = await scenario.harness
      .getWorker("cubby-test-gateway")
      .fetch("https://gateway.test/configure", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          assessments,
          sources: targets.map((_target, index) => ({
            url: `https://charge.example.test/evidence/${index}`,
            title: "Synthetic scoped charge evidence",
            description: "No supported purchase identity.",
            html: "<main>Synthetic charge research: no supported order identity in this scoped source.</main>",
          })),
        }),
      });
    expect({ ok: configured.ok, body: await configured.text() }).toMatchObject({
      ok: true,
    });
    await scenario.dispatch(events[0]!);
    await waitForStatus(scope.id, "needs_review");
    const hunts = await database.select().from(importHunt);
    expect(hunts.find((hunt) => hunt.id === notFound.hunt.id)).toMatchObject({
      state: CHARGE_HUNT_STATE.notFound,
    });
    expect(hunts.find((hunt) => hunt.id === ambiguous.hunt.id)).toMatchObject({
      state: CHARGE_HUNT_STATE.deferred,
    });
    expect(
      hunts.find((hunt) => hunt.id === lateAllocated.hunt.id),
    ).toMatchObject({ state: CHARGE_HUNT_STATE.resolved });
    expect(await database.select().from(purchase)).toEqual(before.purchases);
    expect(await database.select().from(expense)).toEqual(before.expenses);
    expect(await database.select().from(financialTransaction)).toEqual(
      before.transactions,
    );
    expect(
      await database.select().from(financialTransactionAllocation),
    ).toEqual(before.allocations);
    expect(await database.select().from(importSourceOrder)).toEqual([]);
    expect(await database.select().from(inventoryEntry)).toEqual([]);
    expect(
      (
        await database
          .select()
          .from(vendorAccount)
          .where(eq(vendorAccount.id, account.id))
      )[0]!.cursor,
    ).toEqual(before.cursor);
    const progress = await getRunLiveProgress(ctx.db, scope.shortcode);
    if (!progress) throw new Error("Synthetic charge Run progress missing");
    expect(progress.charges).toEqual(
      expect.arrayContaining([
        { chargeId: notFound.transaction.shortcode, outcome: "not_found" },
        { chargeId: ambiguous.transaction.shortcode, outcome: "deferred" },
        { chargeId: lateAllocated.transaction.shortcode, outcome: "resolved" },
      ]),
    );
    expect(progress.charges).toHaveLength(3);
    expect(await scenario.violations()).toEqual([]);
  }, 60_000);
});
