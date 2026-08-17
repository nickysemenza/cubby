import {
  type PreviewDeleteEntity,
  type PreviewMergeEntity,
  previewOperationSchema,
} from "@cubby/schemas/entity-integrity";
import {
  unsafeFinancialAccountId,
  unsafeFinancialTransactionId,
  unsafeLocationId,
  unsafeProductId,
  unsafeProjectId,
  unsafePurchaseId,
  unsafeVendorId,
  unsafeWishId,
} from "@cubby/schemas/identifiers";
import { mealCreateInput } from "@cubby/schemas/meal";
import { projectCreateInput, taskCreateInput } from "@cubby/schemas/project";
import { purchaseCreateInput } from "@cubby/schemas/purchase";
import { vendorCreateInput } from "@cubby/schemas/vendor";
import { and, eq, inArray } from "drizzle-orm";
import { NONEXISTENT_UUID, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { previewOperation } from "~/server/api/routers/entity-integrity-preview";
import type { Database } from "~/server/db/database";
import {
  entityEmbedding,
  expense,
  ingredient,
  mealRecipe,
  productImage,
  recipe,
  recipeSection,
  task,
} from "~/server/db/schema";
import { previewDeleteFinancialAccounts } from "~/server/repo/financial-account";
import { previewDeleteFinancialTransactions } from "~/server/repo/financial-transaction";
import { previewDeleteLocations } from "~/server/repo/location/crud";
import { previewMergeProducts } from "~/server/repo/product/merge";
import { previewDeleteProjects } from "~/server/repo/project/crud";
import {
  deleteCookbook,
  previewDeleteCookbooks,
  upsertCookbook,
} from "./cookbook";
import { getDb, notDeleted } from "./database-helpers";
import {
  createExpense,
  deleteExpenses,
  previewDeleteExpenses,
} from "./expense";
import {
  createPendingImageRecord,
  deleteImages,
  previewDeleteImages,
} from "./image";
import { upsertCookbookRecipeFromCookbook } from "./import-recipe-convert";
import { deleteIngredients } from "./ingredient";
import { previewDeleteIngredients } from "./ingredient/deletion";
import { previewMergeIngredientCandidates } from "./ingredient/merge";
import {
  deleteInventoryEntries,
  previewDeleteInventoryEntries,
} from "./inventory/crud";
import { deleteLocations } from "./location";
import { deleteMeals } from "./meal";
import { previewDeleteMeals } from "./meal/crud";
import { deleteProducts } from "./product";
import { previewDeleteProducts } from "./product/crud";
import { createProject, deleteProjects } from "./project";
import {
  createPurchase,
  deletePurchases,
  mergePurchases,
  previewDeletePurchases,
  previewMergePurchases,
} from "./purchase";
import { deleteRecipes } from "./recipe";
import { previewDeleteRecipes } from "./recipe/crud";
import {
  cookbookRecipe,
  createIngredientFixture as createIngredient,
  createInventoryFixture as createInventoryEntry,
  createLocationFixture as createLocation,
  createMealFixture as createMeal,
  createProductFixture as createProduct,
  createRecipeFixture as createRecipe,
  ingredientRef,
  makeExpenseInput,
  makeLocationInput,
  makeProductInput,
  makeRecipeInput,
} from "./repo.fixtures";
import { insertWithShortcode } from "./shortcode-utils";
import { createTask, deleteTasks } from "./task";
import { previewDeleteTasks } from "./task/crud";
import {
  createVendor,
  deleteVendors,
  previewDeleteVendors,
  previewMergeVendors,
} from "./vendor";
import { previewDeleteWishes } from "./wish";

/**
 * Real-database parity tests between an operation preview and the mutation it
 * describes.
 *
 * The preview system (`packages/schemas/src/entity-integrity.ts`,
 * `repo/impact.ts`, and one planner per mutation) exists to answer "what will
 * this delete/merge actually do?" *before* the user confirms. Every planner's
 * own doc comment claims it reads "the SAME" predicate the mutation uses — this
 * file is the regression backstop for that claim. A planner and its mutation
 * are two hand-written call sites; nothing besides a shared query keeps them
 * honest, and even a shared query can be read wrong by one side. So each test
 * below builds one fixture and checks BOTH halves against it: what the preview
 * predicted, and what the mutation actually did.
 *
 * A second unrelated agent is editing `apps/web/src/app/**` at the same time —
 * this file only touches its own new path and never runs a repo-wide
 * format/check command.
 */

const NONEXISTENT_UUID_2 = "00000000-0000-0000-0000-000000000002";

describe("operation preview / mutation parity", () => {
  const ctx = withTestDb();

  describe("blocker parity", () => {
    /**
     * What a delete-blocker row hands the shared body. `preview` and `remove`
     * are closures rather than data because each entity's ids are branded to
     * itself and its delete takes a different id form (some the shortcode, some
     * the uuid) — nothing narrower than "do it for me" is assignable across all
     * five.
     */
    interface BlockerCase {
      preview: () => ReturnType<typeof previewOperation>;
      /** The edge the preview must name as the blocker. */
      edgeKey: string;
      /** The `cause.reason` the mutation must refuse with. */
      reason: string;
      /** The mutation under test. Called once blocked, once unblocked. */
      remove: () => Promise<unknown>;
      /** Delete the blocking row, so the second pass can proceed. */
      clearBlocker: () => Promise<unknown>;
      /** What the now-permitted delete resolves to. */
      expectResolved: (result: unknown) => void;
    }

    const detachesNoImages = (result: unknown) =>
      expect(result).toMatchObject({ detachedImageKeys: [] });
    const resolvesVoid = (result: unknown) => expect(result).toBeUndefined();

    /**
     * One row per (entity, blocking edge). The body below is the parity claim
     * itself — preview refuses, mutation refuses with the matching reason,
     * clearing the edge flips BOTH to permitted — so a new blocking edge is a
     * row, and can't accidentally assert only half of it.
     */
    const BLOCKER_CASES: ReadonlyArray<[string, () => Promise<BlockerCase>]> = [
      [
        "product: live inventory blocks delete",
        async () => {
          const location = await createLocation(
            ctx.db,
            makeLocationInput({ name: "Blocker Location" }),
            ctx.actor,
          );
          const product = await createProduct(
            ctx.db,
            makeProductInput({ name: "Blocked Product", upc: "800000000001" }),
            ctx.actor,
          );
          const entry = await createInventoryEntry(
            ctx.db,
            {
              productId: product.id,
              locationId: location.id,
              amount: { value: 1, unit: "each" },
            },
            ctx.actor,
          );
          return {
            preview: () =>
              previewOperation(
                ctx.db,
                {
                  operation: "delete",
                  entity: "product",
                  ids: [product.id],
                },
                new Date(),
              ),
            edgeKey: "InventoryEntry.productId",
            reason: "PRODUCT_HAS_INVENTORY",
            remove: () => deleteProducts(ctx.db, [product.entityId], ctx.actor),
            clearBlocker: () =>
              deleteInventoryEntries(ctx.db, [entry.entityId], ctx.actor),
            expectResolved: detachesNoImages,
          };
        },
      ],
      [
        "ingredient: a live recipe usage blocks delete",
        async () => {
          const ingredient = await createIngredient(
            ctx.db,
            { name: "Blocked Ingredient", aliases: [] },
            ctx.actor,
          );
          const recipe = await createRecipe(
            ctx.db,
            makeRecipeInput({
              name: "Uses Blocked Ingredient",
              sections: [
                {
                  name: "Main",
                  instructions: [{ instruction: "Mix" }],
                  ingredients: [ingredientRef(ingredient.id)],
                },
              ],
            }),
            ctx.actor,
          );
          return {
            preview: () =>
              previewOperation(
                ctx.db,
                {
                  operation: "delete",
                  entity: "ingredient",
                  ids: [ingredient.id],
                },
                new Date(),
              ),
            edgeKey: "RecipeSectionIngredient.ingredientId",
            reason: "INGREDIENT_HAS_RECIPES",
            remove: () =>
              deleteIngredients(ctx.db, [ingredient.entityId], ctx.actor),
            // Deleting the recipe cascade-soft-deletes its section
            // ingredients, which is what clears the live usage.
            clearBlocker: () =>
              deleteRecipes(ctx.db, [recipe.entityId], ctx.actor),
            expectResolved: resolvesVoid,
          };
        },
      ],
      [
        "location: live inventory blocks delete",
        async () => {
          const location = await createLocation(
            ctx.db,
            makeLocationInput({ name: "Blocked Location" }),
            ctx.actor,
          );
          const product = await createProduct(
            ctx.db,
            makeProductInput({
              name: "Location Blocker Product",
              upc: "800000000002",
            }),
            ctx.actor,
          );
          const entry = await createInventoryEntry(
            ctx.db,
            {
              productId: product.id,
              locationId: location.id,
              amount: { value: 1, unit: "each" },
            },
            ctx.actor,
          );
          return {
            preview: () =>
              previewOperation(
                ctx.db,
                {
                  operation: "delete",
                  entity: "location",
                  ids: [location.id],
                },
                new Date(),
              ),
            edgeKey: "InventoryEntry.locationId",
            reason: "LOCATION_HAS_INVENTORY",
            remove: () =>
              deleteLocations(ctx.db, [location.entityId], ctx.actor),
            clearBlocker: () =>
              deleteInventoryEntries(ctx.db, [entry.entityId], ctx.actor),
            expectResolved: detachesNoImages,
          };
        },
      ],
      [
        "project: a live task blocks delete",
        async () => {
          const { output: project } = await createProject(
            ctx.db,
            projectCreateInput.parse({ name: "Blocked Project" }),
            ctx.actor,
          );
          const { output: taskRow } = await createTask(
            ctx.db,
            taskCreateInput.parse({
              name: "Blocking Task",
              trade: "other",
              projectId: project.id,
            }),
            ctx.actor,
          );
          return {
            preview: () =>
              previewOperation(
                ctx.db,
                {
                  operation: "delete",
                  entity: "project",
                  ids: [project.id],
                },
                new Date(),
              ),
            edgeKey: "Task.projectId",
            reason: "PROJECT_HAS_TASKS",
            remove: () => deleteProjects(ctx.db, [project.id], ctx.actor),
            clearBlocker: () => deleteTasks(ctx.db, [taskRow.id], ctx.actor),
            expectResolved: detachesNoImages,
          };
        },
      ],
      [
        "vendor: a live purchase blocks delete",
        async () => {
          const { output: vendor } = await createVendor(
            ctx.db,
            vendorCreateInput.parse({ name: "Blocked Vendor" }),
            ctx.actor,
          );
          const { output: purchase } = await createPurchase(
            ctx.db,
            purchaseCreateInput.parse({
              date: "2024-01-15",
              vendorId: vendor.id,
            }),
            ctx.actor,
          );
          return {
            preview: () =>
              previewOperation(
                ctx.db,
                { operation: "delete", entity: "vendor", ids: [vendor.id] },
                new Date(),
              ),
            edgeKey: "Purchase.vendorId",
            reason: "VENDOR_HAS_PURCHASES",
            remove: () => deleteVendors(ctx.db, [vendor.id], ctx.actor),
            clearBlocker: () =>
              deletePurchases(ctx.db, [purchase.id], ctx.actor),
            expectResolved: resolvesVoid,
          };
        },
      ],
    ];

    it.each(BLOCKER_CASES)(
      "%s, both in the preview and the mutation",
      async (_label, seed) => {
        const subject = await seed();

        const blocked = await subject.preview();
        expect(blocked.canProceed).toBe(false);
        expect(blocked.blockers.map((b) => b.edgeKey)).toContain(
          subject.edgeKey,
        );
        await expect(subject.remove()).rejects.toMatchObject({
          code: "PRECONDITION_FAILED",
          cause: { reason: subject.reason },
        });

        await subject.clearBlocker();

        const unblocked = await subject.preview();
        expect(unblocked.canProceed).toBe(true);
        expect(unblocked.blockers).toEqual([]);
        subject.expectResolved(await subject.remove());
      },
    );

    // The two merge refusals stay hand-written: each has a materially different
    // setup and its own refusal reason, so a table row would be a fixture with
    // nothing shared but the word "blocked".
    it("purchase merge: cross-vendor charges are refused, both in the preview and the mutation", async () => {
      const { output: vendorA } = await createVendor(
        ctx.db,
        vendorCreateInput.parse({ name: "Cross Vendor A" }),
        ctx.actor,
      );
      const { output: vendorB } = await createVendor(
        ctx.db,
        vendorCreateInput.parse({ name: "Cross Vendor B" }),
        ctx.actor,
      );
      const { output: keeper } = await createPurchase(
        ctx.db,
        purchaseCreateInput.parse({
          date: "2024-01-15",
          vendorId: vendorA.id,
        }),
        ctx.actor,
      );
      const { output: otherVendorCharge } = await createPurchase(
        ctx.db,
        purchaseCreateInput.parse({
          date: "2024-01-15",
          vendorId: vendorB.id,
        }),
        ctx.actor,
      );

      const blocked = await previewOperation(
        ctx.db,
        {
          operation: "merge",
          entity: "purchase",
          keepId: keeper.id,
          mergeIds: [otherVendorCharge.id],
        },
        new Date(),
      );
      expect(blocked.canProceed).toBe(false);
      expect(blocked.blockers.map((b) => b.code)).toContain(
        "block-cross-vendor-merge",
      );
      await expect(
        mergePurchases(
          ctx.db,
          { keepId: keeper.id, mergeIds: [otherVendorCharge.id] },
          ctx.actor,
        ),
      ).rejects.toMatchObject({
        code: "BAD_REQUEST",
        cause: { reason: "PURCHASE_MERGE_VENDOR_MISMATCH" },
      });

      // The converse: a same-vendor charge merges cleanly.
      const { output: sameVendorCharge } = await createPurchase(
        ctx.db,
        purchaseCreateInput.parse({
          date: "2024-01-15",
          vendorId: vendorA.id,
        }),
        ctx.actor,
      );
      const unblocked = await previewOperation(
        ctx.db,
        {
          operation: "merge",
          entity: "purchase",
          keepId: keeper.id,
          mergeIds: [sameVendorCharge.id],
        },
        new Date(),
      );
      expect(unblocked.canProceed).toBe(true);
      expect(unblocked.blockers).toEqual([]);
      await expect(
        mergePurchases(
          ctx.db,
          { keepId: keeper.id, mergeIds: [sameVendorCharge.id] },
          ctx.actor,
        ),
      ).resolves.toBeDefined();
    });

    it("purchase merge: two order-id-bearing charges are refused, both in the preview and the mutation", async () => {
      const { output: vendor } = await createVendor(
        ctx.db,
        vendorCreateInput.parse({ name: "Order Collision Vendor" }),
        ctx.actor,
      );
      const { output: keeper } = await createPurchase(
        ctx.db,
        purchaseCreateInput.parse({
          date: "2024-01-15",
          vendorId: vendor.id,
          orderId: "ORD-A",
        }),
        ctx.actor,
      );
      const { output: otherOrderCharge } = await createPurchase(
        ctx.db,
        purchaseCreateInput.parse({
          date: "2024-01-15",
          vendorId: vendor.id,
          orderId: "ORD-B",
        }),
        ctx.actor,
      );

      const blocked = await previewOperation(
        ctx.db,
        {
          operation: "merge",
          entity: "purchase",
          keepId: keeper.id,
          mergeIds: [otherOrderCharge.id],
        },
        new Date(),
      );
      expect(blocked.canProceed).toBe(false);
      expect(blocked.blockers.map((b) => b.code)).toContain(
        "block-order-collision-merge",
      );
      await expect(
        mergePurchases(
          ctx.db,
          { keepId: keeper.id, mergeIds: [otherOrderCharge.id] },
          ctx.actor,
        ),
      ).rejects.toMatchObject({
        code: "BAD_REQUEST",
        cause: { reason: "PURCHASE_MERGE_ORDER_COLLISION" },
      });

      // The converse: a charge with no order id of its own merges cleanly
      // (the keeper's own order id survives — only a SECOND real order id
      // is the collision).
      const { output: noOrderCharge } = await createPurchase(
        ctx.db,
        purchaseCreateInput.parse({
          date: "2024-01-15",
          vendorId: vendor.id,
          orderId: null,
        }),
        ctx.actor,
      );
      const unblocked = await previewOperation(
        ctx.db,
        {
          operation: "merge",
          entity: "purchase",
          keepId: keeper.id,
          mergeIds: [noOrderCharge.id],
        },
        new Date(),
      );
      expect(unblocked.canProceed).toBe(true);
      expect(unblocked.blockers).toEqual([]);
      await expect(
        mergePurchases(
          ctx.db,
          { keepId: keeper.id, mergeIds: [noOrderCharge.id] },
          ctx.actor,
        ),
      ).resolves.toBeDefined();
    });
  });

  describe("count parity", () => {
    /**
     * The sub-recipe path, which nothing else in this file reaches.
     *
     * `Ingredient.recipeId` is the ONE edge in the whole schema marked
     * `allow-target-deleted`: deleting a recipe deliberately leaves the
     * recipe-as-ingredient pointer behind so parent recipes can still resolve
     * the tombstone and recompute. That makes it the one delete whose most
     * important consequences are side effects rather than cascades — a
     * preserved pointer and a parent recompute — and both were previously
     * unexercised, so the two `if (total > 0)` branches that emit them never
     * ran under test.
     *
     * Asserted here as parity, not just presence: the pointer the preview says
     * it will preserve must still be live after the mutation, and the parent it
     * names must be the recipe that actually uses the sub-recipe.
     */
    it("recipe delete: reports the preserved sub-recipe pointer and the parent recompute", async () => {
      const subRecipe = await createRecipe(
        ctx.db,
        makeRecipeInput({
          name: "Sub Sauce",
          sections: [
            { name: "Main", instructions: [{ instruction: "Simmer" }] },
          ],
        }),
        ctx.actor,
      );

      // A recipe used as an ingredient IS an Ingredient row carrying
      // `recipeId` — the same shape the import path writes.
      const pointer = await insertWithShortcode(ctx.db, "ingredient", {
        name: "Recipe: Sub Sauce",
        recipeId: subRecipe.entityId,
      });

      const parent = await createRecipe(
        ctx.db,
        makeRecipeInput({
          name: "Parent Dish",
          sections: [
            {
              name: "Main",
              instructions: [{ instruction: "Combine" }],
              ingredients: [ingredientRef(pointer.shortcode)],
            },
          ],
        }),
        ctx.actor,
      );

      const preview = await previewDeleteRecipes(ctx.db, [subRecipe.entityId]);

      const preserved = preview.sideEffects.find(
        (s) => s.code === "preserve-sub-recipe-pointer",
      );
      expect(preserved?.total).toBe(1);
      expect(preserved?.byTargetId[subRecipe.entityId]).toBe(1);
      // `preserve` — not a delete of any kind. The whole point of the exemption.
      expect(preserved?.effect).toBe("preserve");

      const recompute = preview.sideEffects.find(
        (s) => s.code === "recompute-parent-recipes",
      );
      expect(recompute?.total).toBe(1);
      expect(recompute?.byTargetId[subRecipe.entityId]).toBe(1);

      await deleteRecipes(ctx.db, [subRecipe.entityId], ctx.actor);

      // Parity: the pointer the preview promised to preserve is still live,
      // now dangling at a soft-deleted recipe exactly as intended.
      const survivingPointer = await getDb(ctx.db).query.ingredient.findFirst({
        where: and(eq(ingredient.id, pointer.id), notDeleted(ingredient)),
        columns: { id: true, recipeId: true },
      });
      expect(survivingPointer?.recipeId).toBe(subRecipe.entityId);

      // …and the parent it named is still live, holding that line.
      const survivingParent = await getDb(ctx.db).query.recipe.findFirst({
        where: and(eq(recipe.id, parent.entityId), notDeleted(recipe)),
        columns: { id: true },
      });
      expect(survivingParent?.id).toBe(parent.entityId);
    });

    it("recipe delete: predicted section + meal-link cascades match what actually gets soft-deleted", async () => {
      const ingredient = await createIngredient(
        ctx.db,
        { name: "Cascade Flour", aliases: [] },
        ctx.actor,
      );
      const recipe = await createRecipe(
        ctx.db,
        makeRecipeInput({
          name: "Cascading Recipe",
          sections: [
            {
              name: "Main",
              instructions: [{ instruction: "Mix" }],
              ingredients: [ingredientRef(ingredient.id)],
            },
          ],
        }),
        ctx.actor,
      );
      await createMeal(
        ctx.db,
        mealCreateInput.parse({
          date: "2024-01-01",
          recipes: [{ recipeId: recipe.id, scale: 1 }],
        }),
        ctx.actor,
      );

      const preview = await previewDeleteRecipes(ctx.db, [recipe.entityId]);
      const sectionsChange = preview.changes.find(
        (c) => c.edgeKey === "RecipeSection.recipeId",
      );
      const mealLinkChange = preview.changes.find(
        (c) => c.edgeKey === "MealRecipe.recipeId",
      );
      expect(sectionsChange?.total).toBe(1);
      expect(mealLinkChange?.total).toBe(1);

      await deleteRecipes(ctx.db, [recipe.entityId], ctx.actor);

      const liveSections = await getDb(ctx.db)
        .select({ id: recipeSection.id })
        .from(recipeSection)
        .where(
          and(
            eq(recipeSection.recipeId, recipe.entityId),
            notDeleted(recipeSection),
          ),
        );
      expect(liveSections).toHaveLength(0);

      const liveMealLinks = await getDb(ctx.db)
        .select({ id: mealRecipe.id })
        .from(mealRecipe)
        .where(
          and(eq(mealRecipe.recipeId, recipe.entityId), notDeleted(mealRecipe)),
        );
      expect(liveMealLinks).toHaveLength(0);
    });

    it("cookbook delete: predicted recipe cascade matches what actually gets soft-deleted", async () => {
      const raw = [cookbookRecipe("Cascade Pancakes", ["2 cups flour"])];
      const cb = await upsertCookbook(
        ctx.db,
        { name: "Cascade Book", rawJson: raw, sourceLabel: "cascade.epub" },
        ctx.actor,
      );
      const { id: recipeId } = await upsertCookbookRecipeFromCookbook(
        raw[0]!,
        { id: cb.entityId, name: "Cascade Book" },
        ctx.db,
        ctx.actor,
      );

      const preview = await previewDeleteCookbooks(ctx.db, [cb.entityId]);
      const recipeChange = preview.changes.find(
        (c) => c.edgeKey === "Recipe.cookbookId",
      );
      expect(recipeChange?.total).toBe(1);
      expect(recipeChange?.byTargetId[cb.entityId]).toBe(1);

      const { deletedRecipeIds } = await deleteCookbook(
        ctx.db,
        cb.entityId,
        ctx.actor,
      );
      expect(deletedRecipeIds).toEqual([recipeId]);
    });

    it("task delete: predicted subtask cascade matches what actually gets soft-deleted", async () => {
      const { output: parent, entityId: parentUuid } = await createTask(
        ctx.db,
        taskCreateInput.parse({ name: "Parent Task", trade: "other" }),
        ctx.actor,
      );
      const { entityId: childUuid } = await createTask(
        ctx.db,
        taskCreateInput.parse({
          name: "Subtask",
          trade: "other",
          parentTaskId: parent.id,
        }),
        ctx.actor,
      );

      const preview = await previewDeleteTasks(ctx.db, [parentUuid]);
      const subtaskChange = preview.changes.find(
        (c) => c.edgeKey === "Task.parentTaskId",
      );
      expect(subtaskChange?.total).toBe(1);
      expect(subtaskChange?.byTargetId[parentUuid]).toBe(1);

      await deleteTasks(ctx.db, [parent.id], ctx.actor);

      const rows = await getDb(ctx.db)
        .select({ id: task.id, deletedAt: task.deletedAt })
        .from(task)
        .where(inArray(task.id, [parentUuid, childUuid]));
      for (const row of rows) {
        expect(row.deletedAt).not.toBeNull();
      }
    });

    it("purchase delete: predicted expense-detach count matches what actually gets nulled", async () => {
      const { output: vendor } = await createVendor(
        ctx.db,
        vendorCreateInput.parse({ name: "Detach Vendor" }),
        ctx.actor,
      );
      const { output: purchase, entityId: purchaseUuid } = await createPurchase(
        ctx.db,
        purchaseCreateInput.parse({
          date: "2024-01-15",
          vendorId: vendor.id,
        }),
        ctx.actor,
      );
      const { entityId: lineUuid } = await createExpense(
        ctx.db,
        { ...makeExpenseInput(), name: "Detach Line", purchaseId: purchase.id },
        ctx.actor,
      );

      const preview = await previewDeletePurchases(ctx.db, [purchaseUuid]);
      const detachChange = preview.changes.find(
        (c) => c.edgeKey === "Expense.purchaseId",
      );
      expect(detachChange?.total).toBe(1);
      expect(detachChange?.byTargetId[purchaseUuid]).toBe(1);

      await deletePurchases(ctx.db, [purchase.id], ctx.actor);

      const [row] = await getDb(ctx.db)
        .select({ purchaseId: expense.purchaseId })
        .from(expense)
        .where(eq(expense.id, lineUuid));
      expect(row?.purchaseId).toBeNull();
    });

    it("meal delete: predicted planned-recipe cascade matches what actually gets soft-deleted", async () => {
      const recipeA = await createRecipe(
        ctx.db,
        makeRecipeInput({ name: "Meal Cascade A" }),
        ctx.actor,
      );
      const recipeB = await createRecipe(
        ctx.db,
        makeRecipeInput({ name: "Meal Cascade B" }),
        ctx.actor,
      );
      const meal = await createMeal(
        ctx.db,
        mealCreateInput.parse({
          date: "2024-02-01",
          recipes: [
            { recipeId: recipeA.id, scale: 1 },
            { recipeId: recipeB.id, scale: 1 },
          ],
        }),
        ctx.actor,
      );

      const preview = await previewDeleteMeals(ctx.db, [meal.entityId]);
      const linkChange = preview.changes.find(
        (c) => c.edgeKey === "MealRecipe.mealId",
      );
      expect(linkChange?.total).toBe(2);
      expect(linkChange?.byTargetId[meal.entityId]).toBe(2);

      await deleteMeals(ctx.db, [meal.entityId], ctx.actor);

      const liveLinks = await getDb(ctx.db)
        .select({ id: mealRecipe.id })
        .from(mealRecipe)
        .where(
          and(eq(mealRecipe.mealId, meal.entityId), notDeleted(mealRecipe)),
        );
      expect(liveLinks).toHaveLength(0);
    });

    it("image delete: predicted product-association cascade matches the actual hard delete", async () => {
      const pendingImage = await createPendingImageRecord(ctx.db, {
        key: `test-products/parity-${crypto.randomUUID()}.png`,
        url: "https://example.com/parity.png",
        filename: "parity.png",
        contentType: "image/png",
        size: 10,
      });
      await createProduct(
        ctx.db,
        makeProductInput({
          name: "Image Cascade Product",
          pendingImageIds: [pendingImage.id],
        }),
        ctx.actor,
      );

      const preview = await previewDeleteImages(ctx.db, [pendingImage.id]);
      const assocChange = preview.changes.find(
        (c) => c.edgeKey === "ProductImage.imageId",
      );
      expect(assocChange?.total).toBe(1);

      await deleteImages(ctx.db, [pendingImage.id]);

      const rows = await getDb(ctx.db)
        .select({ id: productImage.id })
        .from(productImage)
        .where(eq(productImage.imageId, pendingImage.id));
      expect(rows).toHaveLength(0);
    });
  });

  describe("per-target breakdown", () => {
    it("product bulk delete attributes a blocker to only the product that has it", async () => {
      const location = await createLocation(
        ctx.db,
        makeLocationInput({ name: "Breakdown Location" }),
        ctx.actor,
      );
      const blockedProduct = await createProduct(
        ctx.db,
        makeProductInput({ name: "Breakdown Blocked", upc: "800000000010" }),
        ctx.actor,
      );
      const cleanProduct = await createProduct(
        ctx.db,
        makeProductInput({ name: "Breakdown Clean", upc: "800000000011" }),
        ctx.actor,
      );
      await createInventoryEntry(
        ctx.db,
        {
          productId: blockedProduct.id,
          locationId: location.id,
          amount: { value: 1, unit: "each" },
        },
        ctx.actor,
      );

      const preview = await previewDeleteProducts(ctx.db, [
        blockedProduct.entityId,
        cleanProduct.entityId,
      ]);
      const inventoryBlocker = preview.blockers.find(
        (b) => b.edgeKey === "InventoryEntry.productId",
      );
      expect(inventoryBlocker?.total).toBe(1);
      expect(inventoryBlocker?.byTargetId).toEqual({
        [blockedProduct.entityId]: 1,
      });
      expect(
        inventoryBlocker?.byTargetId[cleanProduct.entityId],
      ).toBeUndefined();

      // The mutation agrees per-target: the clean product deletes fine on its
      // own, while the blocked one alone still throws.
      await expect(
        deleteProducts(ctx.db, [cleanProduct.entityId], ctx.actor),
      ).resolves.toMatchObject({ detachedImageKeys: [] });
      await expect(
        deleteProducts(ctx.db, [blockedProduct.entityId], ctx.actor),
      ).rejects.toMatchObject({
        cause: { reason: "PRODUCT_HAS_INVENTORY" },
      });
    });
  });

  describe("merge candidates ranking", () => {
    it("ranks USDA link > products > recipe usages > aliases, and carries the underlying counts in detail", async () => {
      const usdaLinked = await createIngredient(
        ctx.db,
        { name: "Rank USDA", aliases: [] },
        ctx.actor,
      );
      await createProduct(
        ctx.db,
        makeProductInput({
          name: "Rank USDA Product",
          upc: null,
          fdc_id: 999111,
          ingredientId: usdaLinked.id,
        }),
        ctx.actor,
      );

      const productOnly = await createIngredient(
        ctx.db,
        { name: "Rank Product Only", aliases: [] },
        ctx.actor,
      );
      await createProduct(
        ctx.db,
        makeProductInput({
          name: "Rank Plain Product",
          upc: null,
          fdc_id: null,
          ingredientId: productOnly.id,
        }),
        ctx.actor,
      );

      const recipeUsageOnly = await createIngredient(
        ctx.db,
        { name: "Rank Recipe Usage Only", aliases: [] },
        ctx.actor,
      );
      await createRecipe(
        ctx.db,
        makeRecipeInput({
          name: "Rank Usage Recipe",
          sections: [
            {
              name: "Main",
              instructions: [{ instruction: "Mix" }],
              ingredients: [ingredientRef(recipeUsageOnly.id)],
            },
          ],
        }),
        ctx.actor,
      );

      const aliasesOnly = await createIngredient(
        ctx.db,
        { name: "Rank Aliases Only", aliases: ["alias-one", "alias-two"] },
        ctx.actor,
      );

      const candidates = await previewMergeIngredientCandidates(ctx.db, [
        usdaLinked.entityId,
        productOnly.entityId,
        recipeUsageOnly.entityId,
        aliasesOnly.entityId,
      ]);

      const byId = new Map(candidates.map((c) => [c.id, c]));
      const usdaCandidate = byId.get(usdaLinked.id)!;
      const productCandidate = byId.get(productOnly.id)!;
      const recipeCandidate = byId.get(recipeUsageOnly.id)!;
      const aliasCandidate = byId.get(aliasesOnly.id)!;

      expect(usdaCandidate.weight).toBeGreaterThan(productCandidate.weight);
      expect(productCandidate.weight).toBeGreaterThan(recipeCandidate.weight);
      expect(recipeCandidate.weight).toBeGreaterThan(aliasCandidate.weight);

      // Sorting by weight descending (what the merge dialog does to default
      // the keeper) reproduces the expected ranking.
      const ranked = [...candidates].sort((a, b) => b.weight - a.weight);
      expect(ranked.map((c) => c.id)).toEqual([
        usdaLinked.id,
        productOnly.id,
        recipeUsageOnly.id,
        aliasesOnly.id,
      ]);

      expect(usdaCandidate.detail).toEqual([
        { label: "USDA link", count: 1 },
        { label: "products", count: 1 },
        { label: "recipe usages", count: 0 },
        { label: "aliases", count: 0 },
      ]);
      expect(productCandidate.detail).toEqual([
        { label: "USDA link", count: 0 },
        { label: "products", count: 1 },
        { label: "recipe usages", count: 0 },
        { label: "aliases", count: 0 },
      ]);
      expect(recipeCandidate.detail).toEqual([
        { label: "USDA link", count: 0 },
        { label: "products", count: 0 },
        { label: "recipe usages", count: 1 },
        { label: "aliases", count: 0 },
      ]);
      expect(aliasCandidate.detail).toEqual([
        { label: "USDA link", count: 0 },
        { label: "products", count: 0 },
        { label: "recipe usages", count: 0 },
        { label: "aliases", count: 2 },
      ]);
    });
  });

  describe("empty and zero-edge cases", () => {
    it("an empty ids array short-circuits every planner to empty results", async () => {
      await expect(previewDeleteProducts(ctx.db, [])).resolves.toEqual({
        blockers: [],
        changes: [],
      });
      await expect(previewDeleteIngredients(ctx.db, [])).resolves.toEqual({
        blockers: [],
        changes: [],
      });
      await expect(previewDeleteRecipes(ctx.db, [])).resolves.toEqual({
        blockers: [],
        changes: [],
        sideEffects: [],
      });
      await expect(
        previewMergeIngredientCandidates(ctx.db, []),
      ).resolves.toEqual([]);
    });

    it("expense has zero incoming edges: blockers/changes stay empty but a real consequence still surfaces as a sideEffect", async () => {
      const { output: line, entityId: lineUuid } = await createExpense(
        ctx.db,
        { ...makeExpenseInput(), name: "Zero Edge Expense" },
        ctx.actor,
      );
      // The embedding pipeline runs off the router's mutation side-effects,
      // not the repo call this test makes directly — seed the row the preview
      // is meant to count, mirroring cookbook.integration.test.ts's pattern.
      await getDb(ctx.db)
        .insert(entityEmbedding)
        .values({
          entityType: "expense",
          // EntityEmbedding is keyed by the private uuid, not the public code.
          entityId: lineUuid,
          embeddingText: `expense ${line.id}`,
          embeddingHash: `hash-${line.id}`,
          provider: "test",
          model: "test",
          dimensions: 3,
          embedding: [0, 0, 0],
        });

      const preview = await previewDeleteExpenses(ctx.db, [lineUuid]);
      expect(preview.blockers).toEqual([]);
      expect(preview.changes).toEqual([]);
      expect(preview.sideEffects.length).toBeGreaterThan(0);

      await expect(
        deleteExpenses(ctx.db, [line.id], ctx.actor),
      ).resolves.toEqual([]);
    });

    it("inventory has zero incoming edges: blockers/changes stay empty but the valuation-recompute sideEffect always surfaces", async () => {
      const location = await createLocation(
        ctx.db,
        makeLocationInput({ name: "Zero Edge Location" }),
        ctx.actor,
      );
      const product = await createProduct(
        ctx.db,
        makeProductInput({ name: "Zero Edge Product", upc: "800000000020" }),
        ctx.actor,
      );
      const entry = await createInventoryEntry(
        ctx.db,
        {
          productId: product.id,
          locationId: location.id,
          amount: { value: 1, unit: "each" },
        },
        ctx.actor,
      );

      const preview = await previewDeleteInventoryEntries(ctx.db, [
        entry.entityId,
      ]);
      expect(preview.blockers).toEqual([]);
      expect(preview.changes).toEqual([]);
      expect(
        preview.sideEffects.some(
          (s) => s.code === "location-valuation-recompute",
        ),
      ).toBe(true);

      await expect(
        deleteInventoryEntries(ctx.db, [entry.entityId], ctx.actor),
      ).resolves.toBeUndefined();
    });
  });

  /**
   * Smoke-test the planners that nothing else in this file executes.
   *
   * These call the planner functions DIRECTLY, and that is the whole point.
   * An earlier version drove them through `previewOperation` with a
   * nonexistent id, which looked equivalent and was vacuous: `plan()` resolves
   * ids first and returns `EMPTY_PLAN` on any unresolved one, so it never
   * reaches the `match(...)` dispatch and the planner is never called. Proved
   * by throwing from the first line of `previewDeleteWishes` — the
   * `delete/wish` case still passed. What that version actually exercised was
   * the resolve-gate, which `unresolved targets` below already covers.
   *
   * `blocker parity` and `count parity` above cover 10 of 16 delete planners
   * and 1 of 4 merge planners with real rows. These are the remaining 9. Each
   * runs the planner's real SQL against zero matching rows — the planners
   * short-circuit only on an EMPTY array, so a non-empty nonexistent id still
   * issues the query — which is enough to catch a syntax error or a bad join
   * in one that no other test touches.
   *
   * The dispatch itself needs no test: the `match(...)` chain ends in
   * `.exhaustive()`, so a new entity fails `tsc` long before it fails here.
   */
  describe("planner smoke tests: SQL runs against zero rows", () => {
    /**
     * Keyed by entity and typed as a total `Record`, so **adding an entity to
     * the enum fails `tsc` here until someone classifies it**. That restores
     * the property the previous derived-by-subtraction version had: the SQL
     * smoke coverage stays self-completing, rather than a hand-kept list that
     * silently stops covering new planners.
     *
     * `"covered-by-parity"` means the blocker/count parity blocks above already
     * run that planner against real rows. Everything else gets a thunk that
     * calls the planner DIRECTLY — see the note above on why going through
     * `previewOperation` does not work.
     */
    type Smoke = "covered-by-parity" | ((db: Database) => Promise<unknown>);

    const DELETE_PLANNER_SMOKE: Record<PreviewDeleteEntity, Smoke> = {
      product: "covered-by-parity",
      recipe: "covered-by-parity",
      ingredient: "covered-by-parity",
      cookbook: "covered-by-parity",
      meal: "covered-by-parity",
      task: "covered-by-parity",
      purchase: "covered-by-parity",
      expense: "covered-by-parity",
      inventory: "covered-by-parity",
      image: "covered-by-parity",
      location: (db) =>
        previewDeleteLocations(db, [unsafeLocationId(NONEXISTENT_UUID)]),
      project: (db) =>
        previewDeleteProjects(db, [unsafeProjectId(NONEXISTENT_UUID)]),
      vendor: (db) =>
        previewDeleteVendors(db, [unsafeVendorId(NONEXISTENT_UUID)]),
      wish: (db) => previewDeleteWishes(db, [unsafeWishId(NONEXISTENT_UUID)]),
      financialAccount: (db) =>
        previewDeleteFinancialAccounts(db, [
          unsafeFinancialAccountId(NONEXISTENT_UUID),
        ]),
      financialTransaction: (db) =>
        previewDeleteFinancialTransactions(db, [
          unsafeFinancialTransactionId(NONEXISTENT_UUID),
        ]),
    };

    // `keepId` must differ from `mergeIds`: the planners compute
    // `losers = mergeIds.filter((id) => id !== keepId)` and short-circuit on an
    // empty result, so reusing one uuid for both would skip the SQL entirely
    // and quietly re-vacuate these tests.
    const MERGE_PLANNER_SMOKE: Record<PreviewMergeEntity, Smoke> = {
      ingredient: "covered-by-parity",
      vendor: (db) =>
        previewMergeVendors(db, {
          mergeIds: [unsafeVendorId(NONEXISTENT_UUID)],
          keepId: unsafeVendorId(NONEXISTENT_UUID_2),
        }),
      purchase: (db) =>
        previewMergePurchases(db, {
          mergeIds: [unsafePurchaseId(NONEXISTENT_UUID)],
          keepId: unsafePurchaseId(NONEXISTENT_UUID_2),
        }),
      product: (db) =>
        previewMergeProducts(db, {
          mergeIds: [unsafeProductId(NONEXISTENT_UUID)],
          keepId: unsafeProductId(NONEXISTENT_UUID_2),
        }),
    };

    for (const [entity, smoke] of Object.entries(DELETE_PLANNER_SMOKE)) {
      if (smoke === "covered-by-parity") continue;
      it(`delete/${entity} planner issues its SQL`, async () => {
        await expect(smoke(ctx.db)).resolves.toBeDefined();
      });
    }

    for (const [entity, smoke] of Object.entries(MERGE_PLANNER_SMOKE)) {
      if (smoke === "covered-by-parity") continue;
      it(`merge/${entity} planner issues its SQL`, async () => {
        await expect(smoke(ctx.db)).resolves.toBeDefined();
      });
    }
  });

  describe("unresolved targets", () => {
    it("blocks a delete preview whose id names nothing, instead of previewing nothing", async () => {
      const result = await previewOperation(
        ctx.db,
        { operation: "delete", entity: "product", ids: ["PRD-ZZZZ"] },
        new Date(),
      );

      expect(result.canProceed).toBe(false);
      const blocker = result.blockers.find(
        (b) => b.code === "block-unresolved-target",
      );
      expect(blocker).toBeDefined();
      // The code must reach `label` — `ImpactRow` renders total/label/code and
      // never `description`, so a description-only message is invisible in the UI.
      expect(blocker?.label).toContain("PRD-ZZZZ");
      expect(blocker?.byTargetId).toHaveProperty("PRD-ZZZZ");
      expect(previewOperationSchema.safeParse(result).success).toBe(true);
    });

    it("blocks when only SOME ids resolve, rather than silently previewing the survivors", async () => {
      const product = await createProduct(
        ctx.db,
        makeProductInput({ name: "Real Product", upc: "800000000901" }),
        ctx.actor,
      );

      const result = await previewOperation(
        ctx.db,
        {
          operation: "delete",
          entity: "product",
          ids: [product.id, "PRD-ZZZY"],
        },
        new Date(),
      );

      expect(result.canProceed).toBe(false);
      const blocker = result.blockers.find(
        (b) => b.code === "block-unresolved-target",
      );
      expect(blocker?.label).toContain("PRD-ZZZY");
      // Only the unknown one is named; the real product is not a blocker.
      expect(blocker?.label).not.toContain(product.id);
    });

    it("blocks a merge whose keepId names nothing", async () => {
      const { output: keep } = await createVendor(
        ctx.db,
        vendorCreateInput.parse({ name: "Keeper Vendor" }),
        ctx.actor,
      );

      const result = await previewOperation(
        ctx.db,
        {
          operation: "merge",
          entity: "vendor",
          mergeIds: [keep.id],
          keepId: "VEN-ZZZZ",
        },
        new Date(),
      );

      expect(result.canProceed).toBe(false);
      expect(result.blockers.map((b) => b.code)).toContain(
        "block-unresolved-target",
      );
    });

    it("blocks a non-ingredient merge preview with no keepId", async () => {
      // `keepId` is optional in the wire schema, but only ingredient can answer
      // "which should I keep" (candidate ranking). The others used to receive an
      // empty-string keeper and return a confident preview of an impossible merge.
      const { output: a } = await createVendor(
        ctx.db,
        vendorCreateInput.parse({ name: "Merge A" }),
        ctx.actor,
      );
      const { output: b } = await createVendor(
        ctx.db,
        vendorCreateInput.parse({ name: "Merge B" }),
        ctx.actor,
      );

      const result = await previewOperation(
        ctx.db,
        { operation: "merge", entity: "vendor", mergeIds: [a.id, b.id] },
        new Date(),
      );

      expect(result.canProceed).toBe(false);
      expect(result.blockers.map((b) => b.code)).toContain(
        "block-missing-keeper",
      );
    });
  });
});
