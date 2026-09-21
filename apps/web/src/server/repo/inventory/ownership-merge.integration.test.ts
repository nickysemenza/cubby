import { amount } from "@cubby/schemas/codec";
import type {
  LedgerPartyId,
  LocationId,
  ProductId,
} from "@cubby/schemas/identifiers";
import { and, eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { inventoryEntry } from "~/server/db/schema";
import { getDb, notDeleted } from "~/server/repo/database-helpers";
import { createInventoryEntry } from "~/server/repo/inventory";
import {
  createLedgerParty,
  mergeLedgerParties,
} from "~/server/repo/ledger-party";
import { mergeProducts } from "~/server/repo/product";
import {
  createLocationFixture,
  createProductFixture,
  makeLocationInput,
  makeProductInput,
} from "~/server/repo/repo.fixtures";
import { resolveLiveShortcode } from "~/server/repo/shortcode-resolver";

describe("inventory ownership through product and ledger-party merges", () => {
  const ctx = withTestDb();

  const member = (name: string) =>
    createLedgerParty(ctx.db, { name, kind: "member", notes: null }, ctx.actor);

  const subject = async (name: string) => {
    const [keeper, loser, location] = await Promise.all([
      createProductFixture(
        ctx.db,
        makeProductInput({ name: `${name} keeper` }),
        ctx.actor,
      ),
      createProductFixture(
        ctx.db,
        makeProductInput({ name: `${name} loser` }),
        ctx.actor,
      ),
      createLocationFixture(
        ctx.db,
        makeLocationInput({ name: `${name} shelf` }),
        ctx.actor,
      ),
    ]);
    return { keeper, loser, location };
  };

  const createOwnedEntry = async (args: {
    productId: ProductId;
    locationId: LocationId;
    ownerId: LedgerPartyId;
    value: number;
    unit: string;
  }) =>
    await createInventoryEntry(
      ctx.db,
      {
        productId: args.productId,
        locationId: args.locationId,
        amount: { value: args.value, unit: args.unit },
        ownershipMode: "person",
        ownerLedgerPartyId: args.ownerId,
      },
      ctx.actor,
    );

  const liveRows = async (productId: ProductId) =>
    await getDb(ctx.db).query.inventoryEntry.findMany({
      where: and(
        eq(inventoryEntry.productId, productId),
        notDeleted(inventoryEntry),
      ),
      orderBy: inventoryEntry.id,
    });

  it("folds product inventory only when location, placement, and raw owner are compatible", async () => {
    const [owner, { keeper, loser, location }] = await Promise.all([
      member("Compatible product owner"),
      subject("Compatible product merge"),
    ]);
    await Promise.all([
      createOwnedEntry({
        productId: keeper.entityId,
        locationId: location.entityId,
        ownerId: owner.entityId,
        value: 2,
        unit: "each",
      }),
      createOwnedEntry({
        productId: loser.entityId,
        locationId: location.entityId,
        ownerId: owner.entityId,
        value: 3,
        unit: "each",
      }),
    ]);

    await mergeProducts(
      ctx.db,
      { keepId: keeper.id, mergeIds: [loser.id] },
      ctx.actor,
    );

    const rows = await liveRows(keeper.entityId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      productId: keeper.entityId,
      locationId: location.entityId,
      placement: "stock",
      ownershipMode: "person",
      ownerLedgerPartyId: owner.entityId,
    });
    expect(amount.parse(rows[0]!.amount)).toEqual({
      value: 5,
      unit: "each",
    });
  });

  it("keeps different raw owners in distinct slots during a product merge", async () => {
    const [firstOwner, secondOwner, { keeper, loser, location }] =
      await Promise.all([
        member("First distinct owner"),
        member("Second distinct owner"),
        subject("Distinct-owner product merge"),
      ]);
    await Promise.all([
      createOwnedEntry({
        productId: keeper.entityId,
        locationId: location.entityId,
        ownerId: firstOwner.entityId,
        value: 2,
        unit: "each",
      }),
      createOwnedEntry({
        productId: loser.entityId,
        locationId: location.entityId,
        ownerId: secondOwner.entityId,
        value: 3,
        unit: "each",
      }),
    ]);

    await mergeProducts(
      ctx.db,
      { keepId: keeper.id, mergeIds: [loser.id] },
      ctx.actor,
    );

    const rows = await liveRows(keeper.entityId);
    expect(rows).toHaveLength(2);
    expect(
      rows.map((row) => ({
        ownerLedgerPartyId: row.ownerLedgerPartyId,
        ownershipMode: row.ownershipMode,
        amount: amount.parse(row.amount),
      })),
    ).toEqual(
      expect.arrayContaining([
        {
          ownerLedgerPartyId: firstOwner.entityId,
          ownershipMode: "person",
          amount: { value: 2, unit: "each" },
        },
        {
          ownerLedgerPartyId: secondOwner.entityId,
          ownershipMode: "person",
          amount: { value: 3, unit: "each" },
        },
      ]),
    );
  });

  it("refuses a product fold with incompatible units without moving or deleting either row", async () => {
    const [owner, { keeper, loser, location }] = await Promise.all([
      member("Product unit mismatch owner"),
      subject("Product unit mismatch"),
    ]);
    await Promise.all([
      createOwnedEntry({
        productId: keeper.entityId,
        locationId: location.entityId,
        ownerId: owner.entityId,
        value: 2,
        unit: "each",
      }),
      createOwnedEntry({
        productId: loser.entityId,
        locationId: location.entityId,
        ownerId: owner.entityId,
        value: 3,
        unit: "pair",
      }),
    ]);

    await expect(
      mergeProducts(
        ctx.db,
        { keepId: keeper.id, mergeIds: [loser.id] },
        ctx.actor,
      ),
    ).rejects.toThrow("different units");

    expect(await liveRows(keeper.entityId)).toHaveLength(1);
    expect(await liveRows(loser.entityId)).toHaveLength(1);
    expect(
      await resolveLiveShortcode(ctx.db, loser.id, "product"),
    ).not.toBeNull();
  });

  it("folds explicit-owner rows when their ledger parties merge", async () => {
    const [keeperOwner, loserOwner, product, location] = await Promise.all([
      member("Keeper inventory owner"),
      member("Loser inventory owner"),
      createProductFixture(
        ctx.db,
        makeProductInput({ name: "Ledger-party merge garment" }),
        ctx.actor,
      ),
      createLocationFixture(
        ctx.db,
        makeLocationInput({ name: "Ledger-party merge shelf" }),
        ctx.actor,
      ),
    ]);
    await Promise.all([
      createOwnedEntry({
        productId: product.entityId,
        locationId: location.entityId,
        ownerId: keeperOwner.entityId,
        value: 2,
        unit: "each",
      }),
      createOwnedEntry({
        productId: product.entityId,
        locationId: location.entityId,
        ownerId: loserOwner.entityId,
        value: 3,
        unit: "each",
      }),
    ]);

    const result = await mergeLedgerParties(
      ctx.db,
      { keepId: keeperOwner.output.id, mergeIds: [loserOwner.output.id] },
      ctx.actor,
    );

    expect(result.mergeSummary.inventoryEdgesRepointed).toBe(1);
    const rows = await liveRows(product.entityId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      ownershipMode: "person",
      ownerLedgerPartyId: keeperOwner.entityId,
    });
    expect(amount.parse(rows[0]!.amount)).toEqual({
      value: 5,
      unit: "each",
    });
  });

  it("rolls back a ledger-party merge when its ownership fold has incompatible units", async () => {
    const [keeperOwner, loserOwner, product, location] = await Promise.all([
      member("Keeper mismatched owner"),
      member("Loser mismatched owner"),
      createProductFixture(
        ctx.db,
        makeProductInput({ name: "Ledger-party unit mismatch garment" }),
        ctx.actor,
      ),
      createLocationFixture(
        ctx.db,
        makeLocationInput({ name: "Ledger-party unit mismatch shelf" }),
        ctx.actor,
      ),
    ]);
    await Promise.all([
      createOwnedEntry({
        productId: product.entityId,
        locationId: location.entityId,
        ownerId: keeperOwner.entityId,
        value: 2,
        unit: "each",
      }),
      createOwnedEntry({
        productId: product.entityId,
        locationId: location.entityId,
        ownerId: loserOwner.entityId,
        value: 3,
        unit: "pair",
      }),
    ]);

    await expect(
      mergeLedgerParties(
        ctx.db,
        {
          keepId: keeperOwner.output.id,
          mergeIds: [loserOwner.output.id],
        },
        ctx.actor,
      ),
    ).rejects.toThrow("reconcile the units first");

    const rows = await liveRows(product.entityId);
    expect(rows).toHaveLength(2);
    expect(
      rows.map((row) => ({
        ownerLedgerPartyId: row.ownerLedgerPartyId,
        amount: amount.parse(row.amount),
      })),
    ).toEqual(
      expect.arrayContaining([
        {
          ownerLedgerPartyId: keeperOwner.entityId,
          amount: { value: 2, unit: "each" },
        },
        {
          ownerLedgerPartyId: loserOwner.entityId,
          amount: { value: 3, unit: "pair" },
        },
      ]),
    );
    expect(
      await resolveLiveShortcode(ctx.db, loserOwner.output.id, "ledgerParty"),
    ).not.toBeNull();
  });
});
