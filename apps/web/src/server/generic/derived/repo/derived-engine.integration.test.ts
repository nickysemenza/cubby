import type {
  InventoryId,
  LocationId,
  ProductId,
} from "@cubby/schemas/identifiers";
import { parseEntityId } from "@cubby/schemas/identifiers";
import { eq, sql } from "drizzle-orm";
import { createRepoEntity } from "tooling/factories/repo";
import { TEST_ACTOR, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb } from "~/server/db/helpers";
import {
  inventoryEntry,
  product,
  productUnitMappings,
} from "~/server/db/schema";
import { createInventoryEntry } from "~/server/domains/inventory/repo/crud";
import { createLocation } from "~/server/domains/location/repo/crud";
import { createProduct } from "~/server/domains/product/repo/crud";
import {
  claimDerivedMarks,
  markAllStoredDerived,
  prepareDerivedPage,
  publishDerivedPage,
} from "~/server/generic/derived/repo/drain";
import { loadStoredDerived } from "~/server/generic/derived/repo/read";
import { resolveLiveShortcode } from "~/server/generic/shortcode/repo/shortcode-resolver";
import {
  makeLocationInput,
  makeProductInput,
} from "~/server/testing/repo.fixtures";
import { derivedComputes } from "~/server/workflows/derived-computes";

/**
 * The derived engine's contract (ADR 0021): triggers mark only the saved row
 * and its endpoints, the drain clears a mark only when its ticket is
 * unchanged, and the cache rebuilds to the same values from scratch.
 */
describe("stored derived values", () => {
  const ctx = withTestDb();

  const resolved = async (
    shortcode: string,
    entity: "inventory" | "location" | "product",
  ) => {
    const id = await resolveLiveShortcode(ctx.db, shortcode, entity);
    if (!id) throw new Error(`Failed to resolve ${entity} ${shortcode}`);
    return id;
  };
  const makeProduct = async (name: string, price: number | null) => {
    const output = await createProduct(
      ctx.db,
      makeProductInput({ name, price }),
      TEST_ACTOR,
    );
    return parseEntityId("product", await resolved(output.id, "product"));
  };
  const makeLocation = async (name: string): Promise<LocationId> => {
    const output = await createLocation(
      ctx.db,
      makeLocationInput({ name }),
      TEST_ACTOR,
    );
    return parseEntityId("location", await resolved(output.id, "location"));
  };
  const makeEntry = async (
    productId: ProductId,
    locationId: LocationId,
    value: number,
  ): Promise<InventoryId> => {
    const entry = await createInventoryEntry(
      ctx.db,
      { productId, locationId, amount: { value, unit: "each" } },
      TEST_ACTOR,
    );
    return parseEntityId("inventory", await resolved(entry.id, "inventory"));
  };
  const marks = async (target: string) =>
    (
      await getDb(ctx.db).execute(
        sql`SELECT ref::text AS ref FROM "DerivedDirty" WHERE target = ${target} ORDER BY ref`,
      )
    ).rows.map((row) => String((row as { ref: string }).ref));
  const fanoutMarks = async (target: string) =>
    (
      await getDb(ctx.db).execute(
        sql`SELECT target, ref::text AS ref FROM "DerivedDirty" WHERE target LIKE ${`${target}@%`}`,
      )
    ).rows.map((row) => ({
      target: String((row as { target: string }).target),
      ref: String((row as { ref: string }).ref),
    }));
  const drain = async () => {
    for (let page = 0; page < 20; page++) {
      const claimed = await claimDerivedMarks(ctx.db);
      if (claimed.length === 0) return;
      const plan = await prepareDerivedPage(ctx.db, derivedComputes, claimed);
      await publishDerivedPage(ctx.db, plan);
    }
    throw new Error("Derived drain did not settle");
  };
  const valuation = async (id: InventoryId) =>
    (await loadStoredDerived(ctx.db, "inventory", [id], ["valuation"]))
      .get(id)
      ?.get("valuation");

  it("marks the saved rows and publishes their values", async () => {
    const location = await makeLocation("Pantry shelf");
    const beans = await makeProduct("Synthetic beans", 2.5);
    const entry = await makeEntry(beans, location, 4);
    expect(await marks("inventory.valuation")).toContain(entry);
    expect(await marks("product.price")).toContain(beans);

    expect((await valuation(entry))?.meta.state).toBe("missing");
    await drain();
    const stored = await valuation(entry);
    expect(stored?.value).toBe(10);
    expect(stored?.meta.state).toBe("fresh");
    expect(await marks("inventory.valuation")).toEqual([]);
  });

  it("marks nothing for a save that changes no declared input", async () => {
    const beans = await makeProduct("Synthetic lentils", 3);
    await drain();
    await getDb(ctx.db)
      .update(product)
      .set({ name: "Synthetic red lentils" })
      .where(eq(product.id, beans));
    expect(await marks("product.price")).toEqual([]);
    await getDb(ctx.db)
      .update(product)
      .set({ price: 4 })
      .where(eq(product.id, beans));
    expect(await marks("product.price")).toEqual([beans]);
  });

  it("keeps a record dirty when it changes during compute", async () => {
    const location = await makeLocation("Garage bin");
    const bolts = await makeProduct("Synthetic bolts", 1);
    const entry = await makeEntry(bolts, location, 2);
    await drain();

    await getDb(ctx.db)
      .update(inventoryEntry)
      .set({ amountValue: 3 })
      .where(eq(inventoryEntry.id, entry));
    const claimed = await claimDerivedMarks(ctx.db);
    const plan = await prepareDerivedPage(ctx.db, derivedComputes, claimed);
    // A save lands after the compute read its inputs.
    await getDb(ctx.db)
      .update(inventoryEntry)
      .set({ amountValue: 5 })
      .where(eq(inventoryEntry.id, entry));
    await publishDerivedPage(ctx.db, plan);
    expect(await marks("inventory.valuation")).toEqual([entry]);
    await drain();
    expect((await valuation(entry))?.value).toBe(5);
  });

  it("never clears a mark re-created after its ticket was claimed", async () => {
    const location = await makeLocation("Attic box");
    const nails = await makeProduct("Synthetic nails", 1);
    const entry = await makeEntry(nails, location, 1);
    const claimed = (await claimDerivedMarks(ctx.db)).filter(
      (mark) => mark.ref === entry,
    );
    const plan = await prepareDerivedPage(ctx.db, derivedComputes, claimed);
    // Delete and re-create the same mark: a fresh sequence ticket.
    await getDb(ctx.db).execute(
      sql`DELETE FROM "DerivedDirty" WHERE target = 'inventory.valuation' AND ref = ${entry}`,
    );
    await getDb(ctx.db).execute(
      sql`SELECT derived_mark('inventory.valuation', ARRAY[${entry}::uuid])`,
    );
    await publishDerivedPage(ctx.db, plan);
    expect(await marks("inventory.valuation")).toEqual([entry]);
  });

  it("marks both endpoints when a row moves to another record", async () => {
    const location = await makeLocation("Basement rack");
    const first = await makeProduct("Synthetic tape", 2);
    const second = await makeProduct("Synthetic glue", 2);
    const entry = await makeEntry(first, location, 1);
    await drain();
    await getDb(ctx.db)
      .update(inventoryEntry)
      .set({ productId: second })
      .where(eq(inventoryEntry.id, entry));
    expect(await marks("product.quantityVariance")).toEqual(
      [first, second].sort(),
    );
  });

  it("expands a fanout mark into its dependents outside the save", async () => {
    const location = await makeLocation("Workbench");
    const twine = await makeProduct("Synthetic twine", 6);
    const entry = await makeEntry(twine, location, 2);
    await drain();
    await getDb(ctx.db).insert(productUnitMappings).values({
      productId: twine,
      aValue: 1,
      aUnit: "each",
      bValue: 10,
      bUnit: "m",
    });
    // The save wrote one fanout mark, not a mark per inventory row.
    const fanout = await fanoutMarks("inventory.valuation");
    expect(fanout.map((mark) => mark.ref)).toEqual([twine]);
    expect(await marks("inventory.valuation")).toEqual([]);
    await drain();
    expect(await fanoutMarks("inventory.valuation")).toEqual([]);
    expect((await valuation(entry))?.meta.state).toBe("fresh");
  });

  it("marks inheriting subtasks when their parent's subject changes", async () => {
    const kettle = await createProduct(
      ctx.db,
      makeProductInput({ name: "Synthetic kettle" }),
      TEST_ACTOR,
    );
    const parent = await createRepoEntity(ctx, "task", {
      name: "Descale",
      trade: "appliances",
      subjectProductId: kettle.id,
    });
    const child = await createRepoEntity(ctx, "task", {
      name: "Buy vinegar",
      parentTaskId: parent.output.id,
    });
    await drain();
    await getDb(ctx.db)
      .update(product)
      .set({ name: "Synthetic kettle mk2" })
      .where(
        eq(
          product.id,
          parseEntityId("product", await resolved(kettle.id, "product")),
        ),
      );
    // Expand fanout marks only; the direct marks they create stay pending.
    while ((await fanoutMarks("task.searchDocument")).length > 0)
      await publishDerivedPage(
        ctx.db,
        await prepareDerivedPage(
          ctx.db,
          derivedComputes,
          await claimDerivedMarks(ctx.db),
        ),
      );
    expect(await marks("task.searchDocument")).toEqual(
      [parent, child].map((task) => task.entityId).sort(),
    );
  });

  it("recomputes dependents when a value they read changes", async () => {
    const location = await makeLocation("Closet");
    const soap = await makeProduct("Synthetic soap", 2);
    const entry = await makeEntry(soap, location, 3);
    await drain();
    expect((await valuation(entry))?.value).toBe(6);
    await getDb(ctx.db)
      .update(product)
      .set({ price: 3 })
      .where(eq(product.id, soap));
    await drain();
    expect((await valuation(entry))?.value).toBe(9);
  });

  it("discards marks with a rolled-back save", async () => {
    const soap = await makeProduct("Synthetic cleaner", 2);
    await drain();
    await getDb(ctx.db)
      .transaction(async (tx) => {
        await tx.update(product).set({ price: 9 }).where(eq(product.id, soap));
        tx.rollback();
      })
      .catch(() => undefined);
    expect(await marks("product.price")).toEqual([]);
  });

  it("reconciles every record once across its daily buckets", async () => {
    const location = await makeLocation("Garage shelf");
    for (const name of ["Synthetic tape", "Synthetic glue", "Synthetic rope"])
      await makeEntry(await makeProduct(name, 1), location, 1);
    await drain();
    const include = (declaration: { target: string }) =>
      declaration.target === "inventory.valuation";
    let marked = 0;
    for (let index = 0; index < 4; index++)
      marked += await markAllStoredDerived(ctx.db, include, {
        index,
        count: 4,
      });
    expect(marked).toBe(3);
    expect(await marks("inventory.valuation")).toHaveLength(3);
  });

  it("rebuilds the same values from an empty cache", async () => {
    const location = await makeLocation("Hall cupboard");
    const towels = await makeProduct("Synthetic towels", 4);
    await makeEntry(towels, location, 2);
    await drain();
    const snapshot = async () =>
      (
        await getDb(ctx.db).execute(
          sql`SELECT "entityId"::text, key, value FROM "DerivedValue" ORDER BY 1, 2`,
        )
      ).rows;
    const incremental = await snapshot();
    await getDb(ctx.db).execute(sql`DELETE FROM "DerivedValue"`);
    await markAllStoredDerived(ctx.db);
    await drain();
    expect(await snapshot()).toEqual(incremental);
  });
});
