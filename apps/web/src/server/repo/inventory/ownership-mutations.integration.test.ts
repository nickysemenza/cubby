import { amount } from "@cubby/schemas/codec";
import {
  type EntityId,
  type LedgerPartyShortcode,
  type ProductId,
  type ProductShortcode,
  parseEntityId,
  parseShortcodeFor,
} from "@cubby/schemas/identifiers";
import { expenseCreateInput } from "@cubby/schemas/project";
import { and, eq } from "drizzle-orm";
import { raceUniqueInsert, TEST_ACTOR, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { inventoryEntry } from "~/server/db/schema";
import { getDb, notDeleted } from "~/server/repo/database-helpers";
import { createExpense, getExpenseByID } from "~/server/repo/expense";
import {
  confirmInventoryExpenseBeneficiary,
  confirmInventoryOwnership,
  createInventoryEntry,
  deleteInventoryEntries,
  loadEffectiveInventoryOwnershipById,
  moveInventoryEntries,
  setInventoryOwnership,
} from "~/server/repo/inventory";
import {
  createLedgerParty,
  updateLedgerParty,
} from "~/server/repo/ledger-party";
import { createLocation } from "~/server/repo/location";
import { createProduct } from "~/server/repo/product";
import { attachPurchaseProducts } from "~/server/repo/purchase-products";
import {
  createLocationFixture,
  createProductFixture,
  makeExpenseInput,
  makeLocationInput,
  makeProductInput,
} from "~/server/repo/repo.fixtures";
import { resolveLiveShortcode } from "~/server/repo/shortcode-resolver";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import { findOrCreateVendor } from "~/server/repo/vendor";

import { applyInventoryOwnershipInTransaction } from "./ownership-mutations";

describe("inventory ownership mutations", () => {
  const ctx = withTestDb();

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

  const addPurchase = async (args: {
    label: string;
    links?: ProductId[];
    lines: Array<{
      name: string;
      ownerId: LedgerPartyShortcode;
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
      date: "2026-09-01",
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
          expenseCreateInput.parse(
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
      { mode: "person", ownerId: owner.output.id },
      1,
      TEST_ACTOR,
    );
    expect(changed).toHaveLength(2);

    const rows = await getDb(ctx.db).query.inventoryEntry.findMany({
      where: eq(inventoryEntry.productId, productId),
    });
    const inherited = rows.find((row) => row.ownershipMode === "inherit");
    const explicit = rows.find((row) => row.ownershipMode === "person");
    if (!inherited || !explicit) {
      throw new Error("Expected inherited and explicit ownership rows");
    }
    expect(amount.parse(inherited.amount).value).toBe(2);
    expect(amount.parse(explicit.amount).value).toBe(1);
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
      ownershipMode: "person",
      ownerLedgerPartyId: owner.entityId,
    });
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
        await getDb(ctx.db).transaction(async (tx) => {
          const result = await applyInventoryOwnershipInTransaction(
            tx,
            subject.entryId,
            {
              ownershipMode: "person",
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
            { mode: "person", ownerId: secondOwner.output.id },
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
      rows.reduce((total, row) => total + amount.parse(row.amount).value, 0),
    ).toBe(10);
    expect(
      rows.map((row) => ({
        value: amount.parse(row.amount).value,
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
          ownershipMode: "person",
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
      { mode: "person", ownerId: owner.output.id },
      undefined,
      TEST_ACTOR,
    );
    const createdExpense = await createExpense(
      ctx.db,
      expenseCreateInput.parse(
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
      (await getExpenseByID(ctx.db, createdExpense.entityId)).beneficiaries,
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
      { mode: "person", ownerId: owner.output.id },
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
});
