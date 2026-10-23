import { parseEntityId, parseShortcodeFor } from "@cubby/schemas/identifiers";
import { eq, sql } from "drizzle-orm";
import { createRepoEntity } from "tooling/factories/repo";
import { taxonomyShortcode } from "tooling/product-category-fixtures";
import { TEST_ACTOR, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { unwrapDb } from "~/server/db/helpers";
import { job } from "~/server/db/schema";
import {
  createGardenEntry,
  createPlanting,
} from "~/server/domains/garden/repo/garden";
import { createLedgerParty } from "~/server/domains/ledger-party/repo/ledger-party";
import { createLedgerTransfer } from "~/server/domains/ledger-transfer/repo";
import { createLocation } from "~/server/domains/location/repo/crud";
import {
  findOrCreateVendor,
  getVendorByID,
  updateVendor,
} from "~/server/domains/vendor/repo/vendor";
import { createWish } from "~/server/domains/wish/repo";
import { advanceJob } from "~/server/generic/jobs/service/jobs";
import { resolveLiveShortcode } from "~/server/generic/shortcode/repo/shortcode-resolver";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";
import { publishQualityFixtures } from "~/server/testing/quality.fixtures";
import {
  createImageFixture,
  createPlantFixture,
  createProductIdentityFixture,
  makeLocationInput,
  makeProductInput,
  insertEntityAttachments,
} from "~/server/testing/repo.fixtures";
import { refreshFamilyHandler } from "~/server/workflows/background-tasks/refresh-families";

import { setDataException } from "./exceptions";
import { loadDataQualities } from "./hydrate";

/**
 * For each finance/project scored entity, one row that trips a real check and
 * one that satisfies it. Stored-quality entries are read after their quality
 * family publishes the batch-loaded outcomes.
 */
describe("data quality: finance and project entities", () => {
  const ctx = withTestDb();
  const refreshQuality = async () => {
    for (let page = 0; page < 8; page++) {
      const [intent] = await unwrapDb(ctx.db)
        .select()
        .from(job)
        .where(eq(job.key, "refresh:quality"));
      if (!intent) throw new Error("Expected quality intent from source write");
      expect(
        await advanceJob(ctx.db, intent.id, {
          "refresh.family": refreshFamilyHandler,
        }),
      ).toBe("succeeded");
      const [current] = await unwrapDb(ctx.db)
        .select()
        .from(job)
        .where(eq(job.id, intent.id));
      if (current?.state === "completed") return;
    }
    throw new Error("Synthetic finance quality pass exceeded page budget");
  };

  it("project: kind, and a start date only once work has begun", async () => {
    const gap = await createRepoEntity(ctx, "project", {
      name: "DQ project gap",
      status: "in_progress",
    });
    const notStarted = await createRepoEntity(ctx, "project", {
      name: "DQ project not started",
      kind: "furniture",
      status: "not_started",
    });
    const complete = await createRepoEntity(ctx, "project", {
      name: "DQ project complete",
      kind: "furniture",
      status: "not_started",
      dates: { start: "2026-01-01", end: null },
    });

    const hydrated = await loadDataQualities(
      ctx.db,
      "project",
      [gap.entityId, notStarted.entityId, complete.entityId],
      "live",
    );
    const gapChecks = hydrated.get(gap.entityId)?.gaps.map((g) => g.check);
    expect(gapChecks).toContain("project_kind");
    expect(gapChecks).toContain("project_start_date");
    // `not_started` has no actual start to record.
    expect(
      hydrated.get(notStarted.entityId)?.gaps.map((gap) => gap.check),
    ).toEqual(["project_display_image"]);
    expect(hydrated.get(complete.entityId)).toMatchObject({
      status: "needs_data",
      gaps: [{ check: "project_display_image" }],
    });
  });

  it("task: due date optional, trade inherited", async () => {
    // A task needs a trade or an inherited source (`assertEffectiveTaskTrade`)
    // — give it a project default so create succeeds while the task's OWN
    // `trade` column, which this check reads, stays unset.
    const project = await createRepoEntity(ctx, "project", {
      name: "DQ task trade project",
      defaultTrade: "electrical",
    });
    const gap = await createRepoEntity(ctx, "task", {
      name: "DQ task gap",
      projectId: project.output.id,
    });
    const complete = await createRepoEntity(ctx, "task", {
      name: "DQ task complete",
      trade: "electrical",
      due: { start: "2026-09-01", end: null },
    });

    // An end-only window is valid; it must not create a missing-start defect.
    await unwrapDb(ctx.db).execute(
      sql`UPDATE "Task" SET "dueEndDate" = '2026-09-10' WHERE "id" = ${gap.entityId}`,
    );

    await publishQualityFixtures(ctx.db, "task");
    const hydrated = await loadDataQualities(
      ctx.db,
      "task",
      [gap.entityId, complete.entityId],
      "stored",
    );
    const gapChecks = hydrated.get(gap.entityId)?.gaps.map((g) => g.check);
    expect(gapChecks).not.toContain("task_due_range");
    expect(hydrated.get(gap.entityId)?.status).toBe("needs_data");
    // The project's default trade is the task's effective trade.
    expect(gapChecks).not.toContain("task_trade");
    expect(hydrated.get(complete.entityId)).toMatchObject({
      status: "needs_data",
      gaps: [{ check: "task_display_image" }],
    });
    // Record reads see current facts without repairing the last publication.
    await unwrapDb(ctx.db).execute(
      sql`UPDATE "Task" SET "dueDate" = '2026-09-11' WHERE id = ${gap.entityId}`,
    );
    const live = (await loadDataQualities(ctx.db, "task", [gap.entityId])).get(
      gap.entityId,
    );
    expect(live?.gaps.map((g) => g.check)).toContain("task_due_range");
    const published = (
      await loadDataQualities(ctx.db, "task", [gap.entityId], "stored")
    ).get(gap.entityId);
    expect(published?.gaps.map((g) => g.check)).not.toContain("task_due_range");
    await publishQualityFixtures(ctx.db, "task");
    const refreshed = (
      await loadDataQualities(ctx.db, "task", [gap.entityId], "stored")
    ).get(gap.entityId);
    expect(refreshed?.gaps.map((g) => g.check)).toContain("task_due_range");
  });

  it("vendor: website and logo expected before purchase; order evidence after purchase", async () => {
    const untransacted = await createRepoEntity(ctx, "vendor", {
      name: "DQ vendor untransacted",
    });
    const gap = await createRepoEntity(ctx, "vendor", {
      name: "DQ vendor gap",
    });
    await createRepoEntity(ctx, "purchase", {
      date: "2026-08-01",
      vendorId: gap.output.id,
    });
    const complete = await createRepoEntity(ctx, "vendor", {
      name: "DQ vendor complete",
      website: "https://example.test",
      orderEvidence: "online_account",
    });
    await createRepoEntity(ctx, "purchase", {
      date: "2026-08-01",
      vendorId: complete.output.id,
    });
    const logo = await createImageFixture(ctx.db, "dq-vendor-logo");
    await insertEntityAttachments(ctx.db, {
      entityId: complete.entityId,
      role: "logo",
      imageId: logo.id,
    });

    await refreshQuality();
    const hydrated = await loadDataQualities(ctx.db, "vendor", [
      untransacted.entityId,
      gap.entityId,
      complete.entityId,
    ]);
    // Discovery starts before a Purchase exists; website and logo research
    // remain independent, while order evidence needs an actual purchase.
    expect(hydrated.get(untransacted.entityId)).toMatchObject({
      status: "needs_data",
      gaps: expect.arrayContaining([
        expect.objectContaining({ check: "vendor_logo" }),
        expect.objectContaining({ check: "vendor_website" }),
      ]),
    });
    expect(
      hydrated.get(untransacted.entityId)?.gaps.map((g) => g.check),
    ).not.toContain("vendor_order_evidence");
    const noWebsite = await setDataException(
      ctx.db,
      {
        entityId: untransacted.output.id,
        check: "vendor_website",
        reason: "not_applicable",
        note: "Synthetic local stall has no website; verified receipt senders remain separate evidence.",
      },
      ctx.actor,
    );
    expect(noWebsite.gaps.map((g) => g.check)).not.toContain("vendor_website");
    expect(noWebsite.gaps.map((g) => g.check)).toContain("vendor_logo");
    const gapChecks = hydrated.get(gap.entityId)?.gaps.map((g) => g.check);
    expect(gapChecks).toContain("vendor_order_evidence");
    expect(gapChecks).toContain("vendor_logo");
    expect(gapChecks).toContain("vendor_website");
    expect(hydrated.get(complete.entityId)).toMatchObject({
      status: "complete",
      gaps: [],
    });

    // Stored waivers are durable member decisions across evidence changes.
    const excepted = await setDataException(
      ctx.db,
      {
        entityId: gap.output.id,
        check: "vendor_logo",
        reason: "unavailable",
        note: "A market stall with no published mark.",
      },
      ctx.actor,
    );
    expect(excepted.gaps.map((g) => g.check)).not.toContain("vendor_logo");
    expect(excepted.exceptions).toContainEqual(
      expect.objectContaining({ check: "vendor_logo", state: "active" }),
    );
    await updateVendor(
      ctx.db,
      gap.output.id,
      { website: "https://stall.example.test" },
      ctx.actor,
    );
    await refreshQuality();
    const reopened = (
      await loadDataQualities(ctx.db, "vendor", [gap.entityId])
    ).get(gap.entityId);
    expect(reopened?.gaps.map((g) => g.check)).not.toContain("vendor_logo");
    expect(reopened?.exceptions).toContainEqual(
      expect.objectContaining({ check: "vendor_logo", state: "active" }),
    );
  });

  it("vendor: surfaces a source classification that contradicts the evidence policy, in one check", async () => {
    const make = async (
      name: string,
      values: {
        orderEvidence?: "online_account" | "receipt_only" | "not_expected";
        itemizationExpectation?: "required" | "not_expected" | "unknown";
      },
    ) => createRepoEntity(ctx, "vendor", { name, ...values });
    const noSource = await make("DQ conflict required, no source", {
      itemizationExpectation: "required",
    });
    const noPolicy = await make("DQ conflict not expected, no policy", {
      orderEvidence: "not_expected",
    });
    const consistent = [
      await make("DQ conflict consistent a", {
        orderEvidence: "online_account",
        itemizationExpectation: "required",
      }),
      await make("DQ conflict consistent b", {
        orderEvidence: "not_expected",
        itemizationExpectation: "not_expected",
      }),
      await make("DQ conflict consistent c", {
        orderEvidence: "online_account",
        itemizationExpectation: "unknown",
      }),
    ];
    const sourceOff = await make("DQ conflict source off", {
      orderEvidence: "not_expected",
      itemizationExpectation: "required",
    });
    const policyOffOnline = await make("DQ conflict policy off online", {
      orderEvidence: "online_account",
      itemizationExpectation: "not_expected",
    });
    const policyOffReceipt = await make("DQ conflict policy off receipt", {
      orderEvidence: "receipt_only",
      itemizationExpectation: "not_expected",
    });

    await refreshQuality();
    const hydrated = await loadDataQualities(
      ctx.db,
      "vendor",
      [
        noSource,
        noPolicy,
        ...consistent,
        sourceOff,
        policyOffOnline,
        policyOffReceipt,
      ].map((v) => v.entityId),
    );
    const conflict = (v: typeof noSource) =>
      hydrated
        .get(v.entityId)
        ?.gaps.map((g) => g.check)
        .includes("vendor_order_evidence_conflict");
    // An in-store shop whose receipts are sometimes kept, or an online
    // account, with itemization not expected is ordinary, not a conflict.
    for (const id of [
      noSource,
      noPolicy,
      ...consistent,
      policyOffOnline,
      policyOffReceipt,
    ])
      expect(conflict(id)).toBe(false);
    expect(conflict(sourceOff)).toBe(true);

    // Resolving either side clears it; no accepted-exception state exists.
    await updateVendor(
      ctx.db,
      sourceOff.output.id,
      { orderEvidence: "online_account" },
      ctx.actor,
    );
    await refreshQuality();
    const resolved = (
      await loadDataQualities(ctx.db, "vendor", [sourceOff.entityId])
    ).get(sourceOff.entityId);
    expect(resolved?.gaps.map((g) => g.check)).not.toContain(
      "vendor_order_evidence_conflict",
    );
  });

  it("financialAccount: ledger party link and confirmation", async () => {
    const member = await createLedgerParty(
      ctx.db,
      { name: "DQ member", kind: "member", notes: null },
      ctx.actor,
    );
    const gap = await createRepoEntity(ctx, "financialAccount", {
      name: "DQ account gap",
      identity: { kind: "cash" },
      provisional: true,
    });
    const complete = await createRepoEntity(ctx, "financialAccount", {
      name: "DQ account complete",
      identity: { kind: "cash" },
      provisional: false,
      ledgerPartyId: member.output.id,
    });

    await publishQualityFixtures(ctx.db, "financialAccount");
    const hydrated = await loadDataQualities(
      ctx.db,
      "financialAccount",
      [gap.entityId, complete.entityId],
      "stored",
    );
    const gapChecks = hydrated.get(gap.entityId)?.gaps.map((g) => g.check);
    expect(gapChecks).toContain("financial_account_ledger_party");
    expect(gapChecks).toContain("financial_account_confirmed");
    expect(hydrated.get(complete.entityId)).toMatchObject({
      status: "needs_data",
      gaps: [{ check: "financialaccount_display_image" }],
    });
  });

  it("financialTransaction: purchase allocation (posted settlement kinds) and merchant", async () => {
    const account = await createRepoEntity(ctx, "financialAccount", {
      name: "DQ transaction account",
      identity: { kind: "cash" },
      provisional: false,
    });
    const gap = await createRepoEntity(ctx, "financialTransaction", {
      accountId: account.output.id,
      kind: "purchase",
      status: "posted",
      postedDate: "2026-08-01",
      amount: 25,
    });
    const vendorId = await findOrCreateVendor(ctx.db, "DQ settlement vendor");
    const settlementVendor = await getVendorByID(ctx.db, vendorId);
    const purchase = await createRepoEntity(ctx, "purchase", {
      date: "2026-08-01",
      vendorId: settlementVendor.id,
    });
    const complete = await createRepoEntity(ctx, "financialTransaction", {
      accountId: account.output.id,
      purchaseId: purchase.output.id,
      kind: "purchase",
      status: "posted",
      postedDate: "2026-08-01",
      amount: 25,
      merchant: "DQ settlement vendor",
    });

    await publishQualityFixtures(ctx.db, "financialTransaction");
    const hydrated = await loadDataQualities(
      ctx.db,
      "financialTransaction",
      [gap.entityId, complete.entityId],
      "stored",
    );
    const gapChecks = hydrated.get(gap.entityId)?.gaps.map((g) => g.check);
    expect(gapChecks).toContain("financial_transaction_allocation");
    expect(gapChecks).toContain("financial_transaction_merchant");
    const linkedChecks = hydrated
      .get(complete.entityId)
      ?.gaps.map((g) => g.check);
    expect(linkedChecks).not.toContain("financial_transaction_allocation");
    expect(linkedChecks).not.toContain("financial_transaction_merchant");
    await setDataException(
      ctx.db,
      {
        entityId: gap.output.id,
        check: "financial_transaction_merchant",
        reason: "unavailable",
        note: "Synthetic statement does not retain a merchant.",
      },
      ctx.actor,
    );
    // A changed input keeps the member's waiver even when the gap persists.
    await unwrapDb(ctx.db).execute(
      sql`UPDATE "FinancialTransaction" SET merchant = ' ' WHERE id = ${gap.entityId}`,
    );
    await publishQualityFixtures(ctx.db, "financialTransaction");
    const waived = (
      await loadDataQualities(
        ctx.db,
        "financialTransaction",
        [gap.entityId],
        "stored",
      )
    ).get(gap.entityId);
    expect(waived?.gaps.map((g) => g.check)).not.toContain(
      "financial_transaction_merchant",
    );
    expect(waived?.exceptions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          check: "financial_transaction_merchant",
          state: "active",
        }),
      ]),
    );
  });

  it("wish: candidate (only while not yet acquired)", async () => {
    const tool = await createProductIdentityFixture(
      ctx.db,
      makeProductInput({
        name: "DQ wish tool",
        categoryId: taxonomyShortcode("tools"),
      }),
      ctx.actor,
    );
    const gap = await createWish(
      ctx.db,
      { name: "DQ wish gap", notes: null, candidateProductIds: [] },
      ctx.actor,
    );
    const complete = await createWish(
      ctx.db,
      {
        name: "DQ wish complete",
        notes: null,
        candidateProductIds: [tool.id],
      },
      ctx.actor,
    );

    const hydrated = await loadDataQualities(
      ctx.db,
      "wish",
      [gap.entityId, complete.entityId],
      "live",
    );
    const gapChecks = hydrated.get(gap.entityId)?.gaps.map((g) => g.check);
    expect(gapChecks).toContain("wish_candidate");
    expect(hydrated.get(complete.entityId)).toMatchObject({
      status: "needs_data",
      gaps: [{ check: "wish_display_image" }],
    });
  });

  it("planting: location (only once no longer planned)", async () => {
    const crop = await createPlantFixture(
      ctx.db,
      { name: "DQ planting crop" },
      TEST_ACTOR,
    );
    const bed = await createLocation(
      ctx.db,
      makeLocationInput({ name: "DQ planting bed", type: "bed" }),
      TEST_ACTOR,
    );
    const gap = await createPlanting(
      ctx.db,
      {
        plantId: crop.id,
        status: "growing",
        season: { start: "2026-04-01", end: null },
      },
      TEST_ACTOR,
    );
    const complete = await createPlanting(
      ctx.db,
      {
        plantId: crop.id,
        locationId: bed.id,
        status: "growing",
        season: { start: "2026-04-01", end: null },
      },
      TEST_ACTOR,
    );

    const contradictory = await createPlanting(
      ctx.db,
      {
        plantId: crop.id,
        locationId: bed.id,
        status: "growing",
        season: { start: "2026-04-01", end: "2026-05-01" },
        outcome: null,
      },
      TEST_ACTOR,
    );
    const contradictoryId = parseEntityId(
      "planting",
      (await resolveLiveShortcode(ctx.db, contradictory.id, "planting"))!,
    );
    const quality = (
      await loadDataQualities(ctx.db, "planting", [contradictoryId], "live")
    ).get(contradictoryId);
    expect(quality?.gaps.map((gap) => gap.check)).toContain(
      "planting_lifecycle",
    );
    expect(quality?.score).toBeLessThanOrEqual(49);

    const gapId = parseEntityId(
      "planting",
      (await resolveLiveShortcode(ctx.db, gap.id, "planting"))!,
    );
    const completeId = parseEntityId(
      "planting",
      (await resolveLiveShortcode(ctx.db, complete.id, "planting"))!,
    );
    const hydrated = await loadDataQualities(
      ctx.db,
      "planting",
      [gapId, completeId],
      "live",
    );
    const gapChecks = hydrated.get(gapId)?.gaps.map((g) => g.check);
    expect(gapChecks).toEqual(["planting_location", "planting_display_image"]);
    expect(hydrated.get(completeId)).toMatchObject({
      status: "needs_data",
      gaps: [{ check: "planting_display_image" }],
    });
  });

  it("gardenEntry: note (only for note-kind entries)", async () => {
    const bed = await createLocation(
      ctx.db,
      makeLocationInput({ name: "DQ garden entry bed", type: "bed" }),
      TEST_ACTOR,
    );
    const gap = await createGardenEntry(
      ctx.db,
      {
        locationId: bed.id,
        kind: "note",
        observedOn: "2026-08-01",
        notes: null,
        pendingImageIds: [],
      },
      TEST_ACTOR,
    );
    const complete = await createGardenEntry(
      ctx.db,
      {
        locationId: bed.id,
        kind: "note",
        observedOn: "2026-08-01",
        notes: "Everything looks healthy",
        pendingImageIds: [],
      },
      TEST_ACTOR,
    );
    const harvestGap = await createGardenEntry(
      ctx.db,
      {
        locationId: bed.id,
        kind: "harvest",
        observedOn: "2026-08-01",
        harvestAmount: null,
        pendingImageIds: [],
      },
      TEST_ACTOR,
    );

    const gapId = parseEntityId(
      "gardenEntry",
      (await resolveLiveShortcode(ctx.db, gap.id, "gardenEntry"))!,
    );
    const completeId = parseEntityId(
      "gardenEntry",
      (await resolveLiveShortcode(ctx.db, complete.id, "gardenEntry"))!,
    );
    const harvestGapId = parseEntityId(
      "gardenEntry",
      (await resolveLiveShortcode(ctx.db, harvestGap.id, "gardenEntry"))!,
    );
    const hydrated = await loadDataQualities(
      ctx.db,
      "gardenEntry",
      [gapId, completeId, harvestGapId],
      "live",
    );
    const gapChecks = hydrated.get(gapId)?.gaps.map((g) => g.check);
    expect(gapChecks).toContain("garden_entry_note");
    expect(hydrated.get(harvestGapId)?.gaps.map((g) => g.check)).toContain(
      "garden_entry_harvest_amount",
    );
    expect(hydrated.get(completeId)).toMatchObject({
      status: "needs_data",
      gaps: [{ check: "gardenentry_display_image" }],
    });
  });

  it("ledgerParty: financial account link (only for household members)", async () => {
    const guest = await createLedgerParty(
      ctx.db,
      { name: "DQ guest", kind: "guest", notes: null },
      ctx.actor,
    );
    const gap = await createLedgerParty(
      ctx.db,
      { name: "DQ member gap", kind: "member", notes: null },
      ctx.actor,
    );
    const complete = await createLedgerParty(
      ctx.db,
      { name: "DQ member complete", kind: "member", notes: null },
      ctx.actor,
    );
    await createRepoEntity(ctx, "financialAccount", {
      name: "DQ member account",
      identity: { kind: "cash" },
      provisional: false,
      ledgerPartyId: complete.output.id,
    });

    const hydrated = await loadDataQualities(
      ctx.db,
      "ledgerParty",
      [guest.entityId, gap.entityId, complete.entityId],
      "live",
    );
    // A guest party is never expected to map to a financial account.
    expect(hydrated.get(guest.entityId)).toMatchObject({
      score: 99,
      status: "needs_data",
      gaps: [{ check: "ledgerparty_display_image" }],
    });
    const gapChecks = hydrated.get(gap.entityId)?.gaps.map((g) => g.check);
    expect(gapChecks).toContain("ledger_party_financial_account");
    expect(hydrated.get(complete.entityId)).toMatchObject({
      status: "needs_data",
      gaps: [{ check: "ledgerparty_display_image" }],
    });
  });

  it("ledgerTransfer: evidencing transaction", async () => {
    const fromParty = await createLedgerParty(
      ctx.db,
      { name: "DQ transfer from", kind: "member", notes: null },
      ctx.actor,
    );
    const toParty = await createLedgerParty(
      ctx.db,
      { name: "DQ transfer to", kind: "member", notes: null },
      ctx.actor,
    );
    const fromAccount = await insertWithShortcode(ctx.db, "financialAccount", {
      name: "DQ transfer from account",
      identity: { kind: "cash" },
      ledgerPartyId: fromParty.entityId,
    });
    const toAccount = await insertWithShortcode(ctx.db, "financialAccount", {
      name: "DQ transfer to account",
      identity: { kind: "cash" },
      ledgerPartyId: toParty.entityId,
    });
    const gap = await createLedgerTransfer(
      ctx.db,
      {
        fromPartyId: fromParty.output.id,
        toPartyId: toParty.output.id,
        amount: 40,
        date: "2026-08-20",
        notes: null,
        sourceClaims: [],
        evidenceTransactionIds: [],
      },
      ctx.actor,
    );
    const outflow = await insertWithShortcode(ctx.db, "financialTransaction", {
      accountId: fromAccount.id,
      kind: "account_transfer",
      status: "posted",
      amount: 40,
      transactionDate: "2026-08-20",
      postedDate: "2026-08-20",
    });
    const inflow = await insertWithShortcode(ctx.db, "financialTransaction", {
      accountId: toAccount.id,
      kind: "account_transfer",
      status: "posted",
      amount: -40,
      transactionDate: "2026-08-20",
      postedDate: "2026-08-20",
    });
    const complete = await createLedgerTransfer(
      ctx.db,
      {
        fromPartyId: fromParty.output.id,
        toPartyId: toParty.output.id,
        amount: 40,
        date: "2026-08-20",
        notes: null,
        sourceClaims: [],
        evidenceTransactionIds: [
          parseShortcodeFor("financialTransaction", outflow.shortcode),
          parseShortcodeFor("financialTransaction", inflow.shortcode),
        ],
      },
      ctx.actor,
    );

    const hydrated = await loadDataQualities(
      ctx.db,
      "ledgerTransfer",
      [gap.entityId, complete.entityId],
      "live",
    );
    const gapChecks = hydrated.get(gap.entityId)?.gaps.map((g) => g.check);
    expect(gapChecks).toContain("ledger_transfer_transaction");
    expect(hydrated.get(complete.entityId)).toMatchObject({
      status: "needs_data",
      gaps: [{ check: "ledgertransfer_display_image" }],
    });
  });
});
