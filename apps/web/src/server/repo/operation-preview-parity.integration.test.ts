import {
  previewDeleteEntitySchema,
  previewMergeEntitySchema,
  previewOperationSchema,
} from "@cubby/schemas/entity-integrity";
import { mealCreateInput } from "@cubby/schemas/meal";
import { projectCreateInput, taskCreateInput } from "@cubby/schemas/project";
import { purchaseCreateInput } from "@cubby/schemas/purchase";
import { vendorCreateInput } from "@cubby/schemas/vendor";
import { and, eq, inArray } from "drizzle-orm";
import { NONEXISTENT_UUID, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { previewOperation } from "~/server/api/routers/entity-integrity-preview";
import {
  entityEmbedding,
  expense,
  mealRecipe,
  productImage,
  recipeSection,
  task,
} from "~/server/db/schema";
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
import { createIngredient, deleteIngredients } from "./ingredient";
import { previewDeleteIngredients } from "./ingredient/deletion";
import { previewMergeIngredientCandidates } from "./ingredient/merge";
import {
  createInventoryEntry,
  deleteInventoryEntries,
  previewDeleteInventoryEntries,
} from "./inventory/crud";
import { createLocation, deleteLocations } from "./location";
import { createMeal, deleteMeals } from "./meal";
import { previewDeleteMeals } from "./meal/crud";
import { createProduct, deleteProducts } from "./product";
import { previewDeleteProducts } from "./product/crud";
import { createProject, deleteProjects } from "./project";
import {
  createPurchase,
  deletePurchases,
  mergePurchases,
  previewDeletePurchases,
} from "./purchase";
import { createRecipe, deleteRecipes } from "./recipe";
import { previewDeleteRecipes } from "./recipe/crud";
import {
  cookbookRecipe,
  ingredientRef,
  makeExpenseInput,
  makeLocationInput,
  makeProductInput,
  makeRecipeInput,
} from "./repo.fixtures";
import { createTask, deleteTasks } from "./task";
import { previewDeleteTasks } from "./task/crud";
import { createVendor, deleteVendors } from "./vendor";

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

  // ---------------------------------------------------------------------
  // 1. Blocker parity — the highest-value assertion. For each entity whose
  // delete (or purchase-merge's refusal rules) can be blocked: build the
  // blocking state, assert the preview says canProceed === false AND the
  // mutation actually throws; then remove the blocker and assert the
  // preview flips to canProceed === true AND the mutation actually succeeds.
  // ---------------------------------------------------------------------
  describe("blocker parity", () => {
    it("product: live inventory blocks delete, both in the preview and the mutation", async () => {
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

      const blocked = await previewOperation(
        ctx.db,
        { operation: "delete", entity: "product", ids: [product.id] },
        new Date(),
      );
      expect(blocked.canProceed).toBe(false);
      expect(blocked.blockers.map((b) => b.edgeKey)).toContain(
        "InventoryEntry.productId",
      );
      await expect(
        deleteProducts(ctx.db, [product.id], ctx.actor),
      ).rejects.toMatchObject({
        code: "PRECONDITION_FAILED",
        cause: { reason: "PRODUCT_HAS_INVENTORY" },
      });

      await deleteInventoryEntries(ctx.db, [entry.id], ctx.actor);

      const unblocked = await previewOperation(
        ctx.db,
        { operation: "delete", entity: "product", ids: [product.id] },
        new Date(),
      );
      expect(unblocked.canProceed).toBe(true);
      expect(unblocked.blockers).toEqual([]);
      await expect(
        deleteProducts(ctx.db, [product.id], ctx.actor),
      ).resolves.toBeUndefined();
    });

    it("ingredient: a live recipe usage blocks delete, both in the preview and the mutation", async () => {
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

      const blocked = await previewOperation(
        ctx.db,
        { operation: "delete", entity: "ingredient", ids: [ingredient.id] },
        new Date(),
      );
      expect(blocked.canProceed).toBe(false);
      expect(blocked.blockers.map((b) => b.edgeKey)).toContain(
        "RecipeSectionIngredient.ingredientId",
      );
      await expect(
        deleteIngredients(ctx.db, [ingredient.id], ctx.actor),
      ).rejects.toMatchObject({
        code: "PRECONDITION_FAILED",
        cause: { reason: "INGREDIENT_HAS_RECIPES" },
      });

      // Deleting the recipe cascade-soft-deletes its section ingredients,
      // clearing the live usage that was blocking the ingredient.
      await deleteRecipes(ctx.db, [recipe.id], ctx.actor);

      const unblocked = await previewOperation(
        ctx.db,
        { operation: "delete", entity: "ingredient", ids: [ingredient.id] },
        new Date(),
      );
      expect(unblocked.canProceed).toBe(true);
      expect(unblocked.blockers).toEqual([]);
      await expect(
        deleteIngredients(ctx.db, [ingredient.id], ctx.actor),
      ).resolves.toBeUndefined();
    });

    it("location: live inventory blocks delete, both in the preview and the mutation", async () => {
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

      const blocked = await previewOperation(
        ctx.db,
        { operation: "delete", entity: "location", ids: [location.id] },
        new Date(),
      );
      expect(blocked.canProceed).toBe(false);
      expect(blocked.blockers.map((b) => b.edgeKey)).toContain(
        "InventoryEntry.locationId",
      );
      await expect(
        deleteLocations(ctx.db, [location.id], ctx.actor),
      ).rejects.toMatchObject({
        code: "PRECONDITION_FAILED",
        cause: { reason: "LOCATION_HAS_INVENTORY" },
      });

      await deleteInventoryEntries(ctx.db, [entry.id], ctx.actor);

      const unblocked = await previewOperation(
        ctx.db,
        { operation: "delete", entity: "location", ids: [location.id] },
        new Date(),
      );
      expect(unblocked.canProceed).toBe(true);
      expect(unblocked.blockers).toEqual([]);
      await expect(
        deleteLocations(ctx.db, [location.id], ctx.actor),
      ).resolves.toBeUndefined();
    });

    it("project: a live task blocks delete, both in the preview and the mutation", async () => {
      const project = await createProject(
        ctx.db,
        projectCreateInput.parse({ name: "Blocked Project" }),
        ctx.actor,
      );
      const taskRow = await createTask(
        ctx.db,
        taskCreateInput.parse({
          name: "Blocking Task",
          trade: "other",
          projectId: project.id,
        }),
        ctx.actor,
      );

      const blocked = await previewOperation(
        ctx.db,
        { operation: "delete", entity: "project", ids: [project.id] },
        new Date(),
      );
      expect(blocked.canProceed).toBe(false);
      expect(blocked.blockers.map((b) => b.edgeKey)).toContain(
        "Task.projectId",
      );
      await expect(
        deleteProjects(ctx.db, [project.id], ctx.actor),
      ).rejects.toMatchObject({
        code: "PRECONDITION_FAILED",
        cause: { reason: "PROJECT_HAS_TASKS" },
      });

      await deleteTasks(ctx.db, [taskRow.id], ctx.actor);

      const unblocked = await previewOperation(
        ctx.db,
        { operation: "delete", entity: "project", ids: [project.id] },
        new Date(),
      );
      expect(unblocked.canProceed).toBe(true);
      expect(unblocked.blockers).toEqual([]);
      await expect(
        deleteProjects(ctx.db, [project.id], ctx.actor),
      ).resolves.toBeUndefined();
    });

    it("vendor: a live purchase blocks delete, both in the preview and the mutation", async () => {
      const vendor = await createVendor(
        ctx.db,
        vendorCreateInput.parse({ name: "Blocked Vendor" }),
        ctx.actor,
      );
      const purchase = await createPurchase(
        ctx.db,
        purchaseCreateInput.parse({ vendorId: vendor.id }),
        ctx.actor,
      );

      const blocked = await previewOperation(
        ctx.db,
        { operation: "delete", entity: "vendor", ids: [vendor.id] },
        new Date(),
      );
      expect(blocked.canProceed).toBe(false);
      expect(blocked.blockers.map((b) => b.edgeKey)).toContain(
        "Purchase.vendorId",
      );
      await expect(
        deleteVendors(ctx.db, [vendor.id], ctx.actor),
      ).rejects.toMatchObject({
        code: "PRECONDITION_FAILED",
        cause: { reason: "VENDOR_HAS_PURCHASES" },
      });

      await deletePurchases(ctx.db, [purchase.id], ctx.actor);

      const unblocked = await previewOperation(
        ctx.db,
        { operation: "delete", entity: "vendor", ids: [vendor.id] },
        new Date(),
      );
      expect(unblocked.canProceed).toBe(true);
      expect(unblocked.blockers).toEqual([]);
      await expect(
        deleteVendors(ctx.db, [vendor.id], ctx.actor),
      ).resolves.toBeUndefined();
    });

    it("purchase merge: cross-vendor charges are refused, both in the preview and the mutation", async () => {
      const vendorA = await createVendor(
        ctx.db,
        vendorCreateInput.parse({ name: "Cross Vendor A" }),
        ctx.actor,
      );
      const vendorB = await createVendor(
        ctx.db,
        vendorCreateInput.parse({ name: "Cross Vendor B" }),
        ctx.actor,
      );
      const keeper = await createPurchase(
        ctx.db,
        purchaseCreateInput.parse({ vendorId: vendorA.id }),
        ctx.actor,
      );
      const otherVendorCharge = await createPurchase(
        ctx.db,
        purchaseCreateInput.parse({ vendorId: vendorB.id }),
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
      const sameVendorCharge = await createPurchase(
        ctx.db,
        purchaseCreateInput.parse({ vendorId: vendorA.id }),
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
      const vendor = await createVendor(
        ctx.db,
        vendorCreateInput.parse({ name: "Order Collision Vendor" }),
        ctx.actor,
      );
      const keeper = await createPurchase(
        ctx.db,
        purchaseCreateInput.parse({ vendorId: vendor.id, orderId: "ORD-A" }),
        ctx.actor,
      );
      const otherOrderCharge = await createPurchase(
        ctx.db,
        purchaseCreateInput.parse({ vendorId: vendor.id, orderId: "ORD-B" }),
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
      const noOrderCharge = await createPurchase(
        ctx.db,
        purchaseCreateInput.parse({ vendorId: vendor.id, orderId: null }),
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

  // ---------------------------------------------------------------------
  // 2. Count parity — for cascading deletes, the preview's `total` for an
  // edge must equal the number of rows the mutation actually soft-deletes,
  // hard-deletes, or detaches. Count before/after and compare to the
  // preview's prediction.
  // ---------------------------------------------------------------------
  describe("count parity", () => {
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

      const preview = await previewDeleteRecipes(ctx.db, [recipe.id]);
      const sectionsChange = preview.changes.find(
        (c) => c.edgeKey === "RecipeSection.recipeId",
      );
      const mealLinkChange = preview.changes.find(
        (c) => c.edgeKey === "MealRecipe.recipeId",
      );
      expect(sectionsChange?.total).toBe(1);
      expect(mealLinkChange?.total).toBe(1);

      await deleteRecipes(ctx.db, [recipe.id], ctx.actor);

      const liveSections = await getDb(ctx.db)
        .select({ id: recipeSection.id })
        .from(recipeSection)
        .where(
          and(eq(recipeSection.recipeId, recipe.id), notDeleted(recipeSection)),
        );
      expect(liveSections).toHaveLength(0);

      const liveMealLinks = await getDb(ctx.db)
        .select({ id: mealRecipe.id })
        .from(mealRecipe)
        .where(and(eq(mealRecipe.recipeId, recipe.id), notDeleted(mealRecipe)));
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
        { id: cb.id, name: "Cascade Book" },
        ctx.db,
        ctx.actor,
      );

      const preview = await previewDeleteCookbooks(ctx.db, [cb.id]);
      const recipeChange = preview.changes.find(
        (c) => c.edgeKey === "Recipe.cookbookId",
      );
      expect(recipeChange?.total).toBe(1);
      expect(recipeChange?.byTargetId[cb.id]).toBe(1);

      const { deletedRecipeIds } = await deleteCookbook(
        ctx.db,
        cb.id,
        ctx.actor,
      );
      expect(deletedRecipeIds).toEqual([recipeId]);
    });

    it("task delete: predicted subtask cascade matches what actually gets soft-deleted", async () => {
      const parent = await createTask(
        ctx.db,
        taskCreateInput.parse({ name: "Parent Task", trade: "other" }),
        ctx.actor,
      );
      const child = await createTask(
        ctx.db,
        taskCreateInput.parse({
          name: "Subtask",
          trade: "other",
          parentTaskId: parent.id,
        }),
        ctx.actor,
      );

      const preview = await previewDeleteTasks(ctx.db, [parent.id]);
      const subtaskChange = preview.changes.find(
        (c) => c.edgeKey === "Task.parentTaskId",
      );
      expect(subtaskChange?.total).toBe(1);
      expect(subtaskChange?.byTargetId[parent.id]).toBe(1);

      await deleteTasks(ctx.db, [parent.id], ctx.actor);

      const rows = await getDb(ctx.db)
        .select({ id: task.id, deletedAt: task.deletedAt })
        .from(task)
        .where(inArray(task.id, [parent.id, child.id]));
      for (const row of rows) {
        expect(row.deletedAt).not.toBeNull();
      }
    });

    it("purchase delete: predicted expense-detach count matches what actually gets nulled", async () => {
      const vendor = await createVendor(
        ctx.db,
        vendorCreateInput.parse({ name: "Detach Vendor" }),
        ctx.actor,
      );
      const purchase = await createPurchase(
        ctx.db,
        purchaseCreateInput.parse({ vendorId: vendor.id }),
        ctx.actor,
      );
      const line = await createExpense(
        ctx.db,
        { ...makeExpenseInput(), name: "Detach Line", purchaseId: purchase.id },
        ctx.actor,
      );

      const preview = await previewDeletePurchases(ctx.db, [purchase.id]);
      const detachChange = preview.changes.find(
        (c) => c.edgeKey === "Expense.purchaseId",
      );
      expect(detachChange?.total).toBe(1);
      expect(detachChange?.byTargetId[purchase.id]).toBe(1);

      await deletePurchases(ctx.db, [purchase.id], ctx.actor);

      const [row] = await getDb(ctx.db)
        .select({ purchaseId: expense.purchaseId })
        .from(expense)
        .where(eq(expense.id, line.id));
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

      const preview = await previewDeleteMeals(ctx.db, [meal.id]);
      const linkChange = preview.changes.find(
        (c) => c.edgeKey === "MealRecipe.mealId",
      );
      expect(linkChange?.total).toBe(2);
      expect(linkChange?.byTargetId[meal.id]).toBe(2);

      await deleteMeals(ctx.db, [meal.id], ctx.actor);

      const liveLinks = await getDb(ctx.db)
        .select({ id: mealRecipe.id })
        .from(mealRecipe)
        .where(and(eq(mealRecipe.mealId, meal.id), notDeleted(mealRecipe)));
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

  // ---------------------------------------------------------------------
  // 3. Per-target breakdown — a bulk delete must say WHICH target has the
  // dependents, not just that one somewhere does.
  // ---------------------------------------------------------------------
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
        blockedProduct.id,
        cleanProduct.id,
      ]);
      const inventoryBlocker = preview.blockers.find(
        (b) => b.edgeKey === "InventoryEntry.productId",
      );
      expect(inventoryBlocker?.total).toBe(1);
      expect(inventoryBlocker?.byTargetId).toEqual({
        [blockedProduct.id]: 1,
      });
      expect(inventoryBlocker?.byTargetId[cleanProduct.id]).toBeUndefined();

      // The mutation agrees per-target: the clean product deletes fine on its
      // own, while the blocked one alone still throws.
      await expect(
        deleteProducts(ctx.db, [cleanProduct.id], ctx.actor),
      ).resolves.toBeUndefined();
      await expect(
        deleteProducts(ctx.db, [blockedProduct.id], ctx.actor),
      ).rejects.toMatchObject({
        cause: { reason: "PRODUCT_HAS_INVENTORY" },
      });
    });
  });

  // ---------------------------------------------------------------------
  // 4. Merge candidates — previewMergeIngredientCandidates must rank a USDA
  // link above products-only, above recipe-usage-only, above aliases-only.
  // ---------------------------------------------------------------------
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
        usdaLinked.id,
        productOnly.id,
        recipeUsageOnly.id,
        aliasesOnly.id,
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

  // ---------------------------------------------------------------------
  // 5. Empty ids and zero-incoming-edge entities.
  // ---------------------------------------------------------------------
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
      const line = await createExpense(
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
          entityId: line.id,
          embeddingText: `expense ${line.id}`,
          embeddingHash: `hash-${line.id}`,
          provider: "test",
          model: "test",
          dimensions: 3,
          embedding: [0, 0, 0],
        });

      const preview = await previewDeleteExpenses(ctx.db, [line.id]);
      expect(preview.blockers).toEqual([]);
      expect(preview.changes).toEqual([]);
      expect(preview.sideEffects.length).toBeGreaterThan(0);

      await expect(
        deleteExpenses(ctx.db, [line.id], ctx.actor),
      ).resolves.toBeUndefined();
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

      const preview = await previewDeleteInventoryEntries(ctx.db, [entry.id]);
      expect(preview.blockers).toEqual([]);
      expect(preview.changes).toEqual([]);
      expect(
        preview.sideEffects.some(
          (s) => s.code === "location-valuation-recompute",
        ),
      ).toBe(true);

      await expect(
        deleteInventoryEntries(ctx.db, [entry.id], ctx.actor),
      ).resolves.toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------
  // 6. Router dispatch — every declared {operation, entity} pair in the
  // schema's own enums must route to a planner and return a payload that
  // parses against previewOperationSchema. Driven off the schema so a newly
  // added entity is automatically covered.
  // ---------------------------------------------------------------------
  describe("router dispatch: previewOperation", () => {
    for (const entity of previewDeleteEntitySchema.options) {
      it(`delete/${entity} dispatches to a planner and returns a schema-valid payload`, async () => {
        const result = await previewOperation(
          ctx.db,
          { operation: "delete", entity, ids: [NONEXISTENT_UUID] },
          new Date(),
        );
        expect(result.operation).toBe("delete");
        expect(result.entity).toBe(entity);
        expect(previewOperationSchema.safeParse(result).success).toBe(true);
      });
    }

    for (const entity of previewMergeEntitySchema.options) {
      it(`merge/${entity} dispatches to a planner and returns a schema-valid payload`, async () => {
        const result = await previewOperation(
          ctx.db,
          {
            operation: "merge",
            entity,
            keepId: NONEXISTENT_UUID,
            mergeIds: [NONEXISTENT_UUID_2],
          },
          new Date(),
        );
        expect(result.operation).toBe("merge");
        expect(result.entity).toBe(entity);
        expect(previewOperationSchema.safeParse(result).success).toBe(true);
      });
    }
  });
});
