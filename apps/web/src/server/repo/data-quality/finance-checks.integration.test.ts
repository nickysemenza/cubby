import { financialAccountCreateInput } from "@cubby/schemas/financial-account";
import { financialTransactionCreateInput } from "@cubby/schemas/financial-transaction";
import { parseEntityId, parseShortcodeFor } from "@cubby/schemas/identifiers";
import {
  expenseCreateInput,
  projectCreateInput,
  taskCreateInput,
} from "@cubby/schemas/project";
import { purchaseCreateInput } from "@cubby/schemas/purchase";
import { vendorCreateInput } from "@cubby/schemas/vendor";
import { taxonomyShortcode } from "tooling/product-category-fixtures";
import { TEST_ACTOR, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { entityAttachment } from "~/server/db/schema";
import { createExpense } from "~/server/repo/expense";
import { createFinancialAccount } from "~/server/repo/financial-account";
import { createFinancialTransaction } from "~/server/repo/financial-transaction";
import { createGardenEntry, createPlanting } from "~/server/repo/garden";
import { createLedgerParty } from "~/server/repo/ledger-party";
import { createLedgerTransfer } from "~/server/repo/ledger-transfer";
import { createLocation } from "~/server/repo/location";
import { createProject } from "~/server/repo/project";
import { createPurchase } from "~/server/repo/purchase";
import {
  createImageFixture,
  createPlantFixture,
  createProductFixture,
  makeLocationInput,
  makeProductInput,
} from "~/server/repo/repo.fixtures";
import { createTask } from "~/server/repo/task";
import {
  createVendor,
  findOrCreateVendor,
  getVendorByID,
} from "~/server/repo/vendor";
import { createWish } from "~/server/repo/wish";

import { getDb } from "../database-helpers";
import { resolveLiveShortcode } from "../shortcode-resolver";
import { insertWithShortcode } from "../shortcode-utils";
import { loadDataQualities } from "./hydrate";

/**
 * For each finance/project scored entity, one row that trips a real check and
 * one that satisfies it, asserted through `loadDataQualities` — the same
 * evaluation the list `dataStatus`/`dataGap` filters and the list's
 * `dataQuality` column read from (see `pantry-checks.integration.test.ts` for
 * the pantry/garden equivalent, `data-quality.integration.test.ts` for
 * product/purchase).
 */
describe("data quality: finance and project entities", () => {
  const ctx = withTestDb();

  it("project: kind and start date", async () => {
    const gap = await createProject(
      ctx.db,
      projectCreateInput.parse({
        name: "DQ project gap",
        status: "not_started",
      }),
      ctx.actor,
    );
    const complete = await createProject(
      ctx.db,
      projectCreateInput.parse({
        name: "DQ project complete",
        kind: "furniture",
        status: "not_started",
        startDate: "2026-01-01",
      }),
      ctx.actor,
    );

    const hydrated = await loadDataQualities(ctx.db, "project", [
      gap.entityId,
      complete.entityId,
    ]);
    const gapChecks = hydrated.get(gap.entityId)?.gaps.map((g) => g.check);
    expect(gapChecks).toContain("project_kind");
    expect(gapChecks).toContain("project_start_date");
    expect(hydrated.get(complete.entityId)).toMatchObject({
      status: "complete",
      gaps: [],
    });
  });

  it("task: due date and trade", async () => {
    // A task needs a trade or an inherited source (`assertEffectiveTaskTrade`)
    // — give it a project default so create succeeds while the task's OWN
    // `trade` column, which this check reads, stays unset.
    const project = await createProject(
      ctx.db,
      projectCreateInput.parse({
        name: "DQ task trade project",
        defaultTrade: "electrical",
      }),
      ctx.actor,
    );
    const gap = await createTask(
      ctx.db,
      taskCreateInput.parse({
        name: "DQ task gap",
        projectId: project.output.id,
      }),
      ctx.actor,
    );
    const complete = await createTask(
      ctx.db,
      taskCreateInput.parse({
        name: "DQ task complete",
        trade: "electrical",
        dueDate: "2026-09-01",
      }),
      ctx.actor,
    );

    const hydrated = await loadDataQualities(ctx.db, "task", [
      gap.entityId,
      complete.entityId,
    ]);
    const gapChecks = hydrated.get(gap.entityId)?.gaps.map((g) => g.check);
    expect(gapChecks).toContain("task_due_date");
    expect(gapChecks).toContain("task_trade");
    expect(hydrated.get(complete.entityId)).toMatchObject({
      status: "complete",
      gaps: [],
    });
  });

  it("vendor: order evidence, logo and website (only once transacted with)", async () => {
    const untransacted = await createVendor(
      ctx.db,
      vendorCreateInput.parse({ name: "DQ vendor untransacted" }),
      ctx.actor,
    );
    const gap = await createVendor(
      ctx.db,
      vendorCreateInput.parse({ name: "DQ vendor gap" }),
      ctx.actor,
    );
    await createPurchase(
      ctx.db,
      purchaseCreateInput.parse({
        date: "2026-08-01",
        vendorId: gap.output.id,
      }),
      ctx.actor,
    );
    const complete = await createVendor(
      ctx.db,
      vendorCreateInput.parse({
        name: "DQ vendor complete",
        website: "https://example.test",
        orderEvidence: "online_account",
      }),
      ctx.actor,
    );
    await createPurchase(
      ctx.db,
      purchaseCreateInput.parse({
        date: "2026-08-01",
        vendorId: complete.output.id,
      }),
      ctx.actor,
    );
    const logo = await createImageFixture(ctx.db, "dq-vendor-logo");
    await getDb(ctx.db).insert(entityAttachment).values({
      subjectEntityId: complete.entityId,
      role: "logo",
      imageId: logo.id,
    });

    const hydrated = await loadDataQualities(ctx.db, "vendor", [
      untransacted.entityId,
      gap.entityId,
      complete.entityId,
    ]);
    // Never transacted with: no evidence is expected at all.
    expect(hydrated.get(untransacted.entityId)).toMatchObject({
      status: "complete",
      gaps: [],
    });
    const gapChecks = hydrated.get(gap.entityId)?.gaps.map((g) => g.check);
    expect(gapChecks).toContain("vendor_order_evidence");
    expect(gapChecks).toContain("vendor_logo");
    expect(gapChecks).toContain("vendor_website");
    expect(hydrated.get(complete.entityId)).toMatchObject({
      status: "complete",
      gaps: [],
    });
  });

  it("financialAccount: ledger party link and confirmation", async () => {
    const member = await createLedgerParty(
      ctx.db,
      { name: "DQ member", kind: "member", notes: null },
      ctx.actor,
    );
    const gap = await createFinancialAccount(
      ctx.db,
      financialAccountCreateInput.parse({
        name: "DQ account gap",
        identity: { kind: "cash" },
        provisional: true,
      }),
      ctx.actor,
    );
    const complete = await createFinancialAccount(
      ctx.db,
      financialAccountCreateInput.parse({
        name: "DQ account complete",
        identity: { kind: "cash" },
        provisional: false,
        ledgerPartyId: member.output.id,
      }),
      ctx.actor,
    );

    const hydrated = await loadDataQualities(ctx.db, "financialAccount", [
      gap.entityId,
      complete.entityId,
    ]);
    const gapChecks = hydrated.get(gap.entityId)?.gaps.map((g) => g.check);
    expect(gapChecks).toContain("financial_account_ledger_party");
    expect(gapChecks).toContain("financial_account_confirmed");
    expect(hydrated.get(complete.entityId)).toMatchObject({
      status: "complete",
      gaps: [],
    });
  });

  it("financialTransaction: purchase allocation (posted settlement kinds) and merchant", async () => {
    const account = await createFinancialAccount(
      ctx.db,
      financialAccountCreateInput.parse({
        name: "DQ transaction account",
        identity: { kind: "cash" },
        provisional: false,
      }),
      ctx.actor,
    );
    const gap = await createFinancialTransaction(
      ctx.db,
      financialTransactionCreateInput.parse({
        accountId: account.output.id,
        kind: "purchase",
        status: "posted",
        postedDate: "2026-08-01",
        amount: 25,
      }),
      ctx.actor,
    );
    const vendorId = await findOrCreateVendor(ctx.db, "DQ settlement vendor");
    const settlementVendor = await getVendorByID(ctx.db, vendorId);
    const purchase = await createPurchase(
      ctx.db,
      purchaseCreateInput.parse({
        date: "2026-08-01",
        vendorId: settlementVendor.id,
      }),
      ctx.actor,
    );
    const complete = await createFinancialTransaction(
      ctx.db,
      financialTransactionCreateInput.parse({
        accountId: account.output.id,
        purchaseId: purchase.output.id,
        kind: "purchase",
        status: "posted",
        postedDate: "2026-08-01",
        amount: 25,
        merchant: "DQ settlement vendor",
      }),
      ctx.actor,
    );

    const hydrated = await loadDataQualities(ctx.db, "financialTransaction", [
      gap.entityId,
      complete.entityId,
    ]);
    const gapChecks = hydrated.get(gap.entityId)?.gaps.map((g) => g.check);
    expect(gapChecks).toContain("financial_transaction_allocation");
    expect(gapChecks).toContain("financial_transaction_merchant");
    expect(hydrated.get(complete.entityId)).toMatchObject({
      status: "complete",
      gaps: [],
    });
  });

  it("expense: cost (only when not future)", async () => {
    const gap = await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        name: "DQ expense gap",
        date: "2026-08-01",
        trade: "other",
        costType: "materials",
        future: false,
      }),
      ctx.actor,
    );
    const complete = await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        name: "DQ expense complete",
        date: "2026-08-01",
        trade: "other",
        cost: 42,
        costType: "materials",
        future: false,
      }),
      ctx.actor,
    );

    const hydrated = await loadDataQualities(ctx.db, "expense", [
      gap.entityId,
      complete.entityId,
    ]);
    const gapChecks = hydrated.get(gap.entityId)?.gaps.map((g) => g.check);
    expect(gapChecks).toContain("expense_cost");
    expect(hydrated.get(complete.entityId)).toMatchObject({
      status: "complete",
      gaps: [],
    });
  });

  it("wish: candidate (only while not yet acquired)", async () => {
    const tool = await createProductFixture(
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

    const hydrated = await loadDataQualities(ctx.db, "wish", [
      gap.entityId,
      complete.entityId,
    ]);
    const gapChecks = hydrated.get(gap.entityId)?.gaps.map((g) => g.check);
    expect(gapChecks).toContain("wish_candidate");
    expect(hydrated.get(complete.entityId)).toMatchObject({
      status: "complete",
      gaps: [],
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
      { plantId: crop.id, status: "growing" },
      TEST_ACTOR,
    );
    const complete = await createPlanting(
      ctx.db,
      {
        plantId: crop.id,
        locationId: bed.id,
        status: "growing",
      },
      TEST_ACTOR,
    );

    const gapId = parseEntityId(
      "planting",
      (await resolveLiveShortcode(ctx.db, gap.id, "planting"))!,
    );
    const completeId = parseEntityId(
      "planting",
      (await resolveLiveShortcode(ctx.db, complete.id, "planting"))!,
    );
    const hydrated = await loadDataQualities(ctx.db, "planting", [
      gapId,
      completeId,
    ]);
    const gapChecks = hydrated.get(gapId)?.gaps.map((g) => g.check);
    expect(gapChecks).toEqual(["planting_location"]);
    expect(hydrated.get(completeId)).toMatchObject({
      status: "complete",
      gaps: [],
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
        note: null,
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
        note: "Everything looks healthy",
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
    const hydrated = await loadDataQualities(ctx.db, "gardenEntry", [
      gapId,
      completeId,
    ]);
    const gapChecks = hydrated.get(gapId)?.gaps.map((g) => g.check);
    expect(gapChecks).toContain("garden_entry_note");
    expect(hydrated.get(completeId)).toMatchObject({
      status: "complete",
      gaps: [],
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
    await createFinancialAccount(
      ctx.db,
      financialAccountCreateInput.parse({
        name: "DQ member account",
        identity: { kind: "cash" },
        provisional: false,
        ledgerPartyId: complete.output.id,
      }),
      ctx.actor,
    );

    const hydrated = await loadDataQualities(ctx.db, "ledgerParty", [
      guest.entityId,
      gap.entityId,
      complete.entityId,
    ]);
    // A guest party is never expected to map to a financial account.
    expect(hydrated.get(guest.entityId)).toMatchObject({
      status: "complete",
      gaps: [],
    });
    const gapChecks = hydrated.get(gap.entityId)?.gaps.map((g) => g.check);
    expect(gapChecks).toContain("ledger_party_financial_account");
    expect(hydrated.get(complete.entityId)).toMatchObject({
      status: "complete",
      gaps: [],
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

    const hydrated = await loadDataQualities(ctx.db, "ledgerTransfer", [
      gap.entityId,
      complete.entityId,
    ]);
    const gapChecks = hydrated.get(gap.entityId)?.gaps.map((g) => g.check);
    expect(gapChecks).toContain("ledger_transfer_transaction");
    expect(hydrated.get(complete.entityId)).toMatchObject({
      status: "complete",
      gaps: [],
    });
  });
});
