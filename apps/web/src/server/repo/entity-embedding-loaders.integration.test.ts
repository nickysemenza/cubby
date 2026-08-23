import { financialTransactionCreateInput } from "@cubby/schemas/financial-transaction";
import {
  expenseCreateInput,
  projectCreateInput,
  taskCreateInput,
} from "@cubby/schemas/project";
import {
  type SearchableEntity,
  searchableEntities,
} from "@cubby/schemas/search";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { mock } from "~/lib/test/mock-schema";
import { entityEmbedding } from "~/server/db/schema";
import { upsertCookbook } from "./cookbook";
import { getDb } from "./database-helpers";
import {
  findOrphanedEntityEmbeddings,
  getEmbeddingTextsForEntityTypes,
  getEmbeddingTextsForRefs,
  getEntityEmbeddingDeletedAtForRef,
  upsertEntityEmbedding,
} from "./entity-embedding";
import { createExpense } from "./expense";
import {
  createFinancialAccount,
  deleteFinancialAccounts,
} from "./financial-account";
import {
  createFinancialTransaction,
  deleteFinancialTransactions,
} from "./financial-transaction";
import { createPerson } from "./person";
import { createProject } from "./project";
import { createPurchase, deletePurchases, mergePurchases } from "./purchase";
import {
  createIngredientFixture as createIngredient,
  createInventoryFixture as createInventoryEntry,
  createLocationFixture as createLocation,
  createMealFixture as createMeal,
  createProductFixture as createProduct,
  createRecipeFixture as createRecipe,
  makeLocationInput,
  makeProductInput,
  makeRecipeInput,
} from "./repo.fixtures";
import {
  getSearchDocumentEmbeddingText,
  refreshSearchDocuments,
} from "./search-document";
import { createTask } from "./task";
import { createVendor, deleteVendors, mergeVendors } from "./vendor";
import { createWish } from "./wish";

describe("searchable entity loader maps", () => {
  const ctx = withTestDb();

  it("uses the same batch and single loaders for every searchable entity", async () => {
    const ingredient = await createIngredient(
      ctx.db,
      { name: "Loader ingredient", aliases: ["loader alias"] },
      ctx.actor,
    );
    const product = await createProduct(
      ctx.db,
      makeProductInput({
        name: "Loader product",
        ingredientId: ingredient.id,
      }),
      ctx.actor,
    );
    const wishProduct = await createProduct(
      ctx.db,
      makeProductInput({
        name: "Loader wish product",
        category: "tools",
      }),
      ctx.actor,
    );
    const location = await createLocation(
      ctx.db,
      makeLocationInput({ name: "Loader pantry" }),
      ctx.actor,
    );
    const inventory = await createInventoryEntry(
      ctx.db,
      {
        productId: product.id,
        locationId: location.id,
        amount: { value: 2, unit: "each" },
      },
      ctx.actor,
    );
    const recipe = await createRecipe(
      ctx.db,
      makeRecipeInput({ name: "Loader recipe" }),
      ctx.actor,
    );
    const { output: project, entityId: projectUuid } = await createProject(
      ctx.db,
      mock(projectCreateInput, { overrides: { name: "Loader project" } }),
      ctx.actor,
    );
    const { entityId: taskUuid } = await createTask(
      ctx.db,
      mock(taskCreateInput, {
        overrides: { name: "Loader task", projectId: project.id },
      }),
      ctx.actor,
    );
    const { entityId: expenseUuid } = await createExpense(
      ctx.db,
      mock(expenseCreateInput, {
        overrides: { name: "Loader expense", projectId: project.id },
      }),
      ctx.actor,
    );
    const cookbook = await upsertCookbook(
      ctx.db,
      {
        name: "Loader cookbook",
        rawJson: [],
        author: ["Loader author"],
        subjects: ["Loader subject"],
        sourceLabel: "loader.epub",
      },
      ctx.actor,
    );
    const meal = await createMeal(
      ctx.db,
      {
        date: "2026-01-15",
        name: "Loader meal",
        recipes: [{ recipeId: recipe.id, scale: 1 }],
      },
      ctx.actor,
    );
    const vendor = await createVendor(
      ctx.db,
      {
        name: "Loader vendor",
        website: null,
        orderUrlTemplate: null,
        notes: null,
      },
      ctx.actor,
    );
    const purchase = await createPurchase(
      ctx.db,
      {
        vendorId: vendor.output.id,
        orderId: "Loader order",
        date: "2026-01-15",
        statedTotal: null,
        notes: null,
      },
      ctx.actor,
    );
    const account = await createFinancialAccount(
      ctx.db,
      {
        name: "Loader account",
        identity: { kind: "cash" },
        provisional: false,
        sourceAliases: [],
        notes: null,
      },
      ctx.actor,
    );
    const transaction = await createFinancialTransaction(
      ctx.db,
      financialTransactionCreateInput.parse({
        accountId: account.output.id,
        purchaseId: purchase.output.id,
        kind: "purchase",
        status: "pending",
        amount: 25,
        merchant: "Loader merchant",
      }),
      ctx.actor,
    );
    const wish = await createWish(
      ctx.db,
      {
        name: "Loader wish",
        notes: "Loader notes",
        candidateProductIds: [wishProduct.id],
      },
      ctx.actor,
    );
    const person = await createPerson(
      ctx.db,
      { name: "Loader person", kind: "household", notes: null },
      ctx.actor,
    );
    const ids = {
      product: product.entityId,
      recipe: recipe.entityId,
      ingredient: ingredient.entityId,
      cookbook: cookbook.entityId,
      location: location.entityId,
      inventory: inventory.entityId,
      meal: meal.entityId,
      person: person.entityId,
      project: projectUuid,
      task: taskUuid,
      vendor: vendor.entityId,
      purchase: purchase.entityId,
      financialAccount: account.entityId,
      financialTransaction: transaction.entityId,
      expense: expenseUuid,
      wish: wish.entityId,
    } satisfies Record<SearchableEntity, string>;

    const batch = await getEmbeddingTextsForEntityTypes(ctx.db, [
      ...searchableEntities,
    ]);
    const byRef = new Map(
      batch.map((row) => [`${row.entityType}:${row.entityId}`, row]),
    );

    const documentRefs = searchableEntities.map((entityType) => ({
      entityType,
      entityId: ids[entityType],
    }));
    const refreshed = await refreshSearchDocuments(ctx.db, documentRefs);
    expect(refreshed).toHaveLength(searchableEntities.length);
    expect(refreshed.every((result) => result.status === "upserted")).toBe(
      true,
    );

    for (const entityType of searchableEntities) {
      const [single] = await getEmbeddingTextsForRefs(
        ctx.db,
        new Map([[entityType, [ids[entityType]]]]),
      );
      expect(single).toEqual(byRef.get(`${entityType}:${ids[entityType]}`));
      expect(single?.embeddingText).toContain("Loader");
      expect(
        await getSearchDocumentEmbeddingText(
          ctx.db,
          entityType,
          ids[entityType],
        ),
      ).toEqual(single);
    }
  });

  it("checks live IDs through every orphan loader", async () => {
    const refs = searchableEntities.map((entityType, index) => ({
      entityType,
      entityId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    }));
    await getDb(ctx.db)
      .insert(entityEmbedding)
      .values(
        refs.map((ref) => ({
          ...ref,
          embeddingText: `orphan ${ref.entityType}`,
          embeddingHash: `orphan-${ref.entityType}`,
          provider: "test",
          model: "test",
          dimensions: 3,
          embedding: [0, 0, 0],
        })),
      );

    const orphaned = await findOrphanedEntityEmbeddings(ctx.db);
    expect(orphaned.map(({ entityType }) => entityType).sort()).toEqual(
      [...searchableEntities].sort(),
    );

    // `createdAt` must be a real Date, not the string a raw `execute` hands
    // back. `orphanedEntityEmbeddingSchema` validates it as `z.date()`, so a
    // string here fails output validation for the ENTIRE problems payload —
    // taking down the Problems page at exactly the moment this detector has
    // something to report. The row shape was previously only asserted by a
    // generic on the query, which the driver never honoured.
    for (const row of orphaned) {
      expect(row.createdAt).toBeInstanceOf(Date);
      expect(Number.isNaN(row.createdAt.getTime())).toBe(false);
    }
  });

  it("retires finance embeddings on delete and merge removal paths", async () => {
    const config = {
      provider: "openai",
      model: "text-embedding-3-small",
      dimensions: 3,
    } as const;
    const seed = (entityType: SearchableEntity, entityId: string) =>
      upsertEntityEmbedding(ctx.db, {
        entityType,
        entityId,
        embeddingText: `${entityType} removal fixture`,
        config,
        embedding: [0, 0, 0],
      });

    const doomedVendor = await createVendor(
      ctx.db,
      {
        name: "Embedding delete vendor",
        website: null,
        orderUrlTemplate: null,
        notes: null,
      },
      ctx.actor,
    );
    const purchaseVendor = await createVendor(
      ctx.db,
      {
        name: "Embedding purchase vendor",
        website: null,
        orderUrlTemplate: null,
        notes: null,
      },
      ctx.actor,
    );
    const doomedPurchase = await createPurchase(
      ctx.db,
      {
        vendorId: purchaseVendor.output.id,
        orderId: "embedding-delete-order",
        date: "2026-01-15",
        statedTotal: null,
        notes: null,
      },
      ctx.actor,
    );
    const account = await createFinancialAccount(
      ctx.db,
      {
        name: "Embedding delete account",
        identity: { kind: "cash" },
        provisional: false,
        sourceAliases: [],
        notes: null,
      },
      ctx.actor,
    );
    const transaction = await createFinancialTransaction(
      ctx.db,
      financialTransactionCreateInput.parse({
        accountId: account.output.id,
        kind: "fee",
        status: "pending",
        amount: 5,
      }),
      ctx.actor,
    );
    const deleteRefs = [
      { entityType: "vendor", entityId: doomedVendor.entityId },
      { entityType: "purchase", entityId: doomedPurchase.entityId },
      { entityType: "financialAccount", entityId: account.entityId },
      {
        entityType: "financialTransaction",
        entityId: transaction.entityId,
      },
    ] as const;
    await Promise.all(
      deleteRefs.map((ref) => seed(ref.entityType, ref.entityId)),
    );
    await deleteVendors(ctx.db, [doomedVendor.output.id], ctx.actor);
    await deletePurchases(ctx.db, [doomedPurchase.output.id], ctx.actor);
    await deleteFinancialTransactions(
      ctx.db,
      [transaction.output.id],
      ctx.actor,
    );
    await deleteFinancialAccounts(ctx.db, [account.output.id], ctx.actor);
    for (const ref of deleteRefs) {
      expect(
        await getEntityEmbeddingDeletedAtForRef(ctx.db, ref),
      ).toBeInstanceOf(Date);
    }

    const vendorKeep = await createVendor(
      ctx.db,
      {
        name: "Embedding vendor keeper",
        website: null,
        orderUrlTemplate: null,
        notes: null,
      },
      ctx.actor,
    );
    const vendorDrop = await createVendor(
      ctx.db,
      {
        name: "Embedding vendor loser",
        website: null,
        orderUrlTemplate: null,
        notes: null,
      },
      ctx.actor,
    );
    const purchaseKeep = await createPurchase(
      ctx.db,
      {
        vendorId: vendorKeep.output.id,
        orderId: null,
        date: "2026-01-16",
        statedTotal: null,
        notes: null,
      },
      ctx.actor,
    );
    const purchaseDrop = await createPurchase(
      ctx.db,
      {
        vendorId: vendorKeep.output.id,
        orderId: null,
        date: "2026-01-17",
        statedTotal: null,
        notes: null,
      },
      ctx.actor,
    );
    await Promise.all([
      seed("vendor", vendorDrop.entityId),
      seed("purchase", purchaseDrop.entityId),
    ]);
    await mergeVendors(
      ctx.db,
      { keepId: vendorKeep.output.id, mergeIds: [vendorDrop.output.id] },
      ctx.actor,
    );
    await mergePurchases(
      ctx.db,
      { keepId: purchaseKeep.output.id, mergeIds: [purchaseDrop.output.id] },
      ctx.actor,
    );
    for (const ref of [
      { entityType: "vendor" as const, entityId: vendorDrop.entityId },
      { entityType: "purchase" as const, entityId: purchaseDrop.entityId },
    ]) {
      expect(
        await getEntityEmbeddingDeletedAtForRef(ctx.db, ref),
      ).toBeInstanceOf(Date);
    }
  });
});
