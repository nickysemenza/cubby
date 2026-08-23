import {
  type PreviewDeleteEntity,
  type PreviewMergeEntity,
  type PublicImpactItem,
  previewOperationSchema,
} from "@cubby/schemas/entity-integrity";
import { financialAccountCreateInput } from "@cubby/schemas/financial-account";
import { financialTransactionCreateInput } from "@cubby/schemas/financial-transaction";
import {
  unsafeFinancialAccountId,
  unsafeFinancialTransactionId,
  unsafeImageId,
  unsafeImageShortcode,
  unsafeLocationId,
  unsafePersonId,
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
import { wishCreateInput } from "@cubby/schemas/wish";
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
  product,
  productImage,
  recipe,
  recipeSection,
  task,
} from "~/server/db/schema";
import {
  createFinancialAccount,
  deleteFinancialAccounts,
  previewDeleteFinancialAccounts,
} from "~/server/repo/financial-account";
import {
  createFinancialTransaction,
  deleteFinancialTransactions,
  previewDeleteFinancialTransactions,
} from "~/server/repo/financial-transaction";
import { previewDeleteLocations } from "~/server/repo/location/crud";
import { previewMergeProducts } from "~/server/repo/product/merge";
import { previewDeleteProjects } from "~/server/repo/project/crud";
import {
  deleteCookbook,
  previewDeleteCookbooks,
  setCookbookProduct,
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
import { previewDeletePeople, previewMergePeople } from "./person";
import { deleteProducts } from "./product";
import { previewDeleteProducts } from "./product/crud";
import {
  attachProductComponents,
  detachProductComponents,
} from "./product-components";
import { createProject, deleteProjects } from "./project";
import { attachProjectResources } from "./project/tools";
import {
  createPurchase,
  deletePurchases,
  mergePurchases,
  previewDeletePurchases,
  previewMergePurchases,
} from "./purchase";
import { attachPurchaseProducts } from "./purchase-products";
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
import { createWish, deleteWishes, previewDeleteWishes } from "./wish";

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
      /**
       * The edge the preview must name as the blocker. Every DELETE blocker
       * comes from a declared incoming edge and has one; a relation refusal
       * (wrong category, a component cycle) is not an edge at all, so those
       * rows identify their blocker by {@link blockerCode} instead.
       */
      edgeKey?: string;
      /** The `ImpactItem.code` the preview must name, for edge-less blockers. */
      blockerCode?: string;
      /** The `cause.reason` the mutation must refuse with. */
      reason: string;
      /**
       * The tRPC code the mutation must refuse with. Defaults to
       * PRECONDITION_FAILED, which every delete blocker uses; an attach refusal
       * can be NOT_FOUND (the product is gone) or BAD_REQUEST (a cycle).
       */
      code?: string;
      /**
       * Shortcodes the refusal must NAME, in `cause.blockers[].byTargetId`.
       * This is the half that used to be computed and thrown away — a row that
       * sets it asserts the ids actually reach the client.
       */
      expectBlockerIds?: string[];
      /** The mutation under test. Called once blocked, once unblocked. */
      remove: () => Promise<unknown>;
      /** Delete the blocking row, so the second pass can proceed. */
      clearBlocker: () => Promise<unknown>;
      /** What the now-permitted delete resolves to. */
      expectResolved: (result: unknown) => void;
    }

    const detachesNoImages = (result: unknown) =>
      expect(result).toMatchObject({ detachedImageKeys: [] });
    // Every delete now measures and reports how many rows it actually
    // removed (see repo/removal/entity.ts's `deleted`) rather than returning
    // void — each case using this helper unblocks and removes exactly the one
    // row the blocker was attached to.
    const deletesOneRow = (result: unknown) =>
      expect(result).toEqual({ deleted: 1 });

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
            expectResolved: deletesOneRow,
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
            expectResolved: detachesNoImages,
          };
        },
      ],
      [
        "ingredient: a live linked product blocks delete",
        async () => {
          const ingredient = await createIngredient(
            ctx.db,
            { name: "Blocked-By-Product Ingredient", aliases: [] },
            ctx.actor,
          );
          const product = await createProduct(
            ctx.db,
            makeProductInput({
              name: "Links Blocked Ingredient",
              upc: "800000000030",
              ingredientId: ingredient.id,
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
            edgeKey: "Product.ingredientId",
            reason: "INGREDIENT_HAS_PRODUCTS",
            remove: () =>
              deleteIngredients(ctx.db, [ingredient.entityId], ctx.actor),
            clearBlocker: () =>
              deleteProducts(ctx.db, [product.entityId], ctx.actor),
            expectResolved: deletesOneRow,
          };
        },
      ],
      [
        "project: a live sub-project blocks delete",
        async () => {
          const { output: parent } = await createProject(
            ctx.db,
            projectCreateInput.parse({ name: "Blocked Parent Project" }),
            ctx.actor,
          );
          const { output: child } = await createProject(
            ctx.db,
            projectCreateInput.parse({
              name: "Blocking Child Project",
              parentProjectId: parent.id,
            }),
            ctx.actor,
          );
          return {
            preview: () =>
              previewOperation(
                ctx.db,
                { operation: "delete", entity: "project", ids: [parent.id] },
                new Date(),
              ),
            edgeKey: "Project.parentProjectId",
            reason: "PROJECT_HAS_CHILDREN",
            remove: () => deleteProjects(ctx.db, [parent.id], ctx.actor),
            clearBlocker: () => deleteProjects(ctx.db, [child.id], ctx.actor),
            expectResolved: detachesNoImages,
          };
        },
      ],
      [
        "project: a live expense blocks delete",
        async () => {
          const { output: project } = await createProject(
            ctx.db,
            projectCreateInput.parse({ name: "Expense-Blocked Project" }),
            ctx.actor,
          );
          const { output: line } = await createExpense(
            ctx.db,
            {
              ...makeExpenseInput(),
              name: "Blocking Project Expense",
              projectId: project.id,
            },
            ctx.actor,
          );
          return {
            preview: () =>
              previewOperation(
                ctx.db,
                { operation: "delete", entity: "project", ids: [project.id] },
                new Date(),
              ),
            edgeKey: "Expense.projectId",
            reason: "PROJECT_HAS_EXPENSES",
            remove: () => deleteProjects(ctx.db, [project.id], ctx.actor),
            clearBlocker: () => deleteExpenses(ctx.db, [line.id], ctx.actor),
            expectResolved: detachesNoImages,
          };
        },
      ],
      [
        "product: a live expense blocks delete",
        async () => {
          const product = await createProduct(
            ctx.db,
            makeProductInput({
              name: "Expense-Blocked Product",
              upc: "800000000031",
            }),
            ctx.actor,
          );
          const { output: line } = await createExpense(
            ctx.db,
            {
              ...makeExpenseInput(),
              name: "Blocking Product Expense",
              productId: product.id,
            },
            ctx.actor,
          );
          return {
            preview: () =>
              previewOperation(
                ctx.db,
                { operation: "delete", entity: "product", ids: [product.id] },
                new Date(),
              ),
            edgeKey: "Expense.productId",
            reason: "PRODUCT_HAS_EXPENSES",
            remove: () => deleteProducts(ctx.db, [product.entityId], ctx.actor),
            clearBlocker: () => deleteExpenses(ctx.db, [line.id], ctx.actor),
            expectResolved: detachesNoImages,
          };
        },
      ],
      [
        "product: a live task subject blocks delete",
        async () => {
          const product = await createProduct(
            ctx.db,
            makeProductInput({
              name: "Task-Blocked Product",
              upc: "800000000032",
            }),
            ctx.actor,
          );
          const { output: taskRow } = await createTask(
            ctx.db,
            taskCreateInput.parse({
              name: "Blocking Task Subject",
              trade: "other",
              subjectProductId: product.id,
            }),
            ctx.actor,
          );
          return {
            preview: () =>
              previewOperation(
                ctx.db,
                { operation: "delete", entity: "product", ids: [product.id] },
                new Date(),
              ),
            edgeKey: "Task.subjectProductId",
            reason: "PRODUCT_HAS_TASKS",
            remove: () => deleteProducts(ctx.db, [product.entityId], ctx.actor),
            clearBlocker: () => deleteTasks(ctx.db, [taskRow.id], ctx.actor),
            expectResolved: detachesNoImages,
          };
        },
      ],
      [
        "product: a live project tool-use blocks delete",
        async () => {
          const { output: project, entityId: projectId } = await createProject(
            ctx.db,
            projectCreateInput.parse({ name: "Tool-Use Blocked Project" }),
            ctx.actor,
          );
          const tool = await createProduct(
            ctx.db,
            makeProductInput({
              name: "Project-Use-Blocked Tool",
              upc: "800000000033",
              category: "tools",
            }),
            ctx.actor,
          );
          await attachProjectResources(
            ctx.db,
            projectId,
            [tool.entityId],
            ctx.actor,
          );
          return {
            preview: () =>
              previewOperation(
                ctx.db,
                { operation: "delete", entity: "product", ids: [tool.id] },
                new Date(),
              ),
            edgeKey: "ProjectToolUsage.productId",
            reason: "PRODUCT_HAS_PROJECT_USES",
            remove: () => deleteProducts(ctx.db, [tool.entityId], ctx.actor),
            // Cascades the ProjectToolUsage row along with the project, the
            // same edge `project-tools.integration.test.ts` exercises from the
            // mutation side alone.
            clearBlocker: () => deleteProjects(ctx.db, [project.id], ctx.actor),
            expectResolved: detachesNoImages,
          };
        },
      ],
      [
        "product: a live purchase link blocks delete",
        async () => {
          const { output: vendor } = await createVendor(
            ctx.db,
            vendorCreateInput.parse({ name: "Purchase-Link Vendor" }),
            ctx.actor,
          );
          const { output: purchase, entityId: purchaseId } =
            await createPurchase(
              ctx.db,
              purchaseCreateInput.parse({
                date: "2024-01-15",
                vendorId: vendor.id,
              }),
              ctx.actor,
            );
          const product = await createProduct(
            ctx.db,
            makeProductInput({
              name: "Purchase-Link-Blocked Product",
              upc: "800000000034",
            }),
            ctx.actor,
          );
          await attachPurchaseProducts(
            ctx.db,
            purchaseId,
            [product.entityId],
            ctx.actor,
          );
          return {
            preview: () =>
              previewOperation(
                ctx.db,
                { operation: "delete", entity: "product", ids: [product.id] },
                new Date(),
              ),
            edgeKey: "PurchaseProduct.productId",
            reason: "PRODUCT_HAS_PURCHASE_LINKS",
            remove: () => deleteProducts(ctx.db, [product.entityId], ctx.actor),
            // Cascades the PurchaseProduct link along with the purchase — the
            // same edge PURCHASE_DELETE_EDGE_POLICY soft-deletes.
            clearBlocker: () =>
              deletePurchases(ctx.db, [purchase.id], ctx.actor),
            expectResolved: detachesNoImages,
          };
        },
      ],
      [
        "product: a live wishlist candidate blocks delete",
        async () => {
          const product = await createProduct(
            ctx.db,
            makeProductInput({
              name: "Wish-Blocked Tool",
              upc: "800000000035",
              category: "tools",
            }),
            ctx.actor,
          );
          const { output: wish } = await createWish(
            ctx.db,
            wishCreateInput.parse({
              name: "Blocking Wish",
              candidateProductIds: [product.id],
            }),
            ctx.actor,
          );
          return {
            preview: () =>
              previewOperation(
                ctx.db,
                { operation: "delete", entity: "product", ids: [product.id] },
                new Date(),
              ),
            edgeKey: "WishCandidate.productId",
            reason: "PRODUCT_HAS_WISH_CANDIDATES",
            remove: () => deleteProducts(ctx.db, [product.entityId], ctx.actor),
            clearBlocker: () => deleteWishes(ctx.db, [wish.id], ctx.actor),
            expectResolved: detachesNoImages,
          };
        },
      ],
      [
        "product: a location that IS the product blocks delete",
        async () => {
          const product = await createProduct(
            ctx.db,
            makeProductInput({
              name: "Location-Identity Product",
              upc: "800000000036",
            }),
            ctx.actor,
          );
          const location = await createLocation(
            ctx.db,
            makeLocationInput({
              name: "Location-Identity Bin",
              type: null,
              productId: product.id,
              parentId: null,
            }),
            ctx.actor,
          );
          return {
            preview: () =>
              previewOperation(
                ctx.db,
                { operation: "delete", entity: "product", ids: [product.id] },
                new Date(),
              ),
            edgeKey: "Location.productId",
            reason: "PRODUCT_HAS_LOCATIONS",
            remove: () => deleteProducts(ctx.db, [product.entityId], ctx.actor),
            clearBlocker: () =>
              deleteLocations(ctx.db, [location.entityId], ctx.actor),
            expectResolved: detachesNoImages,
          };
        },
      ],
      [
        "product: a cookbook's physical copy blocks delete",
        async () => {
          const cb = await upsertCookbook(
            ctx.db,
            {
              name: "Copy-Blocked Cookbook",
              rawJson: [],
              sourceLabel: "copy-blocked.epub",
            },
            ctx.actor,
          );
          const product = await createProduct(
            ctx.db,
            makeProductInput({
              name: "Cookbook Physical Copy",
              upc: "800000000037",
            }),
            ctx.actor,
          );
          await setCookbookProduct(
            ctx.db,
            ctx.actor,
            cb.entityId,
            product.entityId,
          );
          return {
            preview: () =>
              previewOperation(
                ctx.db,
                { operation: "delete", entity: "product", ids: [product.id] },
                new Date(),
              ),
            edgeKey: "Cookbook.productId",
            reason: "PRODUCT_HAS_COOKBOOKS",
            remove: () => deleteProducts(ctx.db, [product.entityId], ctx.actor),
            clearBlocker: () => deleteCookbook(ctx.db, cb.entityId, ctx.actor),
            expectResolved: detachesNoImages,
          };
        },
      ],
      [
        "product: a live kit membership blocks delete",
        async () => {
          const kit = await createProduct(
            ctx.db,
            makeProductInput({ name: "Blocking Kit", upc: "800000000038" }),
            ctx.actor,
          );
          const part = await createProduct(
            ctx.db,
            makeProductInput({
              name: "Kit-Membership-Blocked Part",
              upc: "800000000039",
            }),
            ctx.actor,
          );
          await attachProductComponents(
            ctx.db,
            kit.entityId,
            [{ productId: part.entityId, quantity: 1 }],
            ctx.actor,
          );
          return {
            preview: () =>
              previewOperation(
                ctx.db,
                { operation: "delete", entity: "product", ids: [part.id] },
                new Date(),
              ),
            edgeKey: "ProductComponent.componentProductId",
            reason: "PRODUCT_HAS_KIT_LINKS",
            remove: () => deleteProducts(ctx.db, [part.entityId], ctx.actor),
            clearBlocker: () =>
              detachProductComponents(
                ctx.db,
                kit.entityId,
                [part.entityId],
                ctx.actor,
              ),
            expectResolved: detachesNoImages,
          };
        },
      ],
      [
        "financialAccount: a live financial transaction blocks delete",
        async () => {
          const { output: account } = await createFinancialAccount(
            ctx.db,
            financialAccountCreateInput.parse({
              name: "Blocked Financial Account",
              identity: { kind: "cash" },
            }),
            ctx.actor,
          );
          const { output: txn } = await createFinancialTransaction(
            ctx.db,
            financialTransactionCreateInput.parse({
              accountId: account.id,
              kind: "fee",
              status: "pending",
              amount: 25,
            }),
            ctx.actor,
          );
          return {
            preview: () =>
              previewOperation(
                ctx.db,
                {
                  operation: "delete",
                  entity: "financialAccount",
                  ids: [account.id],
                },
                new Date(),
              ),
            edgeKey: "FinancialTransaction.accountId",
            reason: "FINANCIAL_ACCOUNT_HAS_TRANSACTIONS",
            remove: () =>
              deleteFinancialAccounts(ctx.db, [account.id], ctx.actor),
            clearBlocker: () =>
              deleteFinancialTransactions(ctx.db, [txn.id], ctx.actor),
            expectResolved: deletesOneRow,
          };
        },
      ],
      // ── Relation verbs. Same claim as every row above, one operation over:
      // the preview refuses, the mutation refuses with the matching reason, and
      // clearing the cause flips BOTH to permitted.
      [
        "project attach: a wrong-category product is INELIGIBLE, not missing",
        async () => {
          const { output: project, entityId: projectId } = await createProject(
            ctx.db,
            projectCreateInput.parse({ name: "Category Gate Project" }),
            ctx.actor,
          );
          // Live, resolvable, and the wrong kind — the exact case that used to
          // come back as PRODUCT_NOT_FOUND and send the caller hunting for a
          // typo in a shortcode that resolves perfectly well.
          const material = await createProduct(
            ctx.db,
            makeProductInput({
              name: "Category Gate Lumber",
              upc: "800000000060",
              category: "hardware",
            }),
            ctx.actor,
          );
          return {
            preview: () =>
              previewOperation(
                ctx.db,
                {
                  operation: "attach",
                  entity: "project",
                  parentId: project.id,
                  productIds: [material.id],
                },
                new Date(),
              ),
            blockerCode: "block-product-category-ineligible",
            reason: "PRODUCT_CATEGORY_INELIGIBLE",
            expectBlockerIds: [material.id],
            remove: () =>
              attachProjectResources(
                ctx.db,
                projectId,
                [material.entityId],
                ctx.actor,
              ),
            clearBlocker: () =>
              getDb(ctx.db)
                .update(product)
                .set({ category: "tools" })
                .where(eq(product.id, material.entityId)),
            expectResolved: (result: unknown) =>
              expect(result).toEqual({
                changed: 1,
                attached: 1,
                alreadySatisfied: 0,
              }),
          };
        },
      ],
      [
        "product attach: a multi-hop component cycle is refused and named",
        async () => {
          const outer = await createProduct(
            ctx.db,
            makeProductInput({ name: "Cycle Outer Kit", upc: "800000000061" }),
            ctx.actor,
          );
          const inner = await createProduct(
            ctx.db,
            makeProductInput({ name: "Cycle Inner Kit", upc: "800000000062" }),
            ctx.actor,
          );
          // outer contains inner; attaching outer INTO inner closes the loop.
          await attachProductComponents(
            ctx.db,
            outer.entityId,
            [{ productId: inner.entityId, quantity: 1 }],
            ctx.actor,
          );
          return {
            preview: () =>
              previewOperation(
                ctx.db,
                {
                  operation: "attach",
                  entity: "product",
                  parentId: inner.id,
                  productIds: [outer.id],
                },
                new Date(),
              ),
            blockerCode: "block-component-cycle",
            reason: "PRODUCT_COMPONENT_CYCLE",
            code: "BAD_REQUEST",
            expectBlockerIds: [inner.id],
            remove: () =>
              attachProductComponents(
                ctx.db,
                inner.entityId,
                [{ productId: outer.entityId, quantity: 1 }],
                ctx.actor,
              ),
            clearBlocker: () =>
              detachProductComponents(
                ctx.db,
                outer.entityId,
                [inner.entityId],
                ctx.actor,
              ),
            expectResolved: (result: unknown) =>
              expect(result).toEqual({
                changed: 1,
                attached: 1,
                alreadySatisfied: 0,
              }),
          };
        },
      ],
      [
        "purchase attach: a soft-deleted product is refused and named",
        async () => {
          const { output: vendor } = await createVendor(
            ctx.db,
            vendorCreateInput.parse({ name: "Dead-Product Vendor" }),
            ctx.actor,
          );
          const { output: order, entityId: purchaseId } = await createPurchase(
            ctx.db,
            purchaseCreateInput.parse({
              date: "2024-02-01",
              vendorId: vendor.id,
            }),
            ctx.actor,
          );
          const gone = await createProduct(
            ctx.db,
            makeProductInput({ name: "Gone Product", upc: "800000000063" }),
            ctx.actor,
          );
          await deleteProducts(ctx.db, [gone.entityId], ctx.actor);
          return {
            preview: () =>
              previewOperation(
                ctx.db,
                {
                  operation: "attach",
                  entity: "purchase",
                  parentId: order.id,
                  productIds: [gone.id],
                },
                new Date(),
              ),
            // The preview resolves shortcodes before planning, so a
            // soft-deleted target is caught one step earlier than the repo's
            // own liveness check — different code, same refusal, and both name
            // the offending shortcode.
            blockerCode: "block-unresolved-target",
            reason: "PRODUCT_NOT_FOUND",
            code: "NOT_FOUND",
            expectBlockerIds: [gone.id],
            remove: () =>
              attachPurchaseProducts(
                ctx.db,
                purchaseId,
                [gone.entityId],
                ctx.actor,
              ),
            clearBlocker: () =>
              getDb(ctx.db)
                .update(product)
                .set({ deletedAt: null })
                .where(eq(product.id, gone.entityId)),
            expectResolved: (result: unknown) =>
              expect(result).toEqual({
                changed: 1,
                attached: 1,
                alreadySatisfied: 0,
              }),
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
        if (subject.edgeKey) {
          expect(blocked.blockers.map((b) => b.edgeKey)).toContain(
            subject.edgeKey,
          );
        }
        if (subject.blockerCode) {
          expect(blocked.blockers.map((b) => b.code)).toContain(
            subject.blockerCode,
          );
        }
        await expect(subject.remove()).rejects.toMatchObject({
          code: subject.code ?? "PRECONDITION_FAILED",
          cause: { reason: subject.reason },
        });
        if (subject.expectBlockerIds) {
          // Asserted on the STRUCTURE, never the sentence: `blockers` is what a
          // tRPC client reads off `error.data` and what `attach_entity` puts in
          // its `refusal`. A message that happens to mention the code proves
          // nothing about either.
          const refusal = await subject
            .remove()
            .catch((error: unknown) => error);
          const blockers = (
            refusal as { cause?: { blockers?: PublicImpactItem[] } }
          ).cause?.blockers;
          expect(blockers?.flatMap((b) => Object.keys(b.byTargetId))).toEqual(
            expect.arrayContaining(subject.expectBlockerIds),
          );
        }

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
          pendingImageIds: [unsafeImageShortcode(pendingImage.shortcode)],
        }),
        ctx.actor,
      );

      const preview = await previewDeleteImages(ctx.db, [pendingImage.id]);
      const assocChange = preview.changes.find(
        (c) => c.edgeKey === "ProductImage.imageId",
      );
      expect(assocChange?.total).toBe(1);

      await deleteImages(ctx.db, [unsafeImageId(pendingImage.id)]);

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
      ).resolves.toEqual({ deleted: 1 });
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
      person: (db) =>
        previewDeletePeople(db, [unsafePersonId(NONEXISTENT_UUID)]),
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

    // `keepId` must differ from `mergeIds`: every planner now REFUSES a
    // self-reference (`MERGE_SELF_REFERENCE`) — the same refusal the mutation
    // makes — so reusing one uuid for both would throw before any SQL ran and
    // quietly re-vacuate these tests.
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
      person: (db) =>
        previewMergePeople(db, {
          mergeIds: [unsafePersonId(NONEXISTENT_UUID)],
          keepId: unsafePersonId(NONEXISTENT_UUID_2),
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
