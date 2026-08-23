import {
  applyHouseholdLedgerChangesInput,
  previewHouseholdLedgerChangesInput,
} from "@cubby/schemas/household-contribution";
import {
  fundingTransferId,
  unsafeExpenseShortcode,
  unsafeFinancialAccountShortcode,
  unsafePersonShortcode,
  unsafeProjectShortcode,
} from "@cubby/schemas/identifiers";
import { and, eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { expenseSourceRef, fundingSource } from "~/server/db/schema";
import {
  getDb,
  notDeleted,
  withTransaction,
} from "~/server/repo/database-helpers";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import {
  applyHouseholdLedgerChanges,
  assertHouseholdContributionIntegrity,
  claimExpenseSource,
  deleteFundingTransfer,
  findHouseholdContributionDefects,
  type HouseholdContributionDefect,
  householdContributionLedger,
  previewHouseholdLedgerChanges,
  projectContribution,
  putFundingTransfer,
  setAccountFunding,
  setExpenseAttribution,
  softDeleteExpenseSourceRefs,
  upsertFundingFund,
} from ".";

describe("household contribution repository", () => {
  const ctx = withTestDb("mcp");

  const makeExpense = (cost: number | null) =>
    insertWithShortcode(ctx.db, "expense", {
      name: "Household ledger fixture",
      cost,
      date: "2026-08-20",
      costType: "materials",
      trade: "other",
      future: false,
    });

  it("synthesizes both missing roles as exact unattributed allocations", async () => {
    const row = await makeExpense(10.01);
    const ledger = await householdContributionLedger(ctx.db, {
      asOf: "2026-08-20",
    });

    expect(ledger.checks.expenseTotal).toBe(10.01);
    expect(ledger.checks.consumedTotal).toBe(0);
    expect(ledger.checks.fundedTotal).toBe(0);
    expect(ledger.unattributed).toEqual({ consumption: 10.01, funding: 10.01 });
    expect(ledger.gaps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "missing_beneficiaries",
          amount: 10.01,
          targetIds: [row.shortcode],
        }),
        expect.objectContaining({
          code: "missing_funders",
          amount: 10.01,
          targetIds: [row.shortcode],
        }),
      ]),
    );
  });

  it("claims an Expense source exactly once through preview/apply", async () => {
    const row = await makeExpense(4.25);
    const changes = previewHouseholdLedgerChangesInput.parse({
      changes: [
        {
          type: "claim_expense_source",
          expenseId: row.shortcode,
          sourceRef: { source: "splitwise", externalId: "expense-123" },
        },
      ],
    });
    const preview = await previewHouseholdLedgerChanges(ctx.db, changes);
    expect(preview.changes[0]?.status).toBe("ready");

    const input = applyHouseholdLedgerChangesInput.parse({
      ...changes,
      previewFingerprint: preview.previewFingerprint,
      idempotencyKey: "splitwise:expense-123",
    });
    const first = await applyHouseholdLedgerChanges(ctx.db, input, ctx.actor);
    const retry = await applyHouseholdLedgerChanges(ctx.db, input, ctx.actor);
    expect(first).toMatchObject({ status: "applied", changed: 1 });
    expect(retry).toMatchObject({ status: "already_applied", changed: 1 });

    const refs = await getDb(ctx.db)
      .select()
      .from(expenseSourceRef)
      .where(
        and(
          eq(expenseSourceRef.expenseId, row.id),
          notDeleted(expenseSourceRef),
        ),
      );
    expect(refs).toHaveLength(1);

    await claimExpenseSource(
      ctx.db,
      {
        type: "claim_expense_source",
        expenseId: unsafeExpenseShortcode(row.shortcode),
        sourceRef: { source: "splitwise", externalId: "expense-123-alias" },
      },
      ctx.actor,
    );
    const defects: HouseholdContributionDefect[] =
      await findHouseholdContributionDefects(ctx.db);
    expect(defects).toEqual([]);
    await assertHouseholdContributionIntegrity(ctx.db);
    await withTransaction(ctx.db, (tx) =>
      softDeleteExpenseSourceRefs(tx, [row.id]),
    );
    const liveRefs = await getDb(ctx.db)
      .select()
      .from(expenseSourceRef)
      .where(
        and(
          eq(expenseSourceRef.expenseId, row.id),
          notDeleted(expenseSourceRef),
        ),
      );
    expect(liveRefs).toEqual([]);

    const revived = await claimExpenseSource(
      ctx.db,
      {
        type: "claim_expense_source",
        expenseId: unsafeExpenseShortcode(row.shortcode),
        sourceRef: { source: "splitwise", externalId: "expense-123-alias" },
      },
      ctx.actor,
    );
    expect(revived.changed).toBe(1);
    const revivedRefs = await getDb(ctx.db)
      .select()
      .from(expenseSourceRef)
      .where(
        and(
          eq(expenseSourceRef.expenseId, row.id),
          notDeleted(expenseSourceRef),
        ),
      );
    expect(revivedRefs).toHaveLength(1);
  });

  it("reconciles a weighted split to the cent for known parties", async () => {
    await upsertFundingFund(ctx.db, {
      type: "upsert_funding_fund",
      key: "household-cash",
      name: "Household cash",
    });
    const row = await makeExpense(0.05);
    await setExpenseAttribution(
      ctx.db,
      {
        type: "set_expense_attribution",
        expenseIds: [unsafeExpenseShortcode(row.shortcode)],
        funders: {
          parties: [
            {
              party: { kind: "fund", key: "household-cash" },
              weight: 2,
            },
          ],
          unattributedWeight: 1,
        },
        beneficiaries: { people: [], unattributedWeight: 1 },
      },
      ctx.actor,
    );
    const ledger = await householdContributionLedger(ctx.db, {
      asOf: "2026-08-20",
    });
    expect(ledger.checks.expenseTotal).toBe(0.05);
    expect(ledger.checks.fundedTotal + ledger.unattributed.funding).toBe(0.05);
    expect(
      ledger.parties.find((party) => party.party.key === "household-cash")
        ?.initiallyOutlaid,
    ).toBe(0.03);
    expect(ledger.unattributed.funding).toBe(0.02);
  });

  it("keeps project funding lanes separate and cancels internal moves globally", async () => {
    const householdPerson = await insertWithShortcode(ctx.db, "person", {
      name: "Household member",
      kind: "household",
    });
    const guestPerson = await insertWithShortcode(ctx.db, "person", {
      name: "Guest contributor",
      kind: "guest",
    });
    const project = await insertWithShortcode(ctx.db, "project", {
      name: "Shared trip",
    });
    const sources = await getDb(ctx.db)
      .insert(fundingSource)
      .values([
        { kind: "person", personId: householdPerson.id },
        { kind: "person", personId: guestPerson.id },
        {
          kind: "shared_fund",
          fundKey: "trip-fund",
          name: "Trip fund",
        },
      ])
      .returning();
    if (sources.length !== 3)
      throw new Error("funding fixtures were not inserted");
    const expenseRow = await insertWithShortcode(ctx.db, "expense", {
      name: "Group lodging",
      cost: 10,
      date: "2026-08-20",
      costType: "services",
      trade: "other",
      future: false,
      projectId: project.id,
    });
    const account = await insertWithShortcode(ctx.db, "financialAccount", {
      name: "Shared cash card",
      identity: { kind: "cash" },
    });
    await setAccountFunding(
      ctx.db,
      {
        type: "set_account_funding",
        accountId: unsafeFinancialAccountShortcode(account.shortcode),
        fundingParty: { kind: "fund", key: "trip-fund" },
        people: [
          {
            personId: unsafePersonShortcode(householdPerson.shortcode),
            role: "joint_owner",
          },
          {
            personId: unsafePersonShortcode(guestPerson.shortcode),
            role: "joint_owner",
          },
        ],
      },
      ctx.actor,
    );
    const changes = previewHouseholdLedgerChangesInput.parse({
      changes: [
        {
          type: "set_expense_attribution",
          expenseIds: [expenseRow.shortcode],
          beneficiaries: {
            people: [{ personId: householdPerson.shortcode, weight: 1 }],
          },
          funders: {
            parties: [
              { party: { kind: "fund", key: "trip-fund" }, weight: 1 },
              {
                party: { kind: "person", id: guestPerson.shortcode },
                weight: 1,
              },
            ],
          },
        },
      ],
    });
    const preview = await previewHouseholdLedgerChanges(ctx.db, changes);
    await applyHouseholdLedgerChanges(
      ctx.db,
      applyHouseholdLedgerChangesInput.parse({
        ...changes,
        previewFingerprint: preview.previewFingerprint,
        idempotencyKey: "fixture:project-dual-totals",
      }),
      ctx.actor,
    );
    const transfer = await putFundingTransfer(ctx.db, {
      type: "put_funding_transfer",
      from: { kind: "fund", key: "trip-fund" },
      to: { kind: "fund", key: "trip-fund" },
      kind: "internal_account_move",
      amount: 2.5,
      date: "2026-08-20",
      sourceRefs: [],
      evidence: [],
    });

    const projectResult = await projectContribution(ctx.db, {
      projectId: unsafeProjectShortcode(project.shortcode),
      includeSubprojects: true,
    });
    expect(projectResult).toMatchObject({
      wholeGroupCost: 10,
      householdInitialExposure: 5,
      guestInitialFunding: 5,
      unattributedInitialFunding: 0,
    });
    expect(projectResult.people).toEqual([
      expect.objectContaining({
        personId: householdPerson.shortcode,
        consumed: 10,
      }),
    ]);
    expect(projectResult.funders).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          party: expect.objectContaining({ key: "trip-fund" }),
          initiallyFunded: 5,
        }),
        expect.objectContaining({
          party: expect.objectContaining({ key: guestPerson.shortcode }),
          initiallyFunded: 5,
        }),
      ]),
    );

    const ledger = await householdContributionLedger(ctx.db, {
      asOf: "2026-08-20",
    });
    const fund = ledger.parties.find(
      (party) => party.party.key === "trip-fund",
    );
    expect(fund).toMatchObject({
      initiallyOutlaid: 5,
      transfersSent: 2.5,
      transfersReceived: 2.5,
      netContribution: 5,
      position: 5,
    });
    expect(ledger.checks.transferNet).toBe(0);
    const transferId = transfer.transferIds[0];
    if (!transferId) throw new Error("transfer id was not returned");
    await deleteFundingTransfer(ctx.db, fundingTransferId.parse(transferId));
  });
});
