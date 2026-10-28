import {
  type EntityId,
  type LedgerPartyShortcode,
  type ProductId,
  type ProductShortcode,
  parseEntityId,
  parseShortcodeFor,
} from "@cubby/schemas/identifiers";
import { OWNER_FILTER_HOUSEHOLD, OWNER_FILTER_UNKNOWN } from "@cubby/shared";
import { and, eq, sql } from "drizzle-orm";
import { buildEntity } from "tooling/factories/build";
import { raceUniqueInsert, TEST_ACTOR, withTestDb } from "tooling/test-setup";
import { describe, expect, it, vi } from "vitest";

import { getDb, notDeleted, withTransaction } from "~/server/db/helpers";
import { amountFromColumns } from "~/server/db/helpers";
import {
  expense,
  financialAccount,
  financialTransactionAllocation,
  inventoryEntry,
  purchase,
  product,
  vendorAccount,
} from "~/server/db/schema";
import {
  createExpense,
  readExpenseById,
} from "~/server/domains/expense/repo/crud";
import { moveInventoryEntries } from "~/server/domains/inventory/repo/bulk";
import {
  createInventoryEntry,
  deleteInventoryEntries,
  inventoryScaffold,
} from "~/server/domains/inventory/repo/crud";
import * as ownershipReads from "~/server/domains/inventory/repo/ownership";
import {
  loadEffectiveInventoryOwnershipById,
  computeProductOwners,
  productOwnerFilterSql,
} from "~/server/domains/inventory/repo/ownership";
import {
  confirmInventoryExpenseBeneficiary,
  confirmInventoryOwnership,
  setInventoryOwnership,
} from "~/server/domains/inventory/repo/ownership-mutations";
import {
  createLedgerParty,
  updateLedgerParty,
} from "~/server/domains/ledger-party/repo/ledger-party";
import { createLocation } from "~/server/domains/location/repo/crud";
import { createProduct } from "~/server/domains/product/repo/crud";
import { attachPurchaseProducts } from "~/server/domains/purchase/repo/purchase-products";
import { findOrCreateVendor } from "~/server/domains/vendor/repo/vendor";
import { executeEntity } from "~/server/entity-kernel";
import { buildKernelContext } from "~/server/entity-kernel/reference-universe.fixtures";
import { executeEntitySelectionIds } from "~/server/entity-kernel/selection-ids";
import { markExpiredClockDerived } from "~/server/generic/derived/repo/drain";
import { loadStoredDerived } from "~/server/generic/derived/repo/read";
import { selectedListProjection } from "~/server/generic/list/repo/list-projection";
import { selectListReadRows } from "~/server/generic/list/repo/list-read-schema";
import { resolveLiveShortcode } from "~/server/generic/shortcode/repo/shortcode-resolver";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";
import { drainStoredDerived } from "~/server/testing/background-queue";
import {
  createLocationFixture,
  createProductFixture,
  createProductIdentityFixture,
  listInventoryFixture,
  listProductsFixture,
  makeExpenseInput,
  makeLocationInput,
  makeProductInput,
} from "~/server/testing/repo.fixtures";

import { applyInventoryOwnershipInTransaction } from "./ownership-mutations";

describe("inventory ownership mutations", () => {
  const ctx = withTestDb();

  const productIdsByOwner = async (
    db: typeof ctx.db,
    values: readonly string[],
    presence?: "has" | "none",
  ) =>
    (
      await getDb(db)
        .select({ id: product.id })
        .from(product)
        .where(
          and(notDeleted(product), productOwnerFilterSql(values, presence)),
        )
    ).map((row) => row.id);

  const createSubject = async (name: string, value = 1) => {
    const [product, location] = await Promise.all([
      createProductFixture(
        ctx.db,
        makeProductInput({ name: `${name} product` }),
        TEST_ACTOR,
      ),
      createLocationFixture(
        ctx.db,
        makeLocationInput({ name: `${name} location` }),
        TEST_ACTOR,
      ),
    ]);
    const entry = await createInventoryEntry(
      ctx.db,
      {
        productId: product.entityId,
        locationId: location.entityId,
        amount: { value, unit: "each" },
      },
      TEST_ACTOR,
    );
    const entryId = await resolveLiveShortcode(ctx.db, entry.id, "inventory");
    if (!entryId) throw new Error(`Could not resolve ${entry.id}`);
    return {
      product,
      location,
      entryId: parseEntityId("inventory", entryId),
    };
  };

  it("keeps missing ownership distinct and applies current Household intent before publication", async () => {
    const subject = await createSubject("Stored ownership availability");
    const filters = { productIdFilter: [subject.product.id] };
    const page = { pageIndex: 0, pageSize: 12 };
    const productPage = () =>
      listProductsFixture(ctx.db, { ids: [subject.product.id] }, [], page);
    const membership = async () =>
      (
        await getDb(ctx.db)
          .select({
            unknown: productOwnerFilterSql([OWNER_FILTER_UNKNOWN]),
            household: productOwnerFilterSql([OWNER_FILTER_HOUSEHOLD]),
          })
          .from(product)
          .where(eq(product.id, subject.product.entityId))
      )[0];
    expect((await productPage()).data[0]?.owners).toBeNull();
    // NULL membership is unresolved, rather than a known false match.
    expect(await membership()).toEqual({ unknown: null, household: null });
    const excludingHousehold = () =>
      listProductsFixture(
        ctx.db,
        {
          ids: [subject.product.id],
          ownerLedgerPartyIdExclude: [OWNER_FILTER_HOUSEHOLD],
        },
        [],
        page,
      );
    expect(await excludingHousehold()).toMatchObject({
      count: 0,
      unresolvedCount: 1,
    });
    const unresolved = () =>
      executeEntity(buildKernelContext(ctx.db), {
        action: "list",
        entity: "product",
        filters: {
          ids: [subject.product.id],
          ownerLedgerPartyId: [OWNER_FILTER_HOUSEHOLD],
        },
        resultMembership: "unresolved",
        pagination: page,
      });
    expect(await unresolved()).toMatchObject({
      meta: { totalCount: 1, unresolvedCount: 1 },
      items: [{ id: subject.product.id }],
    });
    expect(
      await executeEntitySelectionIds(buildKernelContext(ctx.db), {
        entity: "product",
        filters: {
          ids: [subject.product.id],
          ownerLedgerPartyId: [OWNER_FILTER_HOUSEHOLD],
        },
        resultMembership: "unresolved",
      }),
    ).toMatchObject({ ids: [subject.product.id], totalCount: 1 });
    const filtered = (owner: string) =>
      listInventoryFixture(
        ctx.db,
        { ...filters, ownerLedgerPartyId: [owner] },
        [],
        page,
      );
    expect(await filtered(OWNER_FILTER_UNKNOWN)).toMatchObject({
      count: 0,
      unresolvedCount: 1,
    });
    expect(await productIdsByOwner(ctx.db, [], "none")).not.toContain(
      subject.product.entityId,
    );
    await drainStoredDerived(ctx.db);
    expect((await productPage()).data[0]?.owners).toEqual([
      { label: "Unknown", ref: null, inherited: true },
    ]);
    expect(await filtered(OWNER_FILTER_UNKNOWN)).toMatchObject({
      count: 1,
      unresolvedCount: 0,
    });
    expect(await membership()).toEqual({ unknown: true, household: false });
    expect(await excludingHousehold()).toMatchObject({
      count: 1,
      unresolvedCount: 0,
    });
    expect(await unresolved()).toMatchObject({
      meta: { totalCount: 0, unresolvedCount: 0 },
      items: [],
    });
    await setInventoryOwnership(
      ctx.db,
      subject.entryId,
      { mode: "explicit", ownerId: null },
      undefined,
      TEST_ACTOR,
    );
    expect((await filtered(OWNER_FILTER_HOUSEHOLD)).count).toBe(1);
    expect((await filtered(OWNER_FILTER_UNKNOWN)).count).toBe(0);
    // Product is a computed collection and retains its selected publication until refreshed.
    expect(await productIdsByOwner(ctx.db, [OWNER_FILTER_UNKNOWN])).toContain(
      subject.product.entityId,
    );
    await drainStoredDerived(ctx.db);
    expect(await productIdsByOwner(ctx.db, [OWNER_FILTER_HOUSEHOLD])).toContain(
      subject.product.entityId,
    );
    expect(
      await productIdsByOwner(ctx.db, [OWNER_FILTER_UNKNOWN]),
    ).not.toContain(subject.product.entityId);
    await setInventoryOwnership(
      ctx.db,
      subject.entryId,
      { mode: "inherit" },
      undefined,
      TEST_ACTOR,
    );
    // A reset withholds an old own snapshot; it cannot claim its cached fallback is current.
    expect((await filtered(OWNER_FILTER_UNKNOWN)).count).toBe(0);
    await drainStoredDerived(ctx.db);
    expect((await filtered(OWNER_FILTER_UNKNOWN)).count).toBe(1);
  });

  it("marks totals incomplete without a derived filter until valuation contributors are published", async () => {
    const subject = await createSubject("Synthetic incomplete valuation");
    const read = () =>
      executeEntity(buildKernelContext(ctx.db), {
        action: "list",
        entity: "inventory",
        filters: { productIdFilter: [subject.product.id] },
        pagination: { pageIndex: 0, pageSize: 10 },
      });
    expect(await read()).toMatchObject({
      meta: {
        totalCount: 1,
        incompleteSums: ["valuation"],
        sums: {},
        totalLabels: { valuation: "Incomplete · $0.00 known" },
      },
    });
    await drainStoredDerived(ctx.db);
    const complete = await read();
    expect(complete).not.toHaveProperty("meta.incompleteSums");
    expect(complete).toMatchObject({
      meta: { totalCount: 1, sums: { valuation: expect.any(Number) } },
    });
  });

  it("expires ownership at a household-day boundary without inventing pending work or resetting failures", async () => {
    const subject = await createSubject("Calendar ownership expiry");
    await drainStoredDerived(ctx.db);
    await getDb(ctx.db).execute(sql`
      UPDATE "DerivedValue" SET "computedAt" = (now() AT TIME ZONE 'UTC') - interval '2 days'
      WHERE "entityId" = ${subject.entryId} AND key = 'ownership'`);
    const read = async () =>
      (
        await loadStoredDerived(
          ctx.db,
          "inventory",
          [subject.entryId],
          ["ownership"],
        )
      )
        .get(subject.entryId)
        ?.get("ownership");
    expect(await read()).toMatchObject({
      resultExists: true,
      stale: true,
      pending: false,
    });
    expect(await markExpiredClockDerived(ctx.db)).toBeGreaterThan(0);
    expect(await read()).toMatchObject({ stale: true, pending: true });
    await getDb(ctx.db).execute(sql`
      UPDATE "WorkItem" SET "lastError" = 'synthetic retry', "readyAt" = (now() AT TIME ZONE 'UTC') + interval '1 hour'
      WHERE target = 'inventory.ownership' AND ref = ${subject.entryId}`);
    expect(await markExpiredClockDerived(ctx.db)).toBe(0);
    expect(await read()).toMatchObject({
      error: "synthetic retry",
      pending: true,
    });
    await getDb(ctx.db).execute(sql`
      UPDATE "WorkItem" SET "readyAt" = now() AT TIME ZONE 'UTC'
      WHERE target = 'inventory.ownership' AND ref = ${subject.entryId}`);
    await drainStoredDerived(ctx.db);
    expect(await read()).toMatchObject({
      stale: false,
      pending: false,
      error: null,
    });
    expect(await markExpiredClockDerived(ctx.db)).toBe(0);
  });

  const addPurchase = async (args: {
    label: string;
    date?: string;
    links?: ProductId[];
    lines: Array<{
      name: string;
      ownerId: LedgerPartyShortcode | null;
      productId: ProductShortcode | null;
      cost?: number;
      productQuantity?: number | null;
      future?: boolean;
    }>;
  }) => {
    const vendorId = await findOrCreateVendor(
      ctx.db,
      `Ownership vendor ${args.label}`,
    );
    const purchase = await insertWithShortcode(ctx.db, "purchase", {
      vendorId,
      date: args.date ?? "2026-09-01",
      displayLabel: args.label,
    });
    if (args.links?.length) {
      await attachPurchaseProducts(ctx.db, purchase.id, args.links, TEST_ACTOR);
    }
    const expenses = [];
    for (const line of args.lines) {
      expenses.push(
        await createExpense(
          ctx.db,
          buildEntity(
            "expense",
            makeExpenseInput({
              name: line.name,
              purchaseId: parseShortcodeFor("purchase", purchase.shortcode),
              productId: line.productId,
              cost: line.cost ?? 100,
              productQuantity: line.productQuantity ?? null,
              future: line.future ?? false,
              beneficiaries: [{ partyId: line.ownerId, weight: 1 }],
            }),
          ),
          TEST_ACTOR,
        ),
      );
    }
    return { purchase, expenses };
  };

  // Selected identity/price reads must not resolve acquisition ownership, but
  // selecting ownership reads its published result without resolving acquisition evidence.
  it("reads published ownership only for its selected consumers", async () => {
    const owner = await createLedgerParty(
      ctx.db,
      { name: "Selected inventory owner", kind: "member", notes: null },
      TEST_ACTOR,
    );
    const subject = await createSubject("Selected inventory");
    await addPurchase({
      label: "selected inventory acquisition",
      lines: [
        {
          name: "Selected acquisition",
          ownerId: owner.output.id,
          productId: subject.product.id,
        },
      ],
    });
    const filters = { productIdFilter: [subject.product.id] };
    const page = { pageIndex: 0, pageSize: 12 };
    await drainStoredDerived(ctx.db);
    const full = await listInventoryFixture(ctx.db, filters, [], page);
    expect(full.data[0]?.ownerLedgerPartyId).toBe(owner.output.id);
    const read = async (fields: readonly string[]) => {
      const projection = selectedListProjection("inventory", fields);
      const result = await inventoryScaffold.read(ctx.db, {
        filters,
        sorts: [],
        pagination: page,
        projection,
      });
      return {
        count: result.count,
        data: selectListReadRows("inventory", result.data, fields),
      };
    };
    const ownership = vi.spyOn(ownershipReads, "loadInventoryOwnershipTraces");
    try {
      const fields = ["id", "amount", "product", "location"];
      const selected = await read(fields);
      expect(selected.count).toBe(full.count);
      expect(selected.data).toEqual(
        selectListReadRows("inventory", full.data, fields),
      );
      expect(ownership).not.toHaveBeenCalled();
      for (const field of [
        "ownerLedgerPartyId",
        "effectiveOwnership",
        "fieldResolutions",
      ]) {
        ownership.mockClear();
        const requested = ["id", field];
        expect((await read(requested)).data).toEqual(
          selectListReadRows("inventory", full.data, requested),
        );
        expect(ownership).not.toHaveBeenCalled();
      }
    } finally {
      ownership.mockRestore();
    }
  });

  // Replacement itemization can persist the ledger's implicit unknown shares.
  // Those rows must not suppress account defaults or change financial history.
  it.each(["vendor", "payment"] as const)(
    "inherits %s account ownership through unattributed expenses for stocked and unstocked products",
    async (source) => {
      const owner = await createLedgerParty(
        ctx.db,
        { name: "Unknown attribution owner", kind: "member", notes: null },
        TEST_ACTOR,
      );
      const subject = await createSubject("Unknown attribution");
      const unstocked = await createProductFixture(
        ctx.db,
        makeProductInput({ name: "Unknown attribution unstocked product" }),
        TEST_ACTOR,
      );
      const acquired = await addPurchase({
        label: "unknown attribution acquisition",
        lines: [subject.product, unstocked].map((product) => ({
          name: "Unattributed acquisition line",
          ownerId: null,
          productId: product.id,
        })),
      });
      const dbc = getDb(ctx.db);
      const account = await insertWithShortcode(ctx.db, "vendorAccount", {
        vendorId: acquired.purchase.vendorId,
        ledgerPartyId: owner.entityId,
        inventoryOwnerDefaultEnabled: false,
      });
      await dbc
        .update(purchase)
        .set({ vendorAccountId: account.id })
        .where(eq(purchase.id, acquired.purchase.id));
      const paymentAccount = await insertWithShortcode(
        ctx.db,
        "financialAccount",
        {
          name: "Unknown attribution payment account",
          identity: { kind: "cash" },
          ledgerPartyId: owner.entityId,
          inventoryOwnerDefaultEnabled: false,
        },
      );
      const payment = await insertWithShortcode(
        ctx.db,
        "financialTransaction",
        {
          accountId: paymentAccount.id,
          kind: "purchase",
          status: "posted",
          amount: 200,
          transactionDate: "2026-09-01",
          postedDate: "2026-09-01",
        },
      );
      await dbc.insert(financialTransactionAllocation).values({
        transactionId: payment.id,
        purchaseId: acquired.purchase.id,
        amount: 200,
      });
      const before = await Promise.all(
        acquired.expenses.map((row) => readExpenseById(ctx.db, row.entityId)),
      );
      // Warming derived beneficiary results may enrich reads. Ownership
      // inference must preserve the stored Expense evidence and allocations.
      const storedExpenses = () =>
        Promise.all(
          acquired.expenses.map((row) =>
            dbc.select().from(expense).where(eq(expense.id, row.entityId)),
          ),
        );
      const storedBefore = await storedExpenses();
      expect(before.map((row) => row.beneficiaries)).toEqual([
        [{ partyId: null, weight: 1 }],
        [{ partyId: null, weight: 1 }],
      ]);
      expect(
        (await loadEffectiveInventoryOwnershipById(ctx.db, subject.entryId))
          ?.effectiveOwner,
      ).toBeNull();

      if (source === "vendor") {
        await dbc
          .update(vendorAccount)
          .set({ inventoryOwnerDefaultEnabled: true })
          .where(eq(vendorAccount.id, account.id));
      } else {
        await dbc
          .update(financialAccount)
          .set({ inventoryOwnerDefaultEnabled: true })
          .where(eq(financialAccount.id, paymentAccount.id));
      }
      const effective = await loadEffectiveInventoryOwnershipById(
        ctx.db,
        subject.entryId,
      );
      expect(effective?.effectiveOwner?.id).toBe(owner.output.id);
      expect(effective?.source).toBe(
        source === "vendor"
          ? "inherited_vendor_account"
          : "inherited_payment_account",
      );
      const productIds = [subject.product.entityId, unstocked.entityId];
      const owners = await computeProductOwners(ctx.db, productIds);
      for (const id of productIds) {
        expect(owners.get(id)).toEqual([
          {
            label:
              id === unstocked.entityId
                ? "Unknown attribution owner · from purchase"
                : "Unknown attribution owner",
            ref: { entityKind: "ledgerParty", entityId: owner.output.id },
            inherited: true,
          },
        ]);
      }
      await drainStoredDerived(ctx.db);
      expect(await productIdsByOwner(ctx.db, [owner.output.id])).toEqual(
        expect.arrayContaining(productIds),
      );
      const inventory = await listInventoryFixture(
        ctx.db,
        { ownerLedgerPartyId: [owner.output.id] },
        [],
        { pageIndex: 0, pageSize: 50 },
      );
      expect(inventory.data.map((row) => row.displayName)).toEqual([
        expect.stringContaining("Unknown attribution product"),
      ]);
      expect(await storedExpenses()).toEqual(storedBefore);
      expect(
        (
          await Promise.all(
            acquired.expenses.map((row) =>
              readExpenseById(ctx.db, row.entityId),
            ),
          )
        ).map((row) => row.beneficiaries),
      ).toEqual(before.map((row) => row.beneficiaries));
    },
  );

  it("assigns an explicit owner without acquisition evidence, splits quantity, and preserves ownership while moving", async () => {
    const owner = await createLedgerParty(
      ctx.db,
      { name: "Wardrobe owner", kind: "member", notes: null },
      TEST_ACTOR,
    );
    const product = await createProduct(
      ctx.db,
      makeProductInput({ name: "Test garment" }),
      TEST_ACTOR,
    );
    const [closet, drawer] = await Promise.all([
      createLocation(
        ctx.db,
        makeLocationInput({ name: "Test closet" }),
        TEST_ACTOR,
      ),
      createLocation(
        ctx.db,
        makeLocationInput({ name: "Test drawer" }),
        TEST_ACTOR,
      ),
    ]);
    const resolve = async <E extends "product" | "location" | "inventory">(
      entity: E,
      shortcode: string,
    ): Promise<EntityId<E>> => {
      const id = await resolveLiveShortcode(ctx.db, shortcode, entity);
      if (!id) throw new Error(`Could not resolve ${shortcode}`);
      return parseEntityId(entity, id);
    };
    const productId = await resolve("product", product.id);
    const closetId = await resolve("location", closet.id);
    const drawerId = await resolve("location", drawer.id);
    const entry = await createInventoryEntry(
      ctx.db,
      {
        productId,
        locationId: closetId,
        amount: { value: 3, unit: "each" },
      },
      TEST_ACTOR,
    );
    const entryId = await resolve("inventory", entry.id);

    const changed = await setInventoryOwnership(
      ctx.db,
      entryId,
      { mode: "explicit", ownerId: owner.output.id },
      1,
      TEST_ACTOR,
    );
    expect(changed).toHaveLength(2);

    const rows = await getDb(ctx.db).query.inventoryEntry.findMany({
      where: eq(inventoryEntry.productId, productId),
    });
    const inherited = rows.find((row) => row.ownershipMode === "inherit");
    const explicit = rows.find((row) => row.ownershipMode === "explicit");
    if (!inherited || !explicit) {
      throw new Error("Expected inherited and explicit ownership rows");
    }
    expect(amountFromColumns(inherited).value).toBe(2);
    expect(amountFromColumns(explicit).value).toBe(1);
    expect(explicit.ownerLedgerPartyId).toBe(owner.entityId);
    const effective = await loadEffectiveInventoryOwnershipById(
      ctx.db,
      explicit.id,
    );
    expect(effective?.effectiveOwner?.id).toBe(owner.output.id);
    expect(effective?.source).toBe("explicit");

    await moveInventoryEntries(
      ctx.db,
      {
        items: [{ inventoryEntryId: explicit.id, targetLocationId: drawerId }],
      },
      TEST_ACTOR,
    );
    const moved = await getDb(ctx.db).query.inventoryEntry.findFirst({
      where: eq(inventoryEntry.id, explicit.id),
    });
    expect(moved).toMatchObject({
      locationId: drawerId,
      ownershipMode: "explicit",
      ownerLedgerPartyId: owner.entityId,
    });
  });

  it("refuses a partial quantity larger than the row and leaves the row unchanged", async () => {
    const owner = await createLedgerParty(
      ctx.db,
      { name: "Bounded owner", kind: "member", notes: null },
      TEST_ACTOR,
    );
    const subject = await createSubject("Bounded quantity", 3);
    await expect(
      setInventoryOwnership(
        ctx.db,
        subject.entryId,
        { mode: "explicit", ownerId: owner.output.id },
        4,
        TEST_ACTOR,
      ),
    ).rejects.toThrow("Cannot reassign 4; only 3 is available.");
    const rows = await getDb(ctx.db).query.inventoryEntry.findMany({
      where: and(
        eq(inventoryEntry.productId, subject.product.entityId),
        notDeleted(inventoryEntry),
      ),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      ownershipMode: "inherit",
      ownerLedgerPartyId: null,
    });
    expect(amountFromColumns(rows[0]!).value).toBe(3);
  });

  it("serializes concurrent partial ownership transfers and conserves quantity", async () => {
    const [firstOwner, secondOwner, subject] = await Promise.all([
      createLedgerParty(
        ctx.db,
        { name: "Concurrent first owner", kind: "member", notes: null },
        TEST_ACTOR,
      ),
      createLedgerParty(
        ctx.db,
        { name: "Concurrent second owner", kind: "guest", notes: null },
        TEST_ACTOR,
      ),
      createSubject("Concurrent ownership", 10),
    ]);

    const { loser } = await raceUniqueInsert(ctx, {
      winner: async ({ releaseSignal, markWinnerReady }) =>
        await withTransaction(ctx.db, async (tx) => {
          const result = await applyInventoryOwnershipInTransaction(
            tx,
            subject.entryId,
            {
              ownershipMode: "explicit",
              ownerLedgerPartyId: firstOwner.entityId,
            },
            6,
            TEST_ACTOR,
          );
          markWinnerReady();
          await releaseSignal;
          return result;
        }),
      loser: async () => {
        try {
          await setInventoryOwnership(
            ctx.db,
            subject.entryId,
            { mode: "explicit", ownerId: secondOwner.output.id },
            6,
            TEST_ACTOR,
          );
          return { status: "fulfilled" as const };
        } catch (error) {
          return { status: "rejected" as const, error };
        }
      },
    });

    expect(loser).toMatchObject({
      status: "rejected",
      error: { reason: "CONSTRAINT_VIOLATION" },
    });
    const rows = await getDb(ctx.db).query.inventoryEntry.findMany({
      where: and(
        eq(inventoryEntry.productId, subject.product.entityId),
        notDeleted(inventoryEntry),
      ),
    });
    expect(
      rows.reduce((total, row) => total + amountFromColumns(row).value, 0),
    ).toBe(10);
    expect(
      rows.map((row) => ({
        value: amountFromColumns(row).value,
        ownershipMode: row.ownershipMode,
        ownerLedgerPartyId: row.ownerLedgerPartyId,
      })),
    ).toEqual(
      expect.arrayContaining([
        {
          value: 4,
          ownershipMode: "inherit",
          ownerLedgerPartyId: null,
        },
        {
          value: 6,
          ownershipMode: "explicit",
          ownerLedgerPartyId: firstOwner.entityId,
        },
      ]),
    );
    expect(
      rows.some((row) => row.ownerLedgerPartyId === secondOwner.entityId),
    ).toBe(false);
  });

  it("deduplicates explicit purchase links and isolates product and purchase-level evidence", async () => {
    const [owner, otherOwner] = await Promise.all([
      createLedgerParty(
        ctx.db,
        { name: "Primary buyer", kind: "member", notes: null },
        TEST_ACTOR,
      ),
      createLedgerParty(
        ctx.db,
        { name: "Other buyer", kind: "guest", notes: null },
        TEST_ACTOR,
      ),
    ]);
    const [target, sparse, unrelated] = await Promise.all([
      createSubject("Target lines"),
      createSubject("Sparse link"),
      createProductFixture(
        ctx.db,
        makeProductInput({ name: "Unrelated order product" }),
        TEST_ACTOR,
      ),
    ]);
    const { expenses } = await addPurchase({
      label: "mixed acquisition",
      links: [target.product.entityId, sparse.product.entityId],
      lines: [
        {
          name: "target line one",
          ownerId: owner.output.id,
          productId: target.product.id,
        },
        {
          name: "target line two",
          ownerId: owner.output.id,
          productId: target.product.id,
        },
        {
          name: "purchase-level allocation",
          ownerId: owner.output.id,
          productId: null,
        },
        {
          name: "unrelated product line",
          ownerId: otherOwner.output.id,
          productId: unrelated.id,
        },
      ],
    });

    const [targetOwnership, sparseOwnership] = await Promise.all([
      loadEffectiveInventoryOwnershipById(ctx.db, target.entryId),
      loadEffectiveInventoryOwnershipById(ctx.db, sparse.entryId),
    ]);
    expect(targetOwnership).toMatchObject({
      source: "inherited_beneficiary",
      effectiveOwner: { id: owner.output.id },
    });
    expect(targetOwnership?.evidence?.expenseIds).toEqual(
      [expenses[0]!.output.id, expenses[1]!.output.id].sort(),
    );
    expect(sparseOwnership).toMatchObject({
      source: "inherited_beneficiary",
      effectiveOwner: { id: owner.output.id },
    });
    expect(sparseOwnership?.evidence?.expenseIds).toEqual([
      expenses[2]!.output.id,
    ]);
  });

  it("blocks inherited ownership after a second purchase while preserving a confirmed owner", async () => {
    const [firstOwner, secondOwner] = await Promise.all([
      createLedgerParty(
        ctx.db,
        { name: "First buyer", kind: "member", notes: null },
        TEST_ACTOR,
      ),
      createLedgerParty(
        ctx.db,
        { name: "Second buyer", kind: "guest", notes: null },
        TEST_ACTOR,
      ),
    ]);
    const subject = await createSubject("Ambiguous purchase");
    await addPurchase({
      label: "first acquisition",
      lines: [
        {
          name: "first acquisition",
          ownerId: firstOwner.output.id,
          productId: subject.product.id,
        },
      ],
    });
    const inferred = await loadEffectiveInventoryOwnershipById(
      ctx.db,
      subject.entryId,
    );
    expect(inferred?.effectiveOwner?.id).toBe(firstOwner.output.id);
    expect(inferred?.source).toBe("inherited_beneficiary");
    await confirmInventoryOwnership(
      ctx.db,
      subject.entryId,
      inferred!.evidenceFingerprint,
      undefined,
      TEST_ACTOR,
    );
    await addPurchase({
      label: "second acquisition",
      lines: [
        {
          name: "second acquisition",
          ownerId: secondOwner.output.id,
          productId: subject.product.id,
        },
      ],
    });
    const secondLocation = await createLocationFixture(
      ctx.db,
      makeLocationInput({ name: "Ambiguous second location" }),
      TEST_ACTOR,
    );
    const inheritedEntry = await createInventoryEntry(
      ctx.db,
      {
        productId: subject.product.entityId,
        locationId: secondLocation.entityId,
        amount: { value: 1, unit: "each" },
      },
      TEST_ACTOR,
    );
    const inheritedId = await resolveLiveShortcode(
      ctx.db,
      inheritedEntry.id,
      "inventory",
    );
    if (!inheritedId) throw new Error("Could not resolve inherited entry");
    const [pinned, ambiguous] = await Promise.all([
      loadEffectiveInventoryOwnershipById(ctx.db, subject.entryId),
      loadEffectiveInventoryOwnershipById(
        ctx.db,
        parseEntityId("inventory", inheritedId),
      ),
    ]);
    expect(pinned).toMatchObject({
      source: "explicit",
      effectiveOwner: { id: firstOwner.output.id },
    });
    expect(ambiguous).toMatchObject({
      source: "unresolved",
      effectiveOwner: null,
      evidence: null,
    });
  });

  it("does not treat sales, refunds, or future lines as acquisitions", async () => {
    const owner = await createLedgerParty(
      ctx.db,
      { name: "Exit beneficiary", kind: "member", notes: null },
      TEST_ACTOR,
    );
    const subject = await createSubject("Exit-only evidence");
    await addPurchase({
      label: "exit-only order",
      links: [subject.product.entityId],
      lines: [
        {
          name: "sale",
          ownerId: owner.output.id,
          productId: subject.product.id,
          cost: -50,
          productQuantity: -1,
        },
        {
          name: "refund",
          ownerId: owner.output.id,
          productId: subject.product.id,
          cost: -10,
          productQuantity: 0,
        },
        {
          name: "future replacement",
          ownerId: owner.output.id,
          productId: subject.product.id,
          future: true,
        },
      ],
    });

    expect(
      await loadEffectiveInventoryOwnershipById(ctx.db, subject.entryId),
    ).toMatchObject({
      source: "unresolved",
      effectiveOwner: null,
      evidence: null,
    });
  });

  it("does not treat a purchase dated household-tomorrow as acquired on a UTC-tomorrow evening", async () => {
    // 18:30 PDT on Aug 31 is already Sep 1 in UTC; the Workers runtime is UTC.
    vi.useFakeTimers({
      toFake: ["Date"],
      now: new Date("2026-09-01T01:30:00Z"),
    });
    try {
      const owner = await createLedgerParty(
        ctx.db,
        { name: "Tomorrow beneficiary", kind: "member", notes: null },
        TEST_ACTOR,
      );
      const subject = await createSubject("Household tomorrow");
      await addPurchase({
        label: "tomorrow order",
        date: "2026-09-01",
        links: [subject.product.entityId],
        lines: [
          {
            name: "preorder",
            ownerId: owner.output.id,
            productId: subject.product.id,
          },
        ],
      });

      expect(
        await loadEffectiveInventoryOwnershipById(ctx.db, subject.entryId),
      ).toMatchObject({ source: "unresolved", effectiveOwner: null });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a confirmed Expense beneficiary after its inventory entry is removed", async () => {
    const owner = await createLedgerParty(
      ctx.db,
      { name: "Durable beneficiary", kind: "member", notes: null },
      TEST_ACTOR,
    );
    const subject = await createSubject("Durable beneficiary");
    await setInventoryOwnership(
      ctx.db,
      subject.entryId,
      { mode: "explicit", ownerId: owner.output.id },
      undefined,
      TEST_ACTOR,
    );
    const createdExpense = await createExpense(
      ctx.db,
      buildEntity(
        "expense",
        makeExpenseInput({
          name: "Durable beneficiary expense",
          productId: subject.product.id,
          beneficiaries: [],
        }),
      ),
      TEST_ACTOR,
    );
    const ownership = await loadEffectiveInventoryOwnershipById(
      ctx.db,
      subject.entryId,
    );
    await confirmInventoryExpenseBeneficiary(
      ctx.db,
      subject.entryId,
      createdExpense.entityId,
      ownership!.evidenceFingerprint,
      TEST_ACTOR,
    );
    await deleteInventoryEntries(ctx.db, [subject.entryId], TEST_ACTOR);

    expect(
      (await readExpenseById(ctx.db, createdExpense.entityId)).beneficiaries,
    ).toEqual([{ partyId: owner.output.id, weight: 1 }]);
  });

  it("preserves the individual-owner invariant when a referenced party changes kind", async () => {
    const owner = await createLedgerParty(
      ctx.db,
      { name: "Changing owner", kind: "member", notes: null },
      TEST_ACTOR,
    );
    const subject = await createSubject("Changing owner");
    await setInventoryOwnership(
      ctx.db,
      subject.entryId,
      { mode: "explicit", ownerId: owner.output.id },
      undefined,
      TEST_ACTOR,
    );

    await updateLedgerParty(
      ctx.db,
      owner.output.id,
      { kind: "guest" },
      TEST_ACTOR,
    );
    expect(
      await loadEffectiveInventoryOwnershipById(ctx.db, subject.entryId),
    ).toMatchObject({
      source: "explicit",
      effectiveOwner: { id: owner.output.id, kind: "guest" },
    });

    await expect(
      updateLedgerParty(
        ctx.db,
        owner.output.id,
        { kind: "household" },
        TEST_ACTOR,
      ),
    ).rejects.toThrow("singleton household ledger party cannot change kind");
    expect(
      await loadEffectiveInventoryOwnershipById(ctx.db, subject.entryId),
    ).toMatchObject({
      source: "explicit",
      effectiveOwner: { id: owner.output.id, kind: "guest" },
    });
  });
  // Owner filters (My stuff, Wardrobe) match the EFFECTIVE owner, so inherited
  // stock is someone's stuff; a stored-owner match would drop it.
  it("filters inventory and products by effective owner, including inherited and unstocked rows", async () => {
    const buyer = await createLedgerParty(
      ctx.db,
      { name: "Filter buyer", kind: "member", notes: null },
      TEST_ACTOR,
    );
    const [inherited, unassigned] = await Promise.all([
      createSubject("Filter inherited"),
      createSubject("Filter unassigned"),
    ]);
    const unstocked = await createProductIdentityFixture(
      ctx.db,
      makeProductInput({ name: "Filter unstocked product" }),
      TEST_ACTOR,
    );
    await addPurchase({
      label: "filter acquisitions",
      lines: [
        {
          name: "inherited line",
          ownerId: buyer.output.id,
          productId: inherited.product.id,
        },
        {
          name: "unstocked line",
          ownerId: buyer.output.id,
          productId: unstocked.id,
        },
      ],
    });
    await setInventoryOwnership(
      ctx.db,
      unassigned.entryId,
      { mode: "explicit", ownerId: null },
      undefined,
      TEST_ACTOR,
    );
    const page = { pageIndex: 0, pageSize: 50 };
    const names = async (filters: Parameters<typeof listInventoryFixture>[1]) =>
      (await listInventoryFixture(ctx.db, filters, [], page)).data.map(
        (row) => row.displayName,
      );
    await drainStoredDerived(ctx.db);
    expect(await names({ ownerLedgerPartyId: [buyer.output.id] })).toEqual([
      expect.stringContaining("Filter inherited product"),
    ]);
    expect(
      await names({ ownerLedgerPartyId: [OWNER_FILTER_HOUSEHOLD] }),
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Filter unassigned product"),
      ]),
    );
    expect(
      await names({ ownerLedgerPartyId: [OWNER_FILTER_HOUSEHOLD] }),
    ).not.toEqual(
      expect.arrayContaining([
        expect.stringContaining("Filter inherited product"),
      ]),
    );
    const owned = await productIdsByOwner(ctx.db, [buyer.output.id]);
    expect(owned).toEqual(
      expect.arrayContaining([inherited.product.entityId, unstocked.entityId]),
    );
    expect(owned).not.toContain(unassigned.product.entityId);
    await setInventoryOwnership(
      ctx.db,
      unassigned.entryId,
      { mode: "explicit", ownerId: buyer.output.id },
      undefined,
      TEST_ACTOR,
    );
    await drainStoredDerived(ctx.db);
    expect(await productIdsByOwner(ctx.db, [buyer.output.id])).toContain(
      unassigned.product.entityId,
    );
  });
});
