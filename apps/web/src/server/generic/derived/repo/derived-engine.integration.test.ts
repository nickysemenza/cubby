import type {
  InventoryId,
  LocationId,
  ProductId,
} from "@cubby/schemas/identifiers";
import { parseEntityId } from "@cubby/schemas/identifiers";
import { and, eq, sql } from "drizzle-orm";
import { createRepoEntity } from "tooling/factories/repo";
import {
  countTestDbQueries,
  seedEntity,
  TEST_ACTOR,
  withTestDb,
} from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import {
  getDb,
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
import { loadStoredDerived } from "~/server/generic/derived/repo/read";
import { attachLinks } from "~/server/generic/entity-links/repo/entity-links";
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

    expect((await valuation(entry))?.meta.state).toBe("missing");
    await drain();
    const stored = await valuation(entry);
    expect(stored?.value).toBe(10);
    expect(stored?.meta.state).toBe("fresh");
    expect(await marks("inventory.valuation")).toEqual([]);
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
        throw new Error("Synthetic compute failure");
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

  it("publishes the rest of a page when the database rejects one target's write", async () => {
    const location = await makeLocation("Synthetic rejecting shelf");
    const beans = await makeProduct("Synthetic rejected beans", 2);
    const entry = await makeEntry(beans, location, 3);
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
          (await claimDerivedMarks(ctx.db, 10_000)).filter((mark) =>
            mark.target.startsWith("task.searchDocument@"),
          ),
        ),
      );
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
