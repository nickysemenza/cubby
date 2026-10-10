import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  executionAuthorizationInput,
  executionAuthorizationReceipt,
} from "@cubby/schemas/execution-authorization";
import {
  parseEntityId,
  runEntityId,
  runShortcode,
} from "@cubby/schemas/identifiers";
import { mailboxDiscoveryInput } from "@cubby/schemas/mailbox-research";
import type { PurchaseAgentEvent } from "@cubby/schemas/purchase-import";
import { mailResearchRunInput } from "@cubby/schemas/run-fields";
import { sha256Hex } from "@cubby/shared/sha256";
import { makeSignature } from "better-auth/crypto";
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
} from "tooling/purchase-agent-script";
import { TEST_HOME_SHORTCODE, withTestDb } from "tooling/test-setup";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { z } from "zod";

import { GMAIL_READONLY_SCOPE } from "~/lib/google-auth-constants";
import { account as googleAccount } from "~/server/db/auth.schema";
import {
  aiUsage,
  expense,
  imageProcessingJob,
  importSourceOrder,
  inventoryEntry,
  mailboxCursor,
  mailboxMessage,
  orderMail,
  photoGroupProposal,
  product,
  purchase,
  run as runTable,
  runOperation,
  runProgress,
  runTarget,
  session,
} from "~/server/db/schema";
import { approvePhotoGroupProposals } from "~/server/photo-import-run/proposals";
import { getDb } from "~/server/repo/database-helpers";
import { updateImageProcessingSettings } from "~/server/repo/image-processing-maintenance";
import {
  createImageFixture,
  createLocationFixture,
  makeLocationInput,
} from "~/server/repo/repo.fixtures";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import { issueExecutionAuthorization } from "~/server/runs/execution-authorization";
import { productionPhotoImportCommitPorts } from "~/server/services/photo-import-commit.service";

import { startMailImport } from "./mail-import-run";
import {
  authorizePurchaseAgent,
  authorizeSyntheticBackfill,
  startScenarioHarness,
  waitFor,
  workerdDiagnostic,
  type ScenarioHarness,
} from "./purchase-agent-workerd.fixtures";
import {
  controlRun,
  finalizePhotoRun,
  startPhotoInventoryCoordinator,
  startPhotoInventoryRun,
} from "./run-service";

// Built-Worker coverage for the two agent purposes: reviewed photo stock, a
// partial Mail import retry, and provider discovery feeding Mail import. Only the model is scripted; the agent, its
// tools, in-process MCP, queue events and writers are production code.
const repoRoot = fileURLToPath(new URL("../../../../../", import.meta.url));

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
  beforeEach(() => {
    identity = captureE2ERunIdentity(repoRoot);
    began = Date.now();
    diagnostic = undefined;
    photoApproval = undefined;
  });
  afterEach(async ({ task }) => {
    const outputDir = path.join(
      repoRoot,
      "artifacts/purchase-agent-scenarios",
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
          "apps/web",
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
  const waitForStatus = (runId: string, status: string) =>
    waitFor(
      async () => (await runRow(runId)).status === status,
      `Run did not settle as ${status}`,
      20_000,
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
      purpose: "mail_import",
      eventId: started.eventId,
    });
    await waitFor(
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
      20_000,
    );
    expect(
      await getDb(ctx.db)
        .select({ id: product.id })
        .from(product)
        .where(eq(product.name, productName)),
    ).toHaveLength(0);
    expect((await runRow(run.id)).status).toBe("running");
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
    expect((await runRow(run.id)).status).toBe("completed");
    const [created, ...extra] = await getDb(ctx.db)
      .select({ id: product.id })
      .from(product)
      .where(eq(product.name, productName));
    if (!created) throw new Error("Approved Product missing");
    expect(extra).toEqual([]);
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

  it("partial mail: retries only unresolved sources after a supported import without replacing prior money or results", async () => {
    const database = getDb(ctx.db);
    const mailboxId = "synthetic-partial-mailbox";
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic partial-source member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Synthetic service shop",
      website: "https://service.example.test",
    });
    const retain = async (
      messageId: string,
      receivedAt: string,
      body: string,
    ) => {
      const checksum = await sha256Hex(body);
      const [mail] = await database
        .insert(orderMail)
        .values({
          ledgerPartyId: party.id,
          mailboxId,
          messageId,
          sender: "orders@service.example.test",
          subject: "Synthetic service inquiry",
          receivedAt: new Date(receivedAt),
          rawChecksum: checksum,
          content: { snippet: null, bodyText: body, bodyHtml: null },
        })
        .returning();
      if (!mail) throw new Error("Synthetic partial source missing");
      await database.insert(mailboxMessage).values({
        ledgerPartyId: party.id,
        mailboxId,
        messageId,
        checksum,
        classification: "related",
        classificationVersion: "synthetic-source-v1",
        status: "pending",
        orderMailId: mail.id,
      });
      return mail;
    };
    // Distinct receipt times fix the order in which Pi claims the Emails.
    const supported = await retain(
      "synthetic-supported-service",
      "2026-09-20T12:00:00Z",
      "Synthetic service shop. SERVICE-1, September 20 2026: annual service, quantity 1, USD 9.00. Total USD 9.00.",
    );
    const ambiguous = await retain(
      "synthetic-ambiguous-source",
      "2026-09-21T12:00:00Z",
      "Synthetic service shop purchase inquiry. Exact order, itemization, date and amount absent.",
    );
    await authorizeSyntheticBackfill(ctx, party.id, mailboxId);
    const events: PurchaseAgentEvent[] = [];
    const queue = {
      send: async (event: PurchaseAgentEvent) => {
        events.push(event);
      },
    };
    const admission = {
      ledgerPartyId: party.id,
      userId: ctx.actor.userId,
      messageIds: [supported.id, ambiguous.id],
    };
    const [started, ...otherRuns] = await startMailImport(
      ctx.db,
      admission,
      queue,
    );
    if (!started || otherRuns.length || events.length !== 1)
      throw new Error("Synthetic partial admission missing");
    const parent = await runRow(started.runId);
    expect(parent.purpose).toBe("mail_import");
    scenarioRunId = parent.id;
    await authorizePurchaseAgent(ctx.db, ctx.actor.userId);

    const unresolvedSteps = (prefix: string, runId: string): ScriptStep[] => [
      call(`${prefix}-claim`, "claim_next_import_work"),
      { check: `${prefix}-claim`, includes: ambiguous.messageId },
      mcpRead(`${prefix}-read`, "imports_read", {
        action: "mail",
        mailboxId,
        messageId: ambiguous.messageId,
      }),
      mcp(`${prefix}-resolve`, "mail", runId, {
        action: "resolve",
        mailboxId,
        messageId: ambiguous.messageId,
        checksum: from(`${prefix}-read`, "checksum"),
        disposition: {
          kind: "unresolved",
          reason:
            "Synthetic unresolved itemization has no supported order or amount.",
        },
      }),
      { check: `${prefix}-resolve`, includes: "unresolved" },
      call(`${prefix}-done`, "claim_next_import_work"),
      { check: `${prefix}-done`, includes: "none" },
    ];
    const externalKey = `gmail:${mailboxId}:${supported.messageId}`;
    scenario = await startScenarioHarness(ctx.databaseUrl, {
      steps: [
        call("supported-claim", "claim_next_import_work"),
        { check: "supported-claim", includes: supported.messageId },
        mcpRead("supported-read", "imports_read", {
          action: "mail",
          mailboxId,
          messageId: supported.messageId,
        }),
        mcp("supported-prepare", "purchase_import", parent.id, {
          action: "prepare",
          orders: [
            {
              vendorId: vendor.shortcode,
              stableOrderId: "service-1",
              itemOperationId: "supported-prepare:service-1",
              source: {
                kind: "mail_message",
                externalKey,
                checksum: from("supported-read", "checksum"),
              },
              evidenceChecksum: from("supported-read", "checksum"),
              extractionRevision: "synthetic@1",
              extraction: {
                status: "ready",
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
              },
              lineIds: ["service-1:line-1"],
              primaryDocumentImageId: null,
              screenshotImageId: null,
            },
          ],
        }),
        mcp("supported-commit", "purchase_import", parent.id, {
          action: "commit",
          prepareOperationId: "supported-prepare",
          defaultTrade: "other",
          resolutions: [
            {
              stableOrderId: "service-1",
              stableLineId: "service-1:line-1",
              resolution: { kind: "expense_only" },
            },
          ],
        }),
        { check: "supported-commit", includes: "created" },
        ...unresolvedSteps("partial", parent.id),
      ],
    });
    await scenario.dispatch(events[0]!);
    await waitForStatus(parent.id, "needs_review");
    expect(await scenario.violations()).toEqual([]);

    const targetsOf = (runId: string) =>
      database
        .select()
        .from(runTarget)
        .where(eq(runTarget.runId, runEntityId.parse(runId)))
        .orderBy(asc(runTarget.position), asc(runTarget.id));
    const settledTargets = await targetsOf(parent.id);
    expect(settledTargets).toHaveLength(2);
    expect(
      settledTargets.find((target) => target.workKey === supported.id),
    ).toMatchObject({ state: "completed", outcome: "verified", warning: null });
    expect(
      settledTargets.find((target) => target.workKey === ambiguous.id),
    ).toMatchObject({
      state: "unresolved",
      outcome: "ambiguous",
      warning:
        "Synthetic unresolved itemization has no supported order or amount.",
    });
    const mailboxRows = () =>
      database
        .select({
          messageId: mailboxMessage.messageId,
          status: mailboxMessage.status,
          runId: mailboxMessage.runId,
        })
        .from(mailboxMessage)
        .where(eq(mailboxMessage.mailboxId, mailboxId))
        .orderBy(asc(mailboxMessage.messageId));
    const ownership = [
      {
        messageId: ambiguous.messageId,
        status: "blocked",
        runId: parent.id,
      },
      {
        messageId: supported.messageId,
        status: "completed",
        runId: parent.id,
      },
    ];
    expect(await mailboxRows()).toEqual(ownership);
    const originalPurchases = await database.select().from(purchase);
    const originalExpenses = await database.select().from(expense);
    const originalAssociations = await database
      .select()
      .from(importSourceOrder);
    expect(originalPurchases).toHaveLength(1);
    expect(originalPurchases[0]).toMatchObject({ orderId: "SERVICE-1" });
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
      purpose: "mail_import",
      predecessorRunId: parent.id,
      ledgerPartyId: party.id,
    });
    // The retry re-claims only the unresolved Email; the imported one stays
    // settled on the parent.
    expect(
      (await targetsOf(child.id)).map(({ workKey, state }) => ({
        workKey,
        state,
      })),
    ).toEqual([{ workKey: ambiguous.id, state: "pending" }]);
    expect((await runRow(parent.id)).input).toEqual(parent.input);
    expect(await targetsOf(parent.id)).toEqual(settledTargets);

    await scenario.configure({
      steps: unresolvedSteps("partial-retry", child.id),
    });
    scenarioRunId = child.id;
    if (!child.dispatchEventId)
      throw new Error("Synthetic retry dispatch generation missing");
    await scenario.dispatch({
      version: 1,
      type: "start_or_resume",
      runId: child.id,
      eventId: child.dispatchEventId,
      purpose: "mail_import",
    });
    await waitForStatus(child.id, "needs_review");
    expect(await scenario.violations()).toEqual([]);
    expect(await targetsOf(child.id)).toMatchObject([
      { workKey: ambiguous.id, state: "unresolved", outcome: "ambiguous" },
    ]);
    expect(await targetsOf(parent.id)).toEqual(settledTargets);
    expect(await database.select().from(purchase)).toEqual(originalPurchases);
    expect(await database.select().from(expense)).toEqual(originalExpenses);
    expect(await database.select().from(importSourceOrder)).toEqual(
      originalAssociations,
    );
    expect(await database.select().from(inventoryEntry)).toEqual([]);
    expect(await mailboxRows()).toEqual(ownership);

    // Replays converge: a second retry returns the same successor, and
    // discovery re-admitting both Emails starts no new Run.
    const replay = await controlRun(ctx.db, ctx.actor, {
      runPublicId: parent.shortcode,
      action: "retry",
    });
    if (!("successorRunId" in replay))
      throw new Error("Synthetic partial replay successor missing");
    expect(replay.successorRunId).toBe(child.id);
    const dispatched = events.length;
    expect(await startMailImport(ctx.db, admission, queue)).toEqual([
      { runId: parent.id, status: "needs_review" },
    ]);
    expect(events).toHaveLength(dispatched);
    expect(
      await database
        .select({ id: runTable.id })
        .from(runTable)
        .where(
          and(
            eq(runTable.ledgerPartyId, party.id),
            eq(runTable.purpose, "mail_import"),
          ),
        ),
    ).toHaveLength(2);
  }, 60_000);

  it("provider discovery: pages archived Gmail through Jev and real queues, keeps unrelated mail private, and Pi imports the order", async () => {
    const database = getDb(ctx.db);
    const mailboxId = "synthetic-google-user";
    const sourceText =
      "Example Works order SYNTHETIC-410 confirmed September 14 2026: Example Works F17SB desk fan, quantity 1, USD 24.00. Total USD 24.00.";
    const unrelatedText =
      "Synthetic picnic invitation with no acquisition or payment.";
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic discovery member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Example Works",
      website: "https://maker.example.test",
    });
    await authorizePurchaseAgent(ctx.db, ctx.actor.userId);
    await database.insert(googleAccount).values({
      id: crypto.randomUUID(),
      accountId: mailboxId,
      providerId: "google",
      userId: ctx.actor.userId,
      accessToken: "synthetic-mail-access",
      refreshToken: "synthetic-mail-refresh",
      scope: GMAIL_READONLY_SCOPE,
      accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
    });
    const approve = (
      scope: z.input<typeof executionAuthorizationInput>["scope"],
      period: "lifetime" | "utc_calendar_month",
    ) =>
      issueExecutionAuthorization(
        ctx.db,
        ctx.actor,
        executionAuthorizationInput.parse({
          kind: "execution_authorization",
          version: 1,
          owner: { userId: ctx.actor.userId, ledgerPartyId: party.id },
          scope,
          meteredBudget: { period, limitMicroUSD: 1_000_000 },
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        }),
      );
    const approval = await approve(
      { kind: "backfill", mailboxId, discovery: "all_history" },
      "lifetime",
    );
    const continuousApproval = await approve(
      { kind: "continuous", mailboxId, discovery: "new_mail" },
      "utc_calendar_month",
    );
    const gmailMessage = (
      id: string,
      thread: string,
      receivedAt: string,
      from: string,
      subject: string,
      text: string,
    ) => ({
      id,
      threadId: thread,
      historyId: "100",
      labelIds: [],
      internalDate: String(Date.parse(receivedAt)),
      payload: {
        mimeType: "text/plain",
        headers: [
          { name: "From", value: from },
          { name: "Subject", value: subject },
        ],
        body: {
          data: Buffer.from(text).toString("base64url"),
          size: Buffer.byteLength(text),
        },
      },
    });
    const original = gmailMessage(
      "synthetic-confirmation",
      "synthetic-fan-thread",
      "2026-09-14T12:00:00Z",
      "receipts@maker.example.test",
      "Synthetic fan order",
      sourceText,
    );
    const unrelated = gmailMessage(
      "synthetic-unrelated",
      "synthetic-social-thread",
      "2026-09-13T12:00:00Z",
      "friends@social.example.test",
      "Synthetic picnic invitation",
      unrelatedText,
    );
    scenario = await startScenarioHarness(
      ctx.databaseUrl,
      {
        steps: [
          call("fan-claim", "claim_next_import_work"),
          { check: "fan-claim", includes: original.id },
          mcpRead("fan-read", "imports_read", {
            action: "mail",
            mailboxId,
            messageId: original.id,
          }),
          mcp(
            "fan-prepare",
            "purchase_import",
            { $runId: true },
            {
              action: "prepare",
              orders: [
                {
                  vendorId: vendor.shortcode,
                  stableOrderId: "synthetic-410",
                  itemOperationId: "fan-prepare:synthetic-410",
                  source: {
                    kind: "mail_message",
                    externalKey: `gmail:${mailboxId}:${original.id}`,
                    checksum: from("fan-read", "checksum"),
                  },
                  evidenceChecksum: from("fan-read", "checksum"),
                  extractionRevision: "synthetic@1",
                  extraction: {
                    status: "ready",
                    candidate: {
                      orderId: "SYNTHETIC-410",
                      orderedAt: "2026-09-14T12:00:00.000Z",
                      merchant: vendor.name,
                      currency: "USD",
                      printedGrandTotal: 24,
                      lines: [
                        {
                          title: "Example Works F17SB desk fan",
                          quantity: 1,
                          amount: 24,
                          lineKind: "principal",
                        },
                      ],
                      payments: [],
                      allShipmentsDelivered: false,
                    },
                  },
                  lineIds: ["synthetic-410:line-1"],
                  primaryDocumentImageId: null,
                  screenshotImageId: null,
                },
              ],
            },
          ),
          mcp(
            "fan-commit",
            "purchase_import",
            { $runId: true },
            {
              action: "commit",
              prepareOperationId: "fan-prepare",
              defaultTrade: "other",
              resolutions: [
                {
                  stableOrderId: "synthetic-410",
                  stableLineId: "synthetic-410:line-1",
                  resolution: { kind: "new" },
                },
              ],
            },
          ),
          { check: "fan-commit", includes: "created" },
          call("fan-done", "claim_next_import_work"),
          { check: "fan-done", includes: "none" },
        ],
        decisions: [
          {
            feature: "mailbox-triage",
            match: "Synthetic picnic invitation",
            label: "unrelated",
          },
          {
            feature: "mailbox-triage",
            match: "SYNTHETIC-410",
            label: "related",
          },
        ],
      },
      "gmail-research",
    );
    const google = scenario.googleProvider;
    if (!google) throw new Error("Gmail profile has no external provider.");
    google.configure({
      email: "synthetic-researcher@example.test",
      message: original,
      classification: { events: [] },
      mailbox: {
        historyId: "100",
        messages: [unrelated, original],
        pages: [[unrelated.id], [unrelated.id, original.id]],
        history: [],
      },
    });

    // The member's app-launch catch-up starts discovery; nothing is seeded.
    const token = `synthetic-discovery-http-${crypto.randomUUID()}`;
    const now = new Date();
    await database.insert(session).values({
      id: crypto.randomUUID(),
      token,
      userId: ctx.actor.userId,
      expiresAt: new Date(now.getTime() + 300_000),
      createdAt: now,
      updatedAt: now,
    });
    const signature = await makeSignature(
      token,
      process.env.BETTER_AUTH_SECRET || "e2e-test-secret",
    );
    const response = await fetch(
      `${scenario.origin}/api/v1/maintenance/requestCatchUp`,
      {
        method: "POST",
        headers: {
          cookie: `better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`,
          origin: scenario.origin,
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      },
    );
    expect({ status: response.status, body: await response.json() }).toEqual({
      status: 200,
      body: { status: "queued" },
    });

    const mailRuns = () =>
      database
        .select()
        .from(runTable)
        .where(
          and(
            eq(runTable.purpose, "mail_import"),
            eq(runTable.ledgerPartyId, party.id),
          ),
        );
    await waitFor(
      async () => (await mailRuns()).length > 0,
      "Provider discovery did not admit a Mail import Run.",
      30_000,
    );
    const [admitted] = await mailRuns();
    scenarioRunId = admitted!.id;
    await waitForStatus(admitted!.id, "completed");
    expect(await scenario.violations()).toEqual([]);
    const importRun = await runRow(admitted!.id);
    if (!importRun.parentRunId) throw new Error("Discovery parent missing.");
    await waitFor(
      async () => {
        const [cursor] = await database
          .select()
          .from(mailboxCursor)
          .where(
            and(
              eq(mailboxCursor.ledgerPartyId, party.id),
              eq(mailboxCursor.mailboxId, mailboxId),
            ),
          );
        return (
          cursor?.coverage?.broad.completed === true &&
          (await runRow(importRun.parentRunId!)).status === "completed"
        );
      },
      "Gmail Workflow did not checkpoint complete broad pagination.",
      30_000,
    );
    const discovery = await runRow(importRun.parentRunId);
    expect(discovery.purpose).toBe("mail_discovery");
    expect(
      mailboxDiscoveryInput.parse(discovery.input).executionAuthorization,
    ).toEqual(approval);
    expect(
      mailResearchRunInput.parse(importRun.input).executionAuthorization,
    ).toEqual(approval);
    expect(await mailRuns()).toHaveLength(1);

    // Only the related original is retained; the unrelated message keeps
    // its provider identity and no content.
    const retained = await database.select().from(orderMail);
    expect(retained).toHaveLength(1);
    expect(retained[0]).toMatchObject({
      mailboxId,
      messageId: original.id,
      content: { bodyText: sourceText },
    });
    const ledger = await database
      .select()
      .from(mailboxMessage)
      .where(eq(mailboxMessage.mailboxId, mailboxId));
    expect(ledger).toHaveLength(2);
    expect(
      ledger.find((message) => message.messageId === unrelated.id),
    ).toMatchObject({
      classification: "unrelated",
      status: "completed",
      orderMailId: null,
      runId: null,
    });
    expect(
      ledger.find((message) => message.messageId === original.id),
    ).toMatchObject({
      classification: "related",
      status: "completed",
      orderMailId: retained[0]!.id,
      checksum: retained[0]!.rawChecksum,
      runId: importRun.id,
    });
    expect(
      await database
        .select({ workKey: runTarget.workKey, state: runTarget.state })
        .from(runTarget)
        .where(eq(runTarget.runId, importRun.id)),
    ).toEqual([{ workKey: retained[0]!.id, state: "completed" }]);

    // Pi's commit wrote one Purchase, one Expense and its Product, and no stock.
    const purchases = await database.select().from(purchase);
    const expenses = await database.select().from(expense);
    expect(purchases).toHaveLength(1);
    expect(purchases[0]).toMatchObject({
      orderId: "SYNTHETIC-410",
      vendorId: vendor.id,
      statedTotal: 24,
    });
    expect(expenses).toHaveLength(1);
    expect(expenses[0]).toMatchObject({
      purchaseId: purchases[0]!.id,
      cost: 24,
      productQuantity: 1,
    });
    expect(expenses[0]!.productId).not.toBeNull();
    const sourceOrders = await database.select().from(importSourceOrder);
    expect(sourceOrders).toHaveLength(1);
    expect(sourceOrders[0]?.originalOrder?.checksum).toBe(
      retained[0]!.rawChecksum,
    );
    expect(await database.select().from(inventoryEntry)).toEqual([]);

    // Provider traffic: a profile baseline, then both pages of the
    // Spam/Trash-excluded listing; the continuous grant resumes from it.
    await waitFor(
      async () =>
        google
          .requests()
          .some(
            (request) =>
              request.path.endsWith("/history") &&
              request.query.startHistoryId === "100",
          ),
      "Separately authorized continuous discovery did not reach the saved history baseline.",
    );
    const [historyRun] = await database
      .select()
      .from(runTable)
      .where(eq(runTable.clientKey, `mailbox-continuation:${discovery.id}`));
    expect(
      mailboxDiscoveryInput.parse(historyRun?.input).executionAuthorization,
    ).toEqual(continuousApproval);
    const requests = google.requests();
    const baselineIndex = requests.findIndex((request) =>
      request.path.endsWith("/profile"),
    );
    expect(baselineIndex).toBeGreaterThanOrEqual(0);
    expect(
      requests.findIndex((request) => request.path.endsWith("/messages")),
    ).toBeGreaterThan(baselineIndex);
    expect(
      requests
        .filter(
          (request) =>
            request.path.endsWith("/messages") &&
            request.query.q === "-in:spam -in:trash",
        )
        .map((request) => request.query.pageToken ?? null),
    ).toEqual([null, "synthetic-page-1"]);
    expect(
      requests.filter((request) =>
        request.path.endsWith(`/messages/${unrelated.id}`),
      ),
    ).toHaveLength(2);
    expect(
      requests.filter((request) =>
        request.path.endsWith(`/messages/${original.id}`),
      ),
    ).toHaveLength(1);
    expect(
      (await scenario.gatewayCalls())
        .filter((entry) => entry.feature === "mailbox-triage")
        .map((entry) => entry.matched),
    ).toEqual(["unrelated", "related"]);

    // Each paid call reserves once against the backfill approval.
    const reservations = (
      await database
        .select({ result: runOperation.result })
        .from(runOperation)
        .where(
          and(
            eq(runOperation.runId, approval.runId),
            eq(runOperation.kind, "execution_authorization"),
          ),
        )
    )
      .map(({ result }) => executionAuthorizationReceipt.parse(result))
      .filter((receipt) => receipt.kind === "metered_reservation");
    expect(reservations.length).toBeGreaterThan(0);
    expect(
      new Set(reservations.map((receipt) => receipt.physicalAttemptId)).size,
    ).toBe(reservations.length);
    expect(reservations.every((receipt) => receipt.reservedMicroUSD > 0)).toBe(
      true,
    );
  }, 120_000);
});
