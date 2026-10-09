import {
  imageId as parseImageId,
  runEntityId,
} from "@cubby/schemas/identifiers";
import {
  acceptedSourceOrder,
  purchaseAgentEvent,
} from "@cubby/schemas/purchase-import";
import {
  runSummary,
  targetedImportStartInput,
  targetedImportStartOutput,
} from "@cubby/schemas/run";
import { productResearchRunInput } from "@cubby/schemas/run-fields";
import { sha256Hex } from "@cubby/shared/sha256";
import { fromPartial } from "@total-typescript/shoehorn";
import { and, eq, sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { afterEach, describe, expect, it } from "vitest";

import { setCfEnv } from "~/server/cf-env";
import {
  aiUsage,
  auditLog,
  runTarget,
  run as runTable,
  runFactEvidence,
  importSourceClaim,
  importSourceOrder,
  vendor,
  expense,
  importSourceProduct,
} from "~/server/db/schema";
import { runHandlers } from "~/server/operations/run.server";
import { getDb } from "~/server/repo/database-helpers";
import {
  createProductFixture,
  makeProductInput,
} from "~/server/repo/repo.fixtures";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import { requireActor } from "~/server/request-context";
import { createTestRequestContext } from "~/server/testing/request-context";

import { productResearchFixture } from "./product-research.fixtures";
import { loadProductPurchaseContext } from "./research-context";
import { researchServiceFor } from "./research-service";
import { startOrResumeRun, startPhotoInventoryRun } from "./run-service";
import {
  listRuns,
  reportRunTargetDeviceWork,
  resolvePurchaseImportTarget,
} from "./run-target";
import { loadTargetedImportLaunch } from "./targeted-run";

// Manual launch failures: old untyped admission, a URL/Mac prerequisite,
// dropped source authority, mismatched/foreign context, and filled-but-unproved
// facts being mistaken for verified completion. Browser preference is optional.
// Historical aliases must expose current source identity while retaining the
// accepted evidence version. Stale aliases cannot be offered as replayable work.
describe("manual Product research admission", () => {
  const ctx = withTestDb();
  afterEach(() => setCfEnv(undefined));

  it("admits a manual owned-source Product through current cloud research even when existing facts lack provenance and no Mac or URL exists", async () => {
    const f = await productResearchFixture(ctx.db, ctx.actor, {
      complete: true,
    });
    if (!f.association) throw new Error("Synthetic source association missing");
    const events: unknown[] = [];
    const environment = fromPartial<Env>({
      PURCHASE_AGENT_QUEUE: {
        send: async (event: unknown) => {
          events.push(purchaseAgentEvent.parse(event));
        },
      },
    });
    setCfEnv(environment);
    const context = {
      ...requireActor(
        createTestRequestContext(ctx.db, {
          auth: { userId: ctx.actor.userId },
        }),
      ),
      signal: new AbortController().signal,
    };
    const input = targetedImportStartInput.parse({
      purpose: "product_enrichment",
      targets: [{ productId: f.item.id, sourceId: f.association.id }],
    });
    const launched = targetedImportStartOutput.parse(
      await runHandlers.runs.startTargeted!.run(context, input),
    );
    const [admission] = launched.runs;
    expect(admission?.created).toBe(true);
    if (!admission?.run) throw new Error("Manual research Run missing");
    const runId = await resolveOrThrow(ctx.db, "run", admission.run.id);
    const [saved] = await getDb(ctx.db)
      .select()
      .from(runTable)
      .where(eq(runTable.id, runId));
    if (!saved) throw new Error("Admitted research Run missing");
    expect(productResearchRunInput.parse(saved.input)).toMatchObject({
      kind: "product_research",
      products: [{ productId: f.item.entityId }],
    });
    expect(saved).toMatchObject({
      ledgerPartyId: f.party.id,
      actorUserId: ctx.actor.userId,
      vendorId: null,
      vendorAccountId: null,
      cause: "member_request",
      status: "running",
    });
    const next = await researchServiceFor(
      ctx.db,
      environment,
      runId,
    ).researchNext({}, crypto.randomUUID());
    expect(next).toMatchObject({
      status: "working",
      work: {
        kind: "product",
        product: { productRef: f.item.id },
        purchasedItems: [
          {
            order: { purchaseRef: f.order.shortcode },
            currentLine: { name: "Small Q-17 device" },
            source: { sourceRef: f.association.id },
          },
        ],
      },
    });
    expect(await getDb(ctx.db).select().from(runFactEvidence)).toEqual([]);
    expect(events).toHaveLength(1);
    const replay = await runHandlers.runs.startTargeted!.run(context, input);
    expect(replay).toMatchObject({
      runs: [
        { created: false, run: null, blockingRun: { id: admission.run.id } },
      ],
    });
    expect(events).toHaveLength(1);
    expect(
      await getDb(ctx.db)
        .select()
        .from(runTarget)
        .where(eq(runTarget.runId, runId)),
    ).toHaveLength(1);
  });
  it("previews and admits a source-independent member request without inventing purchased context", async () => {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Example requesting member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const item = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Example shared catalog device" }),
      ctx.actor,
    );
    const preview = await loadTargetedImportLaunch(
      ctx.db,
      party.id,
      "product_enrichment",
      item.id,
    );
    expect(preview.products).toMatchObject([
      {
        selected: true,
        sourceId: null,
        vendorAccountId: null,
        needsAccountChoice: false,
      },
    ]);
    setCfEnv(
      fromPartial<Env>({
        PURCHASE_AGENT_QUEUE: {
          send: async (event: unknown) => {
            purchaseAgentEvent.parse(event);
          },
        },
      }),
    );
    const context = {
      ...requireActor(
        createTestRequestContext(ctx.db, {
          auth: { userId: ctx.actor.userId },
        }),
      ),
      signal: new AbortController().signal,
    };
    const started = targetedImportStartOutput.parse(
      await runHandlers.runs.startTargeted!.run(
        context,
        targetedImportStartInput.parse({
          purpose: "product_enrichment",
          targets: [{ productId: item.id, sourceId: null }],
        }),
      ),
    );
    if (!started.runs[0]?.run) throw new Error("Member-request Run missing");
    const id = await resolveOrThrow(ctx.db, "run", started.runs[0].run.id);
    expect(
      await researchServiceFor(ctx.db, fromPartial<Env>({}), id).researchNext(
        {},
        crypto.randomUUID(),
      ),
    ).toMatchObject({
      status: "working",
      work: { kind: "product", purchasedItems: [] },
    });
  });
  it.each(["owned", "foreign"] as const)(
    "#1761 previews and starts with the same optional %s browser transport",
    async (ownership) => {
      const f = await productResearchFixture(ctx.db, ctx.actor);
      if (!f.association || !f.order.vendorId)
        throw new Error("Synthetic source missing");
      const owner =
        ownership === "owned"
          ? f.party
          : await insertWithShortcode(ctx.db, "ledgerParty", {
              name: "Other browser owner",
              kind: "member",
            });
      const account = await insertWithShortcode(ctx.db, "vendorAccount", {
        label: "Example Chrome transport",
        vendorId: f.order.vendorId,
        ledgerPartyId: owner.id,
        browser: "chrome",
        browserSyncEnabled: true,
      });
      const preview = await loadTargetedImportLaunch(
        ctx.db,
        f.party.id,
        "product_enrichment",
        f.item.id,
      );
      expect(preview.products).toMatchObject([
        {
          selected: true,
          sourceId: f.association.id,
          vendorAccountId: ownership === "owned" ? account.shortcode : null,
        },
      ]);
      setCfEnv(
        fromPartial<Env>({
          PURCHASE_AGENT_QUEUE: {
            send: async (event: unknown) => {
              purchaseAgentEvent.parse(event);
            },
          },
        }),
      );
      const context = {
        ...requireActor(
          createTestRequestContext(ctx.db, {
            auth: { userId: ctx.actor.userId },
          }),
        ),
        signal: new AbortController().signal,
      };
      const started = targetedImportStartOutput.parse(
        await runHandlers.runs.startTargeted!.run(
          context,
          targetedImportStartInput.parse({
            purpose: "product_enrichment",
            targets: [{ productId: f.item.id, sourceId: f.association.id }],
          }),
        ),
      );
      if (!started.runs[0]?.run)
        throw new Error("Research transport Run missing");
      const id = await resolveOrThrow(ctx.db, "run", started.runs[0].run.id);
      const [saved] = await getDb(ctx.db)
        .select()
        .from(runTable)
        .where(eq(runTable.id, id));
      expect(saved?.vendorAccountId).toBe(
        ownership === "owned" ? account.id : null,
      );
      expect(productResearchRunInput.parse(saved?.input).kind).toBe(
        "product_research",
      );
    },
  );
  it("previews and admits an accepted original Product binding after its editable Expense is removed", async () => {
    const f = await productResearchFixture(ctx.db, ctx.actor);
    if (!f.association) throw new Error("Synthetic source missing");
    const original = acceptedSourceOrder.parse({
      checksum: f.association.checksum,
      extraction: {
        status: "ready",
        candidate: {
          orderId: "SYNTHETIC-ORDER",
          orderedAt: null,
          merchant: "Example seller",
          currency: "USD",
          printedGrandTotal: null,
          lines: [
            {
              title: "Original small Q-17 device",
              amount: 24,
              lineKind: "principal",
            },
          ],
          payments: [],
          allShipmentsDelivered: false,
        },
      },
    });
    await getDb(ctx.db)
      .update(importSourceOrder)
      .set({ originalOrder: original })
      .where(eq(importSourceOrder.id, f.association.id));
    await getDb(ctx.db).insert(importSourceProduct).values({
      sourceOrderId: f.association.id,
      lineIndex: 0,
      productId: f.item.entityId,
    });
    await getDb(ctx.db)
      .delete(expense)
      .where(eq(expense.purchaseId, f.order.id));
    const preview = await loadTargetedImportLaunch(
      ctx.db,
      f.party.id,
      "product_enrichment",
      f.item.id,
    );
    expect(preview.products).toMatchObject([
      { selected: true, sourceId: f.association.id },
    ]);
    setCfEnv(
      fromPartial<Env>({
        PURCHASE_AGENT_QUEUE: {
          send: async (event: unknown) => {
            purchaseAgentEvent.parse(event);
          },
        },
      }),
    );
    const context = {
      ...requireActor(
        createTestRequestContext(ctx.db, {
          auth: { userId: ctx.actor.userId },
        }),
      ),
      signal: new AbortController().signal,
    };
    const started = targetedImportStartOutput.parse(
      await runHandlers.runs.startTargeted!.run(
        context,
        targetedImportStartInput.parse({
          purpose: "product_enrichment",
          targets: [{ productId: f.item.id, sourceId: f.association.id }],
        }),
      ),
    );
    if (!started.runs[0]?.run)
      throw new Error("Original source research missing");
    const id = await resolveOrThrow(ctx.db, "run", started.runs[0].run.id);
    expect(
      await researchServiceFor(ctx.db, fromPartial<Env>({}), id).researchNext(
        {},
        crypto.randomUUID(),
      ),
    ).toMatchObject({
      work: {
        purchasedItems: [
          {
            orderedLine: { title: "Original small Q-17 device" },
            source: { sourceRef: f.association.id },
          },
        ],
      },
    });
  });
  it.each([true, false])(
    "projects canonical identity and accepted evidence separately when the original is current: %s",
    async (current) => {
      const f = await productResearchFixture(ctx.db, ctx.actor);
      if (!f.association)
        throw new Error("Synthetic source association missing");
      const [owner] = await getDb(ctx.db)
        .select()
        .from(importSourceClaim)
        .where(eq(importSourceClaim.id, f.association.sourceClaimId));
      if (!owner) throw new Error("Synthetic historical source owner missing");
      const currentChecksum = current
        ? owner.checksum
        : await sha256Hex("refreshed original containing another order");
      const [root] = await getDb(ctx.db)
        .insert(importSourceClaim)
        .values({
          ledgerPartyId: owner.ledgerPartyId,
          kind: owner.kind,
          externalKey: "gmail:synthetic-mailbox:original-message",
          checksum: currentChecksum,
          firstRunId: owner.firstRunId,
          lastRunId: owner.lastRunId,
        })
        .returning();
      if (!root) throw new Error("Synthetic canonical source missing");
      await getDb(ctx.db)
        .update(importSourceClaim)
        .set({ canonicalClaimId: root.id })
        .where(eq(importSourceClaim.id, owner.id));

      const preview = await loadTargetedImportLaunch(
        ctx.db,
        f.party.id,
        "product_enrichment",
        f.item.id,
      );
      expect(preview.products).toMatchObject([
        {
          sourceId: current ? f.association.id : null,
          sourceLabel: current ? `mail message · ${root.externalKey}` : null,
        },
      ]);
      expect(
        await loadProductPurchaseContext(ctx.db, {
          productId: f.item.entityId,
          ledgerPartyId: f.party.id,
        }),
      ).toMatchObject([
        {
          currentLine: { name: "Small Q-17 device" },
          source: {
            sourceRef: f.association.id,
            externalKey: root.externalKey,
            checksum: f.association.checksum,
            currentChecksum,
          },
        },
      ]);
      expect(
        await getDb(ctx.db)
          .select()
          .from(importSourceOrder)
          .where(eq(importSourceOrder.id, f.association.id)),
      ).toEqual([f.association]);
    },
  );
  it.each([
    "foreign",
    "mismatched",
    "deleted",
    "changed_checksum",
    "changed_canonical_checksum",
  ] as const)(
    "refuses a supplied %s source association before manual Product admission",
    async (problem) => {
      const f = await productResearchFixture(ctx.db, ctx.actor);
      if (!f.association || !f.order.vendorId)
        throw new Error("Synthetic source missing");
      setCfEnv(
        fromPartial<Env>({ PURCHASE_AGENT_QUEUE: { send: async () => {} } }),
      );
      await getDb(ctx.db)
        .update(vendor)
        .set({
          website: "https://shop.example.test",
          browserDomains: ["shop.example.test"],
        })
        .where(eq(vendor.id, f.order.vendorId));
      let selected = f.item.id;
      if (problem === "foreign") {
        const other = await insertWithShortcode(ctx.db, "ledgerParty", {
          name: "Other synthetic source owner",
          kind: "member",
        });
        await getDb(ctx.db)
          .update(importSourceClaim)
          .set({ ledgerPartyId: other.id })
          .where(eq(importSourceClaim.id, f.association.sourceClaimId));
      } else if (problem === "mismatched") {
        const unrelated = await createProductFixture(
          ctx.db,
          makeProductInput({
            name: "Other synthetic Product",
            manufacturer: "Example maker",
          }),
          ctx.actor,
        );
        selected = unrelated.id;
      } else if (problem === "deleted") {
        await getDb(ctx.db)
          .delete(importSourceOrder)
          .where(eq(importSourceOrder.id, f.association.id));
      } else if (problem === "changed_canonical_checksum") {
        const [owner] = await getDb(ctx.db)
          .select()
          .from(importSourceClaim)
          .where(eq(importSourceClaim.id, f.association.sourceClaimId));
        if (!owner)
          throw new Error("Synthetic historical source owner missing");
        const [root] = await getDb(ctx.db)
          .insert(importSourceClaim)
          .values({
            ledgerPartyId: owner.ledgerPartyId,
            kind: owner.kind,
            externalKey: "synthetic:canonical-current-original",
            checksum: await sha256Hex(
              "new original bytes for another consolidated order",
            ),
            firstRunId: owner.firstRunId,
            lastRunId: owner.lastRunId,
          })
          .returning();
        if (!root) throw new Error("Synthetic canonical source missing");
        await getDb(ctx.db)
          .update(importSourceClaim)
          .set({ canonicalClaimId: root.id })
          .where(eq(importSourceClaim.id, owner.id));
      } else {
        await getDb(ctx.db)
          .update(importSourceClaim)
          .set({ checksum: await sha256Hex("changed synthetic receipt bytes") })
          .where(eq(importSourceClaim.id, f.association.sourceClaimId));
      }
      const input = targetedImportStartInput.parse({
        purpose: "product_enrichment",
        targets: [{ productId: selected, sourceId: f.association.id }],
      });
      const context = {
        ...requireActor(
          createTestRequestContext(ctx.db, {
            auth: { userId: ctx.actor.userId },
          }),
        ),
        signal: new AbortController().signal,
      };
      await expect(
        runHandlers.runs.startTargeted!.run(context, input),
      ).rejects.toThrow(/source.*contains|source.*current|current.*source/u);
      expect(
        await getDb(ctx.db)
          .select()
          .from(runTable)
          .where(eq(runTable.purpose, "product_enrichment")),
      ).toEqual([]);
      expect(await getDb(ctx.db).select().from(runTarget)).toEqual([]);
    },
  );
});

describe("purchase import run target resolution", () => {
  const ctx = withTestDb();

  it("resolves a Purchase shortcode to the mutation run target", async () => {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Import target test member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: `Import target vendor ${crypto.randomUUID()}`,
      website: "https://shop.example.test",
      browserDomains: ["shop.example.test"],
    });
    const account = await insertWithShortcode(ctx.db, "vendorAccount", {
      label: "Import target account",
      vendorId: vendor.id,
      ledgerPartyId: party.id,
    });
    const run = await startOrResumeRun(ctx.db, {
      ledgerPartyId: party.id,
      vendorAccountId: account.id,
      trigger: "manual",
    });
    const purchase = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
      date: "2026-09-20",
      displayLabel: "Imported target purchase",
    });
    await getDb(ctx.db)
      .insert(auditLog)
      .values({
        runId: run.id,
        entityKind: "purchase",
        entityId: purchase.id,
        action: "create",
        changes: { displayLabel: { from: null, to: null } },
        userId: ctx.actor.userId,
        channel: "mcp",
      });
    const untouchedVendor = await insertWithShortcode(ctx.db, "vendor", {
      name: `Untouched target vendor ${crypto.randomUUID()}`,
      website: "https://other.example.test",
      browserDomains: ["other.example.test"],
    });
    const untouchedAccount = await insertWithShortcode(
      ctx.db,
      "vendorAccount",
      {
        label: "Untouched target account",
        vendorId: untouchedVendor.id,
        ledgerPartyId: party.id,
      },
    );
    await startOrResumeRun(ctx.db, {
      ledgerPartyId: party.id,
      vendorAccountId: untouchedAccount.id,
      trigger: "manual",
    });

    const targetId = await resolvePurchaseImportTarget(
      ctx.db,
      purchase.shortcode,
    );
    const [mutation] = await getDb(ctx.db)
      .select({ runId: auditLog.runId })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.entityKind, "purchase"),
          eq(auditLog.entityId, targetId!),
        ),
      );

    expect(targetId).toBe(purchase.id);
    expect(mutation?.runId).toBe(run.id);

    const runs = await listRuns(ctx.db, party.id, targetId!);
    expect(runs.map((row) => row.id)).toEqual([run.id]);
  });
});

// A left join with no calls is free; actual unpriced calls make the whole
// subtotal unknown, including when a priced call is present.
describe("import run summary pricing", () => {
  const ctx = withTestDb();
  it.each([
    { costs: [], expected: 0 },
    { costs: [0.125, 0.25], expected: 0.375 },
    { costs: [null], expected: null },
    { costs: [0.125, null], expected: null },
  ])("preserves spend for $costs", async ({ costs, expected }) => {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic pricing member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const run = await startPhotoInventoryRun(ctx.db, {
      ledgerPartyId: party.id,
      actorUserId: ctx.actor.userId,
    });
    if (costs.length)
      await getDb(ctx.db)
        .insert(aiUsage)
        .values(
          costs.map((estimatedCost): typeof aiUsage.$inferInsert => ({
            feature: "synthetic",
            provider: "openai",
            model: "gpt-6-sol",
            operation: "synthetic.summary",
            runId: runEntityId.parse(run.id),
            durationMs: 1,
            transport: "gateway",
            estimatedCost,
          })),
        );
    const [summary] = await listRuns(ctx.db, party.id);
    expect(summary?.estimatedCost).toBe(expected);
    expect(
      runSummary.parse({
        ...summary,
        startedAt: summary!.startedAt.toISOString(),
        endedAt: summary!.endedAt?.toISOString() ?? null,
      }).estimatedCost,
    ).toBe(summary!.estimatedCost);
  });
});

describe("run target entity reference", () => {
  const ctx = withTestDb();

  // A target names one purchase, product or image; the kind CHECK is the only
  // thing keeping a run worklist from pointing at any other entity.
  it("refuses an entityKind outside purchase, product and image", async () => {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Run target kind test member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const run = await startPhotoInventoryRun(ctx.db, {
      ledgerPartyId: party.id,
      actorUserId: ctx.actor.userId,
    });
    const recipe = await insertWithShortcode(ctx.db, "recipe", {
      name: "Run target kind recipe",
    });
    await expect(
      getDb(ctx.db).execute(
        sql`INSERT INTO "RunTarget" ("runId", "entityId", "entityKind", "targetFingerprint")
            VALUES (${run.id}, ${recipe.id}, 'recipe', 'kind-test-fingerprint')`,
      ),
    ).rejects.toMatchObject({
      cause: { constraint: "RunTarget_entityKind_check" },
    });
  });
});

describe("run.reportDeviceWork", () => {
  const ctx = withTestDb();

  async function seedPhotoRunTarget() {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Device work test member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const run = await startPhotoInventoryRun(ctx.db, {
      ledgerPartyId: party.id,
      actorUserId: ctx.actor.userId,
    });
    const runRow = await getDb(ctx.db).query.run.findFirst({
      where: (table, { eq }) => eq(table.id, run.id),
      columns: { shortcode: true },
    });
    const image = await insertWithShortcode(ctx.db, "image", {
      key: `test-photos/${crypto.randomUUID()}.jpg`,
      filename: "device-work.jpg",
      contentType: "image/jpeg",
      size: 100,
      status: "UPLOADED",
    });
    await getDb(ctx.db)
      .insert(runTarget)
      .values({
        runId: runEntityId.parse(run.id),
        entityKind: "image",
        entityId: parseImageId.parse(image.id),
        targetFingerprint: "device-work-test-fingerprint",
      });
    return { runShortcode: runRow!.shortcode, imageShortcode: image.shortcode };
  }

  it("is idempotent on a repeated report", async () => {
    const { runShortcode, imageShortcode } = await seedPhotoRunTarget();
    const first = await reportRunTargetDeviceWork(ctx.db, {
      run: runShortcode,
      image: imageShortcode,
      state: "running",
    });
    expect(first).toEqual({ recorded: true });

    const second = await reportRunTargetDeviceWork(ctx.db, {
      run: runShortcode,
      image: imageShortcode,
      state: "running",
    });
    expect(second).toEqual({ recorded: true });

    const [row] = await getDb(ctx.db)
      .select({
        deviceWorkState: runTarget.deviceWorkState,
        deviceWorkAttempts: runTarget.deviceWorkAttempts,
      })
      .from(runTarget);
    // Repeating the same state must not double-count an attempt.
    expect(row?.deviceWorkState).toBe("running");
    expect(row?.deviceWorkAttempts).toBe(0);
  });

  it("rejects a caller with no linked member ledger party", async () => {
    const context = {
      ...requireActor(
        createTestRequestContext(ctx.db, {
          auth: { userId: ctx.actor.userId },
        }),
      ),
      signal: new AbortController().signal,
    };
    await expect(
      runHandlers.runs.reportDeviceWork!.run(context, {
        run: "RUN-0000",
        image: "IMG-0000",
        state: "queued",
      }),
    ).rejects.toThrow(/not linked to a member ledger party/);
  });

  it("rejects an image that is not a target of the run", async () => {
    const { runShortcode } = await seedPhotoRunTarget();
    const otherImage = await insertWithShortcode(ctx.db, "image", {
      key: `test-photos/${crypto.randomUUID()}.jpg`,
      filename: "unrelated.jpg",
      contentType: "image/jpeg",
      size: 100,
      status: "UPLOADED",
    });
    await expect(
      reportRunTargetDeviceWork(ctx.db, {
        run: runShortcode,
        image: otherImage.shortcode,
        state: "queued",
      }),
    ).rejects.toThrow(/no photo target/);
  });

  it("increments attempts only on transition into failed, not on repeats", async () => {
    const { runShortcode, imageShortcode } = await seedPhotoRunTarget();
    await reportRunTargetDeviceWork(ctx.db, {
      run: runShortcode,
      image: imageShortcode,
      state: "running",
    });
    await reportRunTargetDeviceWork(ctx.db, {
      run: runShortcode,
      image: imageShortcode,
      state: "failed",
      error: "device offline",
    });
    await reportRunTargetDeviceWork(ctx.db, {
      run: runShortcode,
      image: imageShortcode,
      state: "failed",
      error: "device offline",
    });
    const [row] = await getDb(ctx.db)
      .select({
        deviceWorkState: runTarget.deviceWorkState,
        deviceWorkAttempts: runTarget.deviceWorkAttempts,
        deviceWorkError: runTarget.deviceWorkError,
      })
      .from(runTarget);
    expect(row?.deviceWorkState).toBe("failed");
    expect(row?.deviceWorkAttempts).toBe(1);
    expect(row?.deviceWorkError).toBe("device offline");
  });
});
