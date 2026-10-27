import type {
  InventoryId,
  LocationId,
  ProductId,
} from "@cubby/schemas/identifiers";
import { parseEntityId, parseShortcodeFor } from "@cubby/schemas/identifiers";
import { and, eq, sql } from "drizzle-orm";
import { createRepoEntity } from "tooling/factories/repo";
import {
  countTestDbQueries,
  seedEntity,
  TEST_ACTOR,
  withTestDb,
} from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getEntityDetailOutputSchema } from "~/entity/generated/entity-details.gen";
import {
  getDb,
  databaseForTransaction,
  unwrapDb,
  uuidArrayParam,
  withTransaction,
} from "~/server/db/helpers";
import {
  inventoryEntry,
  email as emailTable,
  entityLink,
  expense,
  product,
  productUnitMappings,
  recipe as recipeTable,
  task as taskTable,
} from "~/server/db/schema";
import { findOrCreateIngredient } from "~/server/domains/ingredient/repo/crud";
import { createInventoryEntry } from "~/server/domains/inventory/repo/crud";
import { createLocation } from "~/server/domains/location/repo/crud";
import { createProduct } from "~/server/domains/product/repo/crud";
import { attachProductComponents } from "~/server/domains/product/repo/product-components";
import { syntheticRetainedMail } from "~/server/domains/purchase-import/service/gmail/retained-mail.fixtures";
import { executeEntity } from "~/server/entity-kernel";
import { buildKernelContext } from "~/server/entity-kernel/reference-universe.fixtures";
import {
  publishAssessment,
  recordFeedback,
} from "~/server/generic/assessment/repo/assessment";
import { derivedSink } from "~/server/generic/derived/repo/compute";
import {
  claimDerivedMarks,
  markAllStoredDerived,
  prepareDerivedPage,
  publishDerivedPage,
} from "~/server/generic/derived/repo/drain";
import { explainLiveDerived } from "~/server/generic/derived/repo/explain";
import { loadStoredDerived } from "~/server/generic/derived/repo/read";
import { attachLinks } from "~/server/generic/entity-links/repo/entity-links";
import {
  withJobBatchExecution,
  withJobExecution,
} from "~/server/generic/jobs/context";
import { claimJob, enqueueJob } from "~/server/generic/jobs/repo/jobs";
import { resolveLiveShortcode } from "~/server/generic/shortcode/repo/shortcode-resolver";
import {
  makeLocationInput,
  makeProductInput,
  createProductIdentityFixture,
  createRecipeFixture,
  ingredientRef,
  makeRecipeInput,
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

    expect((await valuation(entry))?.resultExists).toBe(false);
    await drain();
    const stored = await valuation(entry);
    expect(stored?.value).toBe(10);
    expect(stored).toMatchObject({ resultExists: true, stale: false });
    expect(await marks("inventory.valuation")).toEqual([]);

    const [identity] = await getDb(ctx.db)
      .select({ code: inventoryEntry.shortcode })
      .from(inventoryEntry)
      .where(eq(inventoryEntry.id, entry));
    if (!identity) throw new Error("Synthetic inventory identity is missing");
    const code = parseShortcodeFor("inventory", identity.code);
    const context = buildKernelContext(ctx.db);
    const detail = async () => {
      const result = await executeEntity(context, {
        action: "get",
        entity: "inventory",
        id: code,
        missing: "error",
      });
      if (result.action !== "get") throw new Error("Expected a record read");
      return getEntityDetailOutputSchema("inventory").parse(result.item);
    };
    const published = await detail();
    expect(published).toMatchObject({
      fields: {
        valuation: {
          result: {
            kind: "cached",
            freshness: "fresh",
            decision: { outcome: { kind: "value", value: 10 } },
          },
        },
      },
    });
    await executeEntity(context, {
      action: "update",
      entity: "inventory",
      id: code,
      data: { amount: { value: 5, unit: "each" } },
    });
    expect(await detail()).toMatchObject({
      fields: {
        valuation: {
          result: {
            kind: "cached",
            freshness: "stale",
            decision: { outcome: { kind: "value", value: 10 } },
          },
        },
      },
    });
    const productDetail = await executeEntity(context, {
      action: "get",
      entity: "product",
      id: published.product.id,
      missing: "error",
    });
    if (productDetail.action !== "get")
      throw new Error("Expected a Product read");
    expect(
      getEntityDetailOutputSchema("product").parse(productDetail.item),
    ).toMatchObject({
      inventoryEntry: [
        {
          id: identity.code,
          fields: {
            valuation: {
              result: {
                kind: "cached",
                decision: { outcome: { kind: "value", value: 10 } },
              },
            },
          },
        },
      ],
    });
    expect(
      await explainLiveDerived(
        ctx.db,
        derivedComputes,
        "inventory",
        "valuation",
        entry,
      ),
    ).toMatchObject({
      kind: "available",
      result: {
        kind: "live",
        decision: { outcome: { kind: "value", value: 12.5 } },
      },
    });
    expect((await valuation(entry))?.value).toBe(10);
  });

  it("claims newer member edits before older background source writes without demoting member work", async () => {
    const background = await makeProduct("Synthetic background source", 2);
    const member = await makeProduct("Synthetic member source", 3);
    // Isolate source capture from fixture creation, without invoking compute adapters.
    await getDb(ctx.db).execute(sql`DELETE FROM "DerivedDirty"`);
    const saved = await enqueueJob(ctx.db, {
      key: "synthetic:derived-source-priority",
      kind: "image.cloud",
      input: {},
    });
    const claim = await claimJob(ctx.db, saved.id);
    if (!claim) throw new Error("Expected synthetic Job claim");
    const rename = (id: ProductId, name: string) =>
      withTransaction(ctx.db, (tx) =>
        tx.update(product).set({ name }).where(eq(product.id, id)),
      );
    await withJobExecution(ctx.db, claim, () =>
      rename(background, "Synthetic background source changed"),
    );
    const backgroundMarks = await claimDerivedMarks(ctx.db);
    expect(backgroundMarks.length).toBeGreaterThan(0);
    expect(
      backgroundMarks.map(({ target, priority }) => ({ target, priority })),
    ).toEqual(backgroundMarks.map(({ target }) => ({ target, priority: 1 })));

    await rename(member, "Synthetic member source changed");
    expect((await claimDerivedMarks(ctx.db, 1))[0]?.ref).toBe(member);
    await withJobExecution(ctx.db, claim, () =>
      rename(member, "Synthetic background follow-up"),
    );
    expect(
      (await claimDerivedMarks(ctx.db))
        .filter((mark) => mark.ref === member)
        .every((mark) => mark.priority === 0),
    ).toBe(true);
    await rename(background, "Synthetic member promotion");
    expect(
      (await claimDerivedMarks(ctx.db)).every((mark) => mark.priority === 0),
    ).toBe(true);
  });

  it("keeps caller-owned member transactions at member priority inside a Job scope", async () => {
    const item = await makeProduct("Synthetic nested priority", 2);
    await getDb(ctx.db).execute(sql`DELETE FROM "DerivedDirty"`);
    const saved = await enqueueJob(ctx.db, {
      key: "synthetic:derived-nested-priority",
      kind: "image.cloud",
      input: {},
    });
    const claim = await claimJob(ctx.db, saved.id);
    if (!claim) throw new Error("Expected synthetic Job claim");
    await withTransaction(ctx.db, (outer) => {
      const db = databaseForTransaction(outer);
      return withJobExecution(db, claim, () =>
        withTransaction(db, (inner) =>
          inner
            .update(product)
            .set({ name: "Synthetic nested member change" })
            .where(eq(product.id, item)),
        ),
      );
    });
    const pending = await claimDerivedMarks(ctx.db);
    expect(pending.length).toBeGreaterThan(0);
    expect(pending.every((mark) => mark.priority === 0)).toBe(true);
  });

  it("inherits background priority through savepoints and clears it after rollback", async () => {
    const item = await makeProduct("Synthetic batch priority", 2);
    await getDb(ctx.db).execute(sql`DELETE FROM "DerivedDirty"`);
    await expect(
      withJobBatchExecution(() =>
        withTransaction(ctx.db, async (outer) => {
          const db = databaseForTransaction(outer);
          await withTransaction(db, (inner) =>
            inner
              .update(product)
              .set({ name: "Synthetic batch change" })
              .where(eq(product.id, item)),
          );
          const pending = await claimDerivedMarks(db);
          expect(pending.length).toBeGreaterThan(0);
          expect(pending.every((mark) => mark.priority === 1)).toBe(true);
          throw new Error("Synthetic batch rollback");
        }),
      ),
    ).rejects.toThrow("Synthetic batch rollback");
    expect(await claimDerivedMarks(ctx.db)).toEqual([]);
    await withTransaction(ctx.db, (tx) =>
      tx
        .update(product)
        .set({ name: "Synthetic member after rollback" })
        .where(eq(product.id, item)),
    );
    const pending = await claimDerivedMarks(ctx.db);
    expect(pending.length).toBeGreaterThan(0);
    expect(pending.every((mark) => mark.priority === 0)).toBe(true);
  });

  it("backs off a long-failing target without overflowing the delay", async () => {
    const beans = await makeProduct("Synthetic failing beans", 2);
    await drain();
    await getDb(ctx.db).execute(sql`
      INSERT INTO "DerivedDirty" (target, ref, priority, attempts)
      VALUES ('product.price', ${beans}, 0, 60)
      ON CONFLICT (target, ref) DO UPDATE SET attempts = 60`);
    const failing = {
      ...derivedComputes,
      "product.price": async () => {
        throw new Error(`Synthetic query wrapper ${"x".repeat(2200)}`, {
          cause: new Error("Synthetic compute failure"),
        });
      },
    };
    await publishDerivedPage(
      ctx.db,
      await prepareDerivedPage(
        ctx.db,
        failing,
        await claimDerivedMarks(ctx.db),
      ),
    );
    const [row] = (
      await getDb(ctx.db).execute(sql`
        SELECT attempts, "lastError", "readyAt" <= now() + interval '15 minutes' AS bounded
          FROM "DerivedDirty" WHERE target = 'product.price' AND ref = ${beans}`)
    ).rows;
    expect(row).toMatchObject({
      attempts: 61,
      lastError: expect.stringContaining("Synthetic compute failure"),
      bounded: true,
    });
    expect(row).toMatchObject({
      lastError: expect.stringContaining("Synthetic query wrapper"),
    });
  });

  it("rings readers with the shortcodes of the records it published", async () => {
    const created = await createProduct(
      ctx.db,
      makeProductInput({ name: "Synthetic ringing beans", price: 2 }),
      TEST_ACTOR,
    );
    const publication = await publishDerivedPage(
      ctx.db,
      await prepareDerivedPage(
        ctx.db,
        derivedComputes,
        await claimDerivedMarks(ctx.db),
      ),
    );
    expect(publication.categories).toContain("product");
    expect(publication.changes.product).toContain(created.id);
  });

  it("backs off a malformed decision while publishing other value targets", async () => {
    const beans = await makeProduct("Synthetic invalid decision", 2);
    const claimed = (await claimDerivedMarks(ctx.db)).filter(
      (mark) =>
        mark.target === "product.price" ||
        mark.target === "product.ledgerExpectedQuantity",
    );
    const plan = await prepareDerivedPage(
      ctx.db,
      {
        ...derivedComputes,
        "product.price": async () =>
          new Map([
            [
              beans,
              {
                value: 2,
                sort: 2,
                decision: {
                  outcome: { kind: "empty", reason: "unset" },
                  provenance: { kind: "computed" },
                } as const,
              },
            ],
          ]),
      },
      claimed,
    );
    expect(plan.failed.get("product.price")).toContain(
      "Derived outcome does not match",
    );
    await publishDerivedPage(ctx.db, plan);
    const stored = await loadStoredDerived(
      ctx.db,
      "product",
      [beans],
      ["price", "ledgerExpectedQuantity"],
    );
    expect(stored.get(beans)?.get("price")?.resultExists).toBe(false);
    expect(stored.get(beans)?.get("ledgerExpectedQuantity")?.value).toBe(0);
    expect(await marks("product.ledgerExpectedQuantity")).not.toContain(beans);
    const [failure] = (
      await getDb(ctx.db).execute(sql`
      SELECT attempts, "lastError" FROM "DerivedDirty" WHERE target = 'product.price' AND ref = ${beans}
    `)
    ).rows;
    expect(failure).toMatchObject({
      attempts: 1,
      lastError: expect.stringContaining("Derived outcome does not match"),
    });
  });

  it("publishes the rest of a page when the database rejects one target's write", async () => {
    const location = await makeLocation("Synthetic rejecting shelf");
    const beans = await makeProduct("Synthetic rejected beans", 2);
    const entry = await makeEntry(beans, location, 3);
    await unwrapDb(ctx.db).execute(sql`ALTER TABLE "DerivedValue"
      ADD CONSTRAINT "SyntheticPriceRejected" CHECK (value IS DISTINCT FROM '2'::jsonb) NOT VALID`);
    try {
      const rejecting = {
        ...derivedComputes,
        // A sink whose write the database rejects for its data (SQLSTATE 22P02).
        "search.product": derivedSink({
          prepare: async () => null,
          publish: async (tx) => {
            await unwrapDb(tx).execute(sql`SELECT 'not a number'::int`);
            return [];
          },
        }),
      };
      for (let page = 0; page < 20; page++) {
        const claimed = await claimDerivedMarks(ctx.db);
        if (claimed.every((mark) => mark.target === "product.searchDocument"))
          break;
        await publishDerivedPage(
          ctx.db,
          await prepareDerivedPage(ctx.db, rejecting, claimed),
        );
      }
      expect((await valuation(entry))?.value).toBe(6);
      const [failed] = (
        await getDb(ctx.db).execute(sql`
        SELECT attempts, "lastError" FROM "DerivedDirty"
         WHERE target = 'product.searchDocument' AND ref = ${beans}`)
      ).rows;
      expect(failed).toMatchObject({
        attempts: 1,
        lastError: expect.stringContaining("invalid input syntax"),
      });
      const [rejectedValue] = (
        await unwrapDb(ctx.db).execute(sql`
      SELECT attempts, "lastError" FROM "DerivedDirty"
       WHERE target = 'product.price' AND ref = ${beans}`)
      ).rows;
      expect(rejectedValue).toMatchObject({
        attempts: 1,
        lastError: expect.stringContaining("SyntheticPriceRejected"),
      });
      const stored = await loadStoredDerived(
        ctx.db,
        "product",
        [beans],
        ["price", "dataQuality"],
      );
      expect(stored.get(beans)?.get("price")?.value).toBeNull();
      expect(stored.get(beans)?.get("dataQuality")).toMatchObject({
        resultExists: true,
        stale: false,
        error: null,
      });
    } finally {
      await unwrapDb(ctx.db).execute(
        sql`ALTER TABLE "DerivedValue" DROP CONSTRAINT "SyntheticPriceRejected"`,
      );
    }
  });

  it("publishes a record-writing sink without waiting on a member's open save", async () => {
    const dish = await seedEntity(ctx.db, "recipe", {
      name: "Synthetic locked dish",
    });
    const recipeId = await resolveLiveShortcode(ctx.db, dish.id, "recipe");
    if (!recipeId) throw new Error("Synthetic recipe missing");
    await drain();
    await getDb(ctx.db).execute(
      sql`SELECT derived_mark('recipe.totals', ARRAY[${recipeId}::uuid])`,
    );
    // The sink writes the Recipe row itself, like recipe totals.
    const rowWriting = {
      ...derivedComputes,
      "recipe.totals": derivedSink({
        prepare: async () => null,
        publish: async (tx, ids) => {
          await unwrapDb(tx).execute(sql`
            UPDATE "Recipe" SET "totalsComputedAt" = now()
             WHERE id = ANY(${uuidArrayParam(ids)})`);
          return [...ids];
        },
      }),
    };
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const rowLocked = new Promise<void>((resolve) => (locked = resolve));
    // A member save holds the Recipe row (and then its marks) until released.
    const memberSave = withTransaction(ctx.db, async (tx) => {
      await tx.execute(
        sql`UPDATE "Recipe" SET notes = 'Synthetic edit' WHERE id = ${recipeId}`,
      );
      locked();
      await held;
    });
    await rowLocked;
    const claimed = (await claimDerivedMarks(ctx.db)).filter(
      (mark) => mark.target === "recipe.totals",
    );
    expect(claimed.map((mark) => mark.ref)).toContain(recipeId);
    await publishDerivedPage(
      ctx.db,
      await prepareDerivedPage(ctx.db, rowWriting, claimed),
    );
    // The locked record was skipped, not waited on; its mark stays pending.
    expect(await marks("recipe.totals")).toContain(recipeId);
    release();
    await memberSave;
    await drain();
    expect(await marks("recipe.totals")).toEqual([]);
  });

  it("publishes available value marks and removals while a writer holds another mark", async () => {
    const busy = await makeProduct("Synthetic busy value", 2);
    const available = await makeProduct("Synthetic available value", 3);
    const removed = await makeProduct("Synthetic removed value", 4);
    await drain();
    await getDb(ctx.db)
      .update(product)
      .set({ price: 5 })
      .where(eq(product.id, busy));
    await getDb(ctx.db)
      .update(product)
      .set({ price: 6 })
      .where(eq(product.id, available));
    await getDb(ctx.db)
      .update(product)
      .set({ deletedAt: new Date() })
      .where(eq(product.id, removed));
    const plan = await prepareDerivedPage(
      ctx.db,
      derivedComputes,
      (await claimDerivedMarks(ctx.db)).filter(
        (mark) =>
          mark.target === "product.price" ||
          mark.target === "product.ledgerExpectedQuantity",
      ),
    );
    expect(
      plan.marks.filter((mark) => mark.target === "product.price"),
    ).toHaveLength(3);
    const locked = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const writer = withTransaction(ctx.db, async (tx) => {
      await tx.execute(
        sql`SELECT ref FROM "DerivedDirty" WHERE target = 'product.price' AND ref = ${busy}::uuid FOR UPDATE`,
      );
      locked.resolve();
      await release.promise;
    });
    await locked.promise;
    const prices = async () =>
      await loadStoredDerived(
        ctx.db,
        "product",
        [busy, available, removed],
        ["price", "ledgerExpectedQuantity"],
      );
    try {
      await withTransaction(ctx.db, async (tx) => {
        await tx.execute(sql`SET LOCAL statement_timeout = '500ms'`);
        await publishDerivedPage(databaseForTransaction(tx), plan);
      });
      const stored = await prices();
      expect(stored.get(busy)?.get("price")?.value).toBe(2);
      expect(stored.get(available)?.get("price")?.value).toBe(6);
      expect(stored.get(available)?.get("ledgerExpectedQuantity")?.value).toBe(
        0,
      );
      expect(stored.get(removed)?.get("price")).toMatchObject({
        resultExists: false,
        computedAt: null,
      });

      expect(await marks("product.price")).toEqual([busy]);
    } finally {
      release.resolve();
      await writer;
    }
    // Replaying the plan may publish the skipped ticket, but cannot restore cleared values.
    await publishDerivedPage(ctx.db, plan);
    const stored = await prices();
    expect(stored.get(busy)?.get("price")?.value).toBe(5);
    expect(stored.get(available)?.get("price")?.value).toBe(6);
    expect(stored.get(removed)?.get("price")).toMatchObject({
      resultExists: false,
      computedAt: null,
    });
    expect(await marks("product.price")).toEqual([]);
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
    // Price and unit mapping inputs reach the same dependent in one page.
    await getDb(ctx.db)
      .update(product)
      .set({ price: 7 })
      .where(eq(product.id, twine));
    expect((await fanoutMarks("inventory.valuation")).length).toBeGreaterThan(
      1,
    );
    const plan = await prepareDerivedPage(
      ctx.db,
      derivedComputes,
      (await claimDerivedMarks(ctx.db)).filter((mark) =>
        mark.target.includes("@"),
      ),
    );
    const expansion = await countTestDbQueries(() =>
      publishDerivedPage(ctx.db, plan),
    );
    // One expansion statement and one shortcode lookup for reader notifications.
    expect(expansion.statements).toHaveLength(2);
    expect(await marks("inventory.valuation")).toContain(entry);
    await drain();
    expect(await fanoutMarks("inventory.valuation")).toEqual([]);
    expect(await valuation(entry)).toMatchObject({
      resultExists: true,
      stale: false,
    });
  });

  it("leaves a writer's busy fanout mark pending without blocking publication", async () => {
    const location = await makeLocation("Synthetic fanout shelf");
    const item = await makeProduct("Synthetic fanout item", 2);
    await makeEntry(item, location, 1);
    await drain();
    await getDb(ctx.db)
      .update(product)
      .set({ price: 3 })
      .where(eq(product.id, item));
    const plan = await prepareDerivedPage(
      ctx.db,
      derivedComputes,
      (await claimDerivedMarks(ctx.db)).filter((mark) =>
        mark.target.startsWith("inventory.valuation@"),
      ),
    );
    expect(plan.marks.length).toBeGreaterThan(0);
    const held = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const writer = withTransaction(ctx.db, async (tx) => {
      await tx.execute(sql`SELECT ref FROM "DerivedDirty"
        WHERE target LIKE 'inventory.valuation@%' AND ref = ${item}::uuid FOR UPDATE`);
      held.resolve();
      await release.promise;
    });
    await held.promise;
    try {
      await withTransaction(ctx.db, async (tx) => {
        await tx.execute(sql`SET LOCAL statement_timeout = '500ms'`);
        await publishDerivedPage(databaseForTransaction(tx), plan);
      });
      expect((await fanoutMarks("inventory.valuation")).length).toBeGreaterThan(
        0,
      );
    } finally {
      release.resolve();
      await writer;
    }
    await drain();
    expect(await fanoutMarks("inventory.valuation")).toEqual([]);
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
    // Expand in a background transaction; member priority must survive the Job.
    while ((await fanoutMarks("task.searchDocument")).length > 0) {
      const plan = await prepareDerivedPage(
        ctx.db,
        derivedComputes,
        (await claimDerivedMarks(ctx.db, 10_000)).filter((mark) =>
          mark.target.startsWith("task.searchDocument@"),
        ),
      );
      await withJobBatchExecution(() =>
        withTransaction(ctx.db, (tx) =>
          publishDerivedPage(databaseForTransaction(tx), plan),
        ),
      );
    }
    expect(await marks("task.searchDocument")).toEqual(
      [parent, child].map((task) => task.entityId).sort(),
    );
    // An edit's dependents keep its priority instead of queuing behind backfill.
    const priorities = await getDb(ctx.db).execute(
      sql`SELECT DISTINCT priority FROM "DerivedDirty" WHERE target = 'task.searchDocument'`,
    );
    expect(priorities.rows).toEqual([{ priority: 0 }]);
  });

  it("marks JSON subject references and follows Feedback to its Email", async () => {
    const owner = await createRepoEntity(ctx, "ledgerParty");
    const original = await syntheticRetainedMail(ctx.db, {
      ledgerPartyId: parseEntityId("ledgerParty", owner.entityId),
      rawChecksum: "a".repeat(64),
      mailboxId: "synthetic-derived",
      messageId: "synthetic-review",
    });
    const [email] = await getDb(ctx.db)
      .select({ id: emailTable.id })
      .from(emailTable)
      .where(eq(emailTable.orderMailId, original.id));
    if (!email) throw new Error("Synthetic Email was not created");
    const emailId = email.id;
    await drain();
    const assessment = await publishAssessment(ctx.db, {
      publicationKey: `synthetic-review:${crypto.randomUUID()}`,
      family: "email_relevance",
      subject: {
        kind: "email_relevance",
        entity: "email",
        recordId: emailId,
        checksum: null,
        observationId: null,
      },
      judgment: { classification: "related", stage: "model" },
      fingerprint: null,
      producer: null,
      evidence: null,
    });
    expect(
      (await fanoutMarks("email.dataQuality")).map((mark) => mark.ref),
    ).toContain(emailId);
    await drain();
    await recordFeedback(ctx.db, {
      assessmentId: assessment.id,
      operationId: "synthetic-review",
      verdict: "correct",
      correction: { present: false },
      authority: "member",
      actorUserId: TEST_ACTOR.userId,
      intent: "history",
    });
    expect(
      (await fanoutMarks("email.dataQuality")).map((mark) => mark.ref),
    ).toContain(assessment.id);
    const claimed = (await claimDerivedMarks(ctx.db)).filter((mark) =>
      mark.target.startsWith("email.dataQuality@"),
    );
    await publishDerivedPage(
      ctx.db,
      await prepareDerivedPage(ctx.db, derivedComputes, claimed),
    );
    expect(await marks("email.dataQuality")).toContain(emailId);

    // Historical evidence can be malformed; extraction must skip it without
    // failing the member save or the rest of a fanout page.
    await drain();
    await getDb(ctx.db).execute(sql`
      UPDATE "Assessment" SET subject = '{"recordId":"invalid"}'::jsonb
      WHERE id = ${assessment.id}
    `);
    await getDb(ctx.db).execute(sql`
      UPDATE "Feedback" SET reason = 'Synthetic historical evidence'
      WHERE "assessmentId" = ${assessment.id}
    `);
    await drain();
    expect(await marks("email.dataQuality")).toEqual([]);
  });

  it("refreshes Wish text when a candidate changes, then detaches it", async () => {
    const candidate = await makeProduct("Synthetic hand plane", 40);
    const wish = await seedEntity(ctx.db, "wish", { name: "Synthetic tools" });
    const wishId = await resolveLiveShortcode(ctx.db, wish.id, "wish");
    if (!wishId) throw new Error("Synthetic Wish was not created");
    await withTransaction(ctx.db, (tx) =>
      attachLinks(tx, "wishCandidate", [{ from: wishId, to: candidate }]),
    );
    await drain();
    const body = async () =>
      (
        await getDb(ctx.db).execute(sql`
      SELECT body FROM "SearchDocument" WHERE "entityId" = ${wishId}
    `)
      ).rows
        .map((row) => String(row.body))
        .join(" ");
    expect(await body()).toContain("hand plane");
    await getDb(ctx.db)
      .update(product)
      .set({ name: "Synthetic block plane" })
      .where(eq(product.id, candidate));
    expect(
      (await fanoutMarks("wish.searchDocument")).map((mark) => mark.ref),
    ).toContain(candidate);
    await drain();
    expect(await body()).toContain("block plane");
    expect(await body()).not.toContain("hand plane");
    await getDb(ctx.db).execute(sql`
      UPDATE "EntityLink" SET "deletedAt" = now()
      WHERE kind = 'wishCandidate' AND "fromEntityId" = ${wishId}
    `);
    await drain();
    expect(await body()).not.toContain("block plane");
  });

  it("refreshes recipe nutrition and both ingredient endpoints after Product edits", async () => {
    const first = await findOrCreateIngredient(
      ctx.db,
      "Synthetic label ingredient",
    );
    const second = await findOrCreateIngredient(
      ctx.db,
      "Synthetic replacement ingredient",
    );
    const subject = await createProductIdentityFixture(
      ctx.db,
      makeProductInput({
        name: "Synthetic labelled food",
        ingredientId: first.id,
        labelNutrition: {
          servingGrams: 44,
          nutrients: { kcal: 80 },
          source: "Synthetic label",
        },
        unitMappings: [
          {
            a: { value: 1, unit: "each" },
            b: { value: 44, unit: "g" },
            source: "test",
          },
        ],
      }),
      ctx.actor,
    );
    const makeRecipe = (name: string, code: string) =>
      createRecipeFixture(
        ctx.db,
        makeRecipeInput({
          name,
          sections: [
            {
              instructions: [{ instruction: "Mix" }],
              ingredients: [
                ingredientRef(code, { amounts: [{ value: 1, unit: "each" }] }),
              ],
            },
          ],
        }),
        ctx.actor,
      );
    const original = await makeRecipe(
      "Synthetic first recipe",
      first.shortcode,
    );
    const replacement = await makeRecipe(
      "Synthetic second recipe",
      second.shortcode,
    );
    const totals = async (id: typeof original.entityId) =>
      (
        await getDb(ctx.db).query.recipe.findFirst({
          where: eq(recipeTable.id, id),
          columns: { totals: true },
        })
      )?.totals;
    await drain();
    expect((await totals(original.entityId))?.nutrition.kcal).toMatchObject({
      status: "complete",
      lower: 80,
    });
    await getDb(ctx.db)
      .update(product)
      .set({
        labelNutrition: {
          servingGrams: 44,
          nutrients: { kcal: 160 },
          source: "Synthetic revised label",
        },
      })
      .where(eq(product.id, subject.entityId));
    expect(
      (await fanoutMarks("recipe.totals")).map((mark) => mark.ref),
    ).toContain(first.id);
    await drain();
    expect((await totals(original.entityId))?.nutrition.kcal).toMatchObject({
      status: "complete",
      lower: 160,
    });
    await getDb(ctx.db)
      .update(product)
      .set({ ingredientId: second.id })
      .where(eq(product.id, subject.entityId));
    expect(
      (await fanoutMarks("recipe.totals")).map((mark) => mark.ref),
    ).toEqual(expect.arrayContaining([first.id, second.id]));
    await drain();
    expect((await totals(original.entityId))?.nutrition.kcal.status).toBe(
      "unavailable",
    );
    expect((await totals(replacement.entityId))?.nutrition.kcal).toMatchObject({
      status: "complete",
      lower: 160,
    });
  });

  it("refreshes sibling component prices while the kit price stays fixed", async () => {
    const kit = await createProductIdentityFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic fixed-price kit", price: 100 }),
      ctx.actor,
    );
    const first = await makeProduct("Synthetic kit component A", null);
    const second = await makeProduct("Synthetic kit component B", null);
    const charge = await createRepoEntity(ctx, "expense", {
      productId: kit.id,
      cost: 100,
      productQuantity: 1,
      lineKind: "principal",
      trade: "other",
      future: false,
    });
    await attachProductComponents(
      ctx.db,
      kit.entityId,
      [
        { productId: first, quantity: 1 },
        { productId: second, quantity: 1 },
      ],
      ctx.actor,
    );
    const price = async (id: ProductId) =>
      (await loadStoredDerived(ctx.db, "product", [id], ["price"]))
        .get(id)
        ?.get("price")?.value;
    await drain();
    expect(await price(first)).toBe(50);
    expect(await price(kit.entityId)).toBe(100);
    await getDb(ctx.db)
      .update(entityLink)
      .set({ quantity: 2 })
      .where(
        and(
          eq(entityLink.kind, "productComponent"),
          eq(entityLink.fromEntityId, kit.entityId),
          eq(entityLink.toEntityId, second),
        ),
      );
    await drain();
    expect(await price(kit.entityId)).toBe(100);
    expect(await price(first)).toBeCloseTo(100 / 3, 2);
    await getDb(ctx.db)
      .update(expense)
      .set({ cost: 150 })
      .where(eq(expense.id, charge.entityId));
    await drain();
    expect(await price(kit.entityId)).toBe(100);
    expect(await price(first)).toBe(50);
  });

  it("refreshes project dates for subtask date edits and old/new parents", async () => {
    const first = await createRepoEntity(ctx, "project", {
      name: "Synthetic project A",
    });
    const second = await createRepoEntity(ctx, "project", {
      name: "Synthetic project B",
    });
    const parent = await createRepoEntity(ctx, "task", {
      name: "Synthetic parent A",
      projectId: first.output.id,
      trade: "other",
      due: null,
    });
    const otherParent = await createRepoEntity(ctx, "task", {
      name: "Synthetic parent B",
      projectId: second.output.id,
      trade: "other",
      due: null,
    });
    const child = await createRepoEntity(ctx, "task", {
      name: "Synthetic dated subtask",
      parentTaskId: parent.output.id,
      due: { start: "2023-01-02", end: null },
    });
    const dates = async (id: typeof first.entityId) => {
      const values = (
        await loadStoredDerived(
          ctx.db,
          "project",
          [id],
          ["startDate", "completionYear"],
        )
      ).get(id);
      return {
        start: values?.get("startDate")?.value,
        year: values?.get("completionYear")?.value,
      };
    };
    await drain();
    expect(await dates(first.entityId)).toEqual({
      start: "2023-01-02",
      year: "2023",
    });
    const emptyProjectDates = await dates(second.entityId);
    await getDb(ctx.db)
      .update(taskTable)
      .set({ dueDate: "2024-03-04" })
      .where(eq(taskTable.id, child.entityId));
    await drain();
    expect(await dates(first.entityId)).toEqual({
      start: "2024-03-04",
      year: "2024",
    });
    await getDb(ctx.db)
      .update(taskTable)
      .set({ parentTaskId: otherParent.entityId })
      .where(eq(taskTable.id, child.entityId));
    expect(
      (await fanoutMarks("project.startDate")).map((mark) => mark.ref),
    ).toEqual(expect.arrayContaining([parent.entityId, otherParent.entityId]));
    await drain();
    expect(await dates(first.entityId)).toEqual(emptyProjectDates);
    expect(await dates(second.entityId)).toEqual({
      start: "2024-03-04",
      year: "2024",
    });
  });

  it("refreshes unrounded inventory valuation when the stored Product price does not change", async () => {
    const subject = await createProductIdentityFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic two-unit acquisition", price: null }),
      ctx.actor,
    );
    const location = await makeLocation("Synthetic precision shelf");
    const entry = await makeEntry(subject.entityId, location, 2);
    const charge = await createRepoEntity(ctx, "expense", {
      productId: subject.id,
      cost: 37.97,
      productQuantity: 2,
      lineKind: "principal",
      trade: "other",
      future: false,
    });
    const price = async () =>
      (
        await loadStoredDerived(
          ctx.db,
          "product",
          [subject.entityId],
          ["price"],
        )
      )
        .get(subject.entityId)
        ?.get("price")?.value;
    await drain();
    expect(await price()).toBe(18.99);
    expect((await valuation(entry))?.value).toBeCloseTo(37.97, 6);
    await getDb(ctx.db)
      .update(expense)
      .set({ cost: 37.98 })
      .where(eq(expense.id, charge.entityId));
    expect(
      (await fanoutMarks("inventory.valuation")).map((mark) => mark.ref),
    ).toContain(subject.entityId);
    await drain();
    expect(await price()).toBe(18.99);
    expect((await valuation(entry))?.value).toBeCloseTo(37.98, 6);
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
});
