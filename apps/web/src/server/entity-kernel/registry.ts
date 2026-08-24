import type { BackgroundBatchRef } from "@cubby/schemas/background-jobs";
import type { ActorContext } from "@cubby/schemas/context";
import type { OperationDisposition } from "@cubby/schemas/entity-integrity";
import {
  financialAccountFiltersSchema,
  financialAccountSortableFields,
} from "@cubby/schemas/financial-account";
import {
  financialTransactionFiltersSchema,
  financialTransactionSortableFields,
} from "@cubby/schemas/financial-transaction";
import {
  imageShortcode,
  unsafeIngredientId,
  unsafeVendorId,
} from "@cubby/schemas/identifiers";
import {
  imageListFiltersSchema,
  imageSortableFields,
  imageUpdateInput,
  imageWithEntitySchema,
} from "@cubby/schemas/image";
import {
  ingredientFiltersSchema,
  ingredientListItemOut,
  ingredientMergeInput,
  mergeSummary as ingredientMergeSummary,
  ingredientSortableFields,
} from "@cubby/schemas/ingredient";
import {
  inventoryFiltersSchema,
  inventoryListItemOut,
  inventorySortableFields,
} from "@cubby/schemas/inventory";
import {
  ledgerPartyFiltersSchema,
  ledgerPartyOut,
  ledgerPartySortableFields,
} from "@cubby/schemas/ledger-party";
import {
  ledgerTransferFiltersSchema,
  ledgerTransferSortableFields,
} from "@cubby/schemas/ledger-transfer";
import {
  locationFiltersSchema,
  locationListItemOut,
  locationSortableFields,
} from "@cubby/schemas/location";
import { mealFiltersSchema, mealSortableFields } from "@cubby/schemas/meal";
import type { PaginationParams, SortParams } from "@cubby/schemas/pagination";
import {
  mergeProductsInput,
  productFiltersSchema,
  productListItemOut,
  productMergeSummaryOut,
  productSortableFields,
} from "@cubby/schemas/product";
import {
  expenseFiltersSchema,
  expenseSortableFields,
  projectFiltersSchema,
  projectSortableFields,
  taskFiltersSchema,
  taskSortableFields,
} from "@cubby/schemas/project";
import {
  mergePurchasesInput,
  mergePurchasesOut,
  purchaseFiltersSchema,
  purchaseSortableFields,
} from "@cubby/schemas/purchase";
import {
  recipeFiltersSchema,
  recipeListItemOut,
  recipeSortableFields,
} from "@cubby/schemas/recipe";
import {
  mergeVendorsInput,
  mergeVendorsOut,
  vendorFiltersSchema,
  vendorSortableFields,
} from "@cubby/schemas/vendor";
import { wishFiltersSchema, wishSortableFields } from "@cubby/schemas/wish";
import { type ZodSchema, z } from "zod";
import type { UPCLookupClient } from "~/server/clients/upc-lookup";
import type { USDAClient } from "~/server/clients/usda";
import type { Database } from "~/server/db";
import { ENTITY_BINDINGS } from "~/server/entity-bindings";
import {
  createExpense,
  deleteExpensesWithPurchaseEffects,
  expenseList,
  getExpenseByShortcode,
  updateExpense,
} from "~/server/repo/expense";
import { EXPENSE_DELETE_EDGE_POLICY } from "~/server/repo/expense/crud";
import {
  createFinancialAccount,
  deleteFinancialAccounts,
  FINANCIAL_ACCOUNT_DELETE_EDGE_POLICY,
  getFinancialAccountByShortcode,
  listFinancialAccounts,
  updateFinancialAccount,
} from "~/server/repo/financial-account";
import {
  createFinancialTransaction,
  deleteFinancialTransactions,
  FINANCIAL_TRANSACTION_DELETE_EDGE_POLICY,
  getFinancialTransactionByShortcode,
  listFinancialTransactions,
  updateFinancialTransaction,
} from "~/server/repo/financial-transaction";
import {
  deleteImages,
  getImageById,
  IMAGE_HARD_DELETE,
  imageList,
  updateImage,
} from "~/server/repo/image";
import {
  createIngredient,
  deleteIngredients,
  getIngredientByID,
  ingredientList,
  mergeIngredients,
  updateIngredient,
} from "~/server/repo/ingredient";
import { INGREDIENT_DELETE_EDGE_POLICY } from "~/server/repo/ingredient/deletion";
import { INGREDIENT_MERGE_EDGE_POLICY } from "~/server/repo/ingredient/merge";
import {
  checkUniqueProductDuplicate,
  createInventoryEntry,
  deleteInventoryEntries,
  getInventoryEntryByShortcode,
  inventoryentryList,
  updateInventoryEntry,
} from "~/server/repo/inventory";
import { INVENTORY_DELETE_EDGE_POLICY } from "~/server/repo/inventory/crud";
import {
  createLedgerParty,
  deleteLedgerParties,
  getLedgerPartyByShortcode,
  LEDGER_PARTY_DELETE_EDGE_POLICY,
  LEDGER_PARTY_MERGE_EDGE_POLICY,
  listLedgerParties,
  mergeLedgerParties,
  updateLedgerParty,
} from "~/server/repo/ledger-party";
import {
  createLedgerTransfer,
  deleteLedgerTransfers,
  getLedgerTransferByShortcode,
  LEDGER_TRANSFER_DELETE_EDGE_POLICY,
  listLedgerTransfers,
  updateLedgerTransfer,
} from "~/server/repo/ledger-transfer";
import {
  createLocation,
  deleteLocations,
  getLocationById,
  getLocationByShortcode,
  locationList,
  updateLocation,
  updateLocationAiDescription,
} from "~/server/repo/location";
import { LOCATION_DELETE_EDGE_POLICY } from "~/server/repo/location/crud";
import {
  createMealWithEntityId,
  deleteMeals,
  getMealByShortcode,
  mealList,
  updateMeal,
} from "~/server/repo/meal";
import { MEAL_DELETE_EDGE_POLICY } from "~/server/repo/meal/crud";
import {
  deleteProducts,
  getProductByID,
  getProductByShortcode,
  getProductsByShortcodes,
  mergeProducts,
  productList,
} from "~/server/repo/product";
import { PRODUCT_DELETE_EDGE_POLICY } from "~/server/repo/product/edge-roles";
import { PRODUCT_MERGE_EDGE_POLICY } from "~/server/repo/product/merge";
import {
  createProject,
  deleteProjects,
  getProjectByShortcode,
  projectList,
  updateProject,
} from "~/server/repo/project";
import { PROJECT_DELETE_EDGE_POLICY } from "~/server/repo/project/crud";
import {
  createPurchase,
  deletePurchases,
  getPurchaseByShortcode,
  mergePurchases,
  PURCHASE_DELETE_EDGE_POLICY,
  PURCHASE_MERGE_EDGE_POLICY,
  purchaseList,
  updatePurchase,
} from "~/server/repo/purchase";
import {
  createRecipe,
  deleteRecipes,
  getRecipeByShortcode,
  recipeList,
  updateRecipe,
} from "~/server/repo/recipe";
import { RECIPE_DELETE_EDGE_POLICY } from "~/server/repo/recipe/crud";
import { findParentRecipeIdsBatch } from "~/server/repo/recipe/totals";
import {
  bindShortcodeResolver,
  resolveLiveShortcode,
  resolveLiveShortcodes,
} from "~/server/repo/shortcode-resolver";
import {
  createTask,
  deleteTasks,
  getTaskByShortcode,
  taskList,
  updateTask,
} from "~/server/repo/task";
import { TASK_DELETE_EDGE_POLICY } from "~/server/repo/task/crud";
import {
  createVendor,
  deleteVendors,
  getVendorByShortcode,
  mergeVendors,
  updateVendor,
  VENDOR_DELETE_EDGE_POLICY,
  VENDOR_MERGE_EDGE_POLICY,
  vendorList,
} from "~/server/repo/vendor";
import {
  createWish,
  deleteWishes,
  getWishByShortcode,
  updateWish,
  WISH_DELETE_EDGE_POLICY,
  wishList,
} from "~/server/repo/wish";
import { recomputeRecipesForPriceAffectedProducts } from "~/server/services/expense-pricing.service";
import type { LocationValuationService } from "~/server/services/location-valuation.service";
import {
  runMutationSideEffects,
  runMutationSideEffectsForEntities,
} from "~/server/services/mutation-side-effects";
import { createProductWriteActions } from "~/server/services/product.service";
import {
  createProductWithSideEffects,
  updateProductWithSideEffects,
} from "~/server/services/product-orchestration.service";
import type { RecipeCostingService } from "~/server/services/recipe-costing.service";
import type { EntityKernelEntity } from "./contracts";

export interface EntityKernelContext {
  db: Database;
  actorContext: ActorContext;
  usdaClient: USDAClient;
  upcLookupClient: UPCLookupClient;
  services: {
    recipeCosting: RecipeCostingService;
    locationValuation: LocationValuationService;
  };
}

interface DeleteResult {
  deleted: number;
  detachedImageKeys?: string[];
  backgroundBatches?: BackgroundBatchRef[];
  affectedEdges?: Array<{
    edge: string;
    effect: OperationDisposition["effect"];
    changed: number;
  }>;
}

export interface EntityKernelBinding {
  entity: EntityKernelEntity;
  sideEffects: boolean;
  schemas: {
    id: ZodSchema;
    create?: ZodSchema;
    update?: ZodSchema;
    output: ZodSchema;
    list: ZodSchema;
    filters: ZodSchema;
  };
  sort: {
    fields: readonly [string, ...string[]];
    default: string;
    groupable?: readonly [string, ...string[]];
  };
  lifecycle: {
    delete: Record<string, OperationDisposition>;
    merge?: Record<string, OperationDisposition>;
  };
  repository: {
    get: (ctx: EntityKernelContext, id: unknown) => Promise<unknown | null>;
    list: (
      ctx: EntityKernelContext,
      filters: unknown,
      sorts: SortParams[],
      pagination: PaginationParams,
      groupBy?: string,
    ) => Promise<{
      data: unknown[];
      count: number;
      sums?: Record<string, number>;
    }>;
    create?: (
      ctx: EntityKernelContext,
      data: unknown,
    ) => Promise<{
      output: unknown;
      entityId: unknown;
      detachedImageKeys?: string[];
      backgroundBatches?: BackgroundBatchRef[];
    }>;
    update?: (
      ctx: EntityKernelContext,
      id: unknown,
      data: unknown,
    ) => Promise<{
      output: unknown;
      entityId: unknown;
      detachedImageKeys?: string[];
      backgroundBatches?: BackgroundBatchRef[];
    }>;
    delete: (ctx: EntityKernelContext, ids: unknown[]) => Promise<DeleteResult>;
  };
  merge?: {
    input: ZodSchema;
    output: ZodSchema;
    item: (output: unknown) => unknown;
    summary: (output: unknown) => unknown;
    execute: (
      ctx: EntityKernelContext,
      input: unknown,
    ) => Promise<{
      output: unknown;
      entityId: unknown | null;
      detachedImageKeys: string[];
      backgroundBatches?: BackgroundBatchRef[];
    }>;
  };
}

type CrudFor<E extends EntityKernelEntity> = NonNullable<
  (typeof ENTITY_BINDINGS)[E]["crud"]
>;

function defineBinding<
  const E extends EntityKernelEntity,
  SFilters extends ZodSchema,
>(config: {
  entity: E;
  sideEffects?: boolean;
  filters: SFilters;
  listOutput?: ZodSchema;
  sort: EntityKernelBinding["sort"];
  lifecycle: EntityKernelBinding["lifecycle"];
  repository: {
    get: (
      ctx: EntityKernelContext,
      id: z.output<CrudFor<E>["idSchema"]>,
    ) => Promise<z.output<CrudFor<E>["output"]> | null>;
    list: (
      ctx: EntityKernelContext,
      filters: z.output<SFilters>,
      sorts: SortParams[],
      pagination: PaginationParams,
      groupBy?: string,
    ) => Promise<{
      data: unknown[];
      count: number;
      sums?: Record<string, number>;
    }>;
    create: (
      ctx: EntityKernelContext,
      data: z.output<CrudFor<E>["createInput"]>,
    ) => Promise<{
      output: z.output<CrudFor<E>["output"]>;
      entityId: unknown;
      detachedImageKeys?: string[];
    }>;
    update: (
      ctx: EntityKernelContext,
      id: z.output<CrudFor<E>["idSchema"]>,
      data: z.output<CrudFor<E>["updateInput"]>,
    ) => Promise<{
      output: z.output<CrudFor<E>["output"]>;
      entityId: unknown;
      detachedImageKeys?: string[];
    }>;
    delete: (
      ctx: EntityKernelContext,
      ids: z.output<CrudFor<E>["idSchema"]>[],
    ) => Promise<DeleteResult>;
  };
  merge?: EntityKernelBinding["merge"];
}) {
  const crud = ENTITY_BINDINGS[config.entity].crud as CrudFor<E>;
  return {
    ...config,
    sideEffects: config.sideEffects ?? true,
    schemas: {
      id: crud.idSchema,
      create: crud.createInput,
      update: crud.updateInput,
      output: crud.output,
      list: config.listOutput ?? crud.output,
      filters: config.filters,
    },
  };
}

async function linkedProductIngredientIds(db: Database, shortcodes: string[]) {
  const products = await getProductsByShortcodes(db, shortcodes);
  const resolved = await resolveLiveShortcodes(
    db,
    products.flatMap((row) => (row.ingredient ? [row.ingredient.id] : [])),
    "ingredient",
  );
  return [...resolved.values()].map(unsafeIngredientId);
}

export const ENTITY_KERNEL_BINDINGS = {
  product: defineBinding({
    entity: "product",
    // Product orchestration already owns its side-effect wave: it couples the
    // enriched write, UPC image import, and recipe-cost recompute. Do not run
    // the generic wave a second time after that transaction has committed.
    sideEffects: false,
    filters: productFiltersSchema,
    listOutput: productListItemOut,
    sort: {
      fields: productSortableFields,
      default: "createdAt",
      groupable: ["category"],
    },
    lifecycle: {
      delete: PRODUCT_DELETE_EDGE_POLICY,
      merge: PRODUCT_MERGE_EDGE_POLICY,
    },
    repository: {
      get: (ctx, id) => getProductByShortcode(ctx.db, id),
      list: (ctx, filters, sorts, pagination, groupBy) =>
        productList(ctx.db, filters, sorts, pagination, groupBy),
      create: async (ctx, data) => {
        const result = await createProductWithSideEffects(
          {
            db: ctx.db,
            product: createProductWriteActions(ctx.db, ctx.usdaClient),
            recipeCosting: ctx.services.recipeCosting,
            locationValuation: ctx.services.locationValuation,
            upcLookupClient: ctx.upcLookupClient,
          },
          data,
          ctx.actorContext,
        );
        const entityId = await productShortcodes.one(ctx.db, result.id);
        return {
          output: result,
          entityId,
          backgroundBatches: result.sideEffects.backgroundBatches,
        };
      },
      update: async (ctx, shortcode, data) => {
        const entityId = await productShortcodes.one(ctx.db, shortcode);
        const result = await updateProductWithSideEffects(
          {
            db: ctx.db,
            product: createProductWriteActions(ctx.db, ctx.usdaClient),
            recipeCosting: ctx.services.recipeCosting,
            locationValuation: ctx.services.locationValuation,
          },
          entityId,
          data,
          ctx.actorContext,
        );
        return {
          output: result,
          entityId,
          backgroundBatches: result.sideEffects.backgroundBatches,
        };
      },
      delete: async (ctx, shortcodes) => {
        const ids = await productShortcodes.all(ctx.db, shortcodes);
        // Read linked ingredients before the soft delete removes the only
        // cost input path. The same pre-delete ordering backs product.delete.
        const ingredientIds = (
          await Promise.all(ids.map((id) => getProductByID(ctx.db, id)))
        ).flatMap((product) => product.ingredient?.id ?? []);
        const resolvedIngredientIds = await Promise.all(
          ingredientIds.map(
            async (shortcode) =>
              await ingredientShortcodes.one(ctx.db, shortcode),
          ),
        );
        const { deleted, detachedImageKeys } = await deleteProducts(
          ctx.db,
          ids,
          ctx.actorContext,
        );
        const [backgroundBatches, recipeBatches] = await Promise.all([
          runMutationSideEffectsForEntities(
            ctx.db,
            ids.map((entityId) => ({
              action: "deleted" as const,
              entity: { entityType: "product" as const, entityId },
              source: "product.delete",
            })),
          ),
          ctx.services.recipeCosting.recomputeForIngredients(
            resolvedIngredientIds,
            { source: "product.delete" },
          ),
        ]);
        return {
          deleted,
          detachedImageKeys,
          backgroundBatches: [...backgroundBatches, ...recipeBatches],
        };
      },
    },
    merge: {
      input: mergeProductsInput,
      output: z.object({
        product: ENTITY_BINDINGS.product.crud!.output,
        mergeSummary: productMergeSummaryOut,
      }),
      item: (output) => (output as { product: unknown }).product,
      summary: (output) => (output as { mergeSummary: unknown }).mergeSummary,
      execute: async (ctx, value) => {
        const input = mergeProductsInput.parse(value);
        const ingredientIds = await linkedProductIngredientIds(ctx.db, [
          input.keepId,
          ...input.mergeIds,
        ]);
        const summary = await mergeProducts(ctx.db, input, ctx.actorContext);
        const backgroundBatches = [
          ...(await runMutationSideEffectsForEntities(ctx.db, [
            {
              action: "updated" as const,
              entity: {
                entityType: "product" as const,
                entityId: summary.keepEntityId,
              },
              source: "product.merge",
            },
            ...summary.deletedEntityIds.map((entityId) => ({
              action: "deleted" as const,
              entity: { entityType: "product" as const, entityId },
              source: "product.merge",
            })),
          ])),
          ...(await ctx.services.recipeCosting.recomputeForIngredients(
            ingredientIds,
            {
              source: "product.merge",
              entity: {
                entityType: "product",
                entityId: summary.keepEntityId,
              },
            },
          )),
        ];
        const product = await getProductByShortcode(ctx.db, input.keepId);
        if (!product) throw new Error("Merged Product keeper disappeared");
        return {
          output: {
            product,
            mergeSummary: productMergeSummaryOut.parse(summary),
          },
          entityId: summary.keepEntityId,
          detachedImageKeys: [],
          backgroundBatches,
        };
      },
    },
  }),
  location: defineBinding({
    entity: "location",
    // Location image changes gate AI work, so the event must carry the exact
    // write payload rather than using the kernel's context-free default.
    sideEffects: false,
    filters: locationFiltersSchema,
    listOutput: locationListItemOut,
    sort: {
      fields: locationSortableFields,
      default: "createdAt",
      groupable: ["type"],
    },
    lifecycle: { delete: LOCATION_DELETE_EDGE_POLICY },
    repository: {
      get: (ctx, id) => getLocationByShortcode(ctx.db, id),
      list: (ctx, filters, sorts, pagination, groupBy) =>
        locationList(ctx.db, filters, sorts, pagination, groupBy),
      create: async (ctx, data) => {
        const output = await createLocation(ctx.db, data, ctx.actorContext);
        const entityId = await locationShortcodes.one(ctx.db, output.id);
        const backgroundBatches = await runMutationSideEffects(ctx.db, {
          action: "created",
          entity: { entityType: "location", entityId },
          source: "location.create",
          locationImagesChanged: (data.pendingImageIds?.length ?? 0) > 0,
        });
        return { output, entityId, backgroundBatches };
      },
      update: async (ctx, shortcode, data) => {
        const entityId = await locationShortcodes.one(ctx.db, shortcode);
        const imagesChanged =
          (data.pendingImageIds?.length ?? 0) > 0 ||
          (data.removeImageIds?.length ?? 0) > 0;
        const { location: updated, detachedImageKeys } = await updateLocation(
          ctx.db,
          entityId,
          data,
          ctx.actorContext,
        );
        const backgroundBatches = await runMutationSideEffects(ctx.db, {
          action: "updated",
          entity: { entityType: "location", entityId },
          source: "location.update",
          locationImagesChanged: imagesChanged,
        });
        if (!imagesChanged) {
          return {
            output: updated,
            entityId,
            detachedImageKeys,
            backgroundBatches,
          };
        }
        if (updated.images.length === 0) {
          await updateLocationAiDescription(ctx.db, entityId, null);
        }
        return {
          output: await getLocationById(ctx.db, entityId),
          entityId,
          detachedImageKeys,
          backgroundBatches,
        };
      },
      delete: async (ctx, shortcodes) => {
        const ids = await locationShortcodes.all(ctx.db, shortcodes);
        const { deleted, detachedImageKeys } = await deleteLocations(
          ctx.db,
          ids,
          ctx.actorContext,
        );
        const backgroundBatches = await runMutationSideEffectsForEntities(
          ctx.db,
          ids.map((entityId) => ({
            action: "deleted" as const,
            entity: { entityType: "location" as const, entityId },
            source: "location.delete",
          })),
        );
        return { deleted, detachedImageKeys, backgroundBatches };
      },
    },
  }),
  inventory: defineBinding({
    entity: "inventory",
    filters: inventoryFiltersSchema,
    listOutput: inventoryListItemOut,
    sort: { fields: inventorySortableFields, default: "createdAt" },
    lifecycle: { delete: INVENTORY_DELETE_EDGE_POLICY },
    repository: {
      get: (ctx, id) => getInventoryEntryByShortcode(ctx.db, id),
      list: (ctx, filters, sorts, pagination) =>
        inventoryentryList(ctx.db, filters, sorts, pagination),
      create: async (ctx, data) => {
        const [productId, locationId] = await Promise.all([
          productShortcodes.one(ctx.db, data.productId),
          locationShortcodes.one(ctx.db, data.locationId),
        ]);
        const duplicate = await checkUniqueProductDuplicate(
          ctx.db,
          productId,
          locationId,
        );
        if (duplicate) {
          throw new Error(
            `Unique product ${duplicate.productName} is already inventoried at ${duplicate.locationName}`,
          );
        }
        const output = await createInventoryEntry(
          ctx.db,
          { ...data, productId, locationId },
          ctx.actorContext,
        );
        return {
          output,
          entityId: await inventoryShortcodes.one(ctx.db, output.id),
        };
      },
      update: async (ctx, shortcode, data) => {
        const entityId = await inventoryShortcodes.one(ctx.db, shortcode);
        const [productId, locationId] = await Promise.all([
          data.productId
            ? productShortcodes.one(ctx.db, data.productId)
            : undefined,
          data.locationId
            ? locationShortcodes.one(ctx.db, data.locationId)
            : undefined,
        ]);
        return {
          output: await updateInventoryEntry(
            ctx.db,
            entityId,
            { ...data, productId, locationId },
            ctx.actorContext,
          ),
          entityId,
        };
      },
      delete: async (ctx, shortcodes) => {
        const ids = await inventoryShortcodes.all(ctx.db, shortcodes);
        const { deleted } = await deleteInventoryEntries(
          ctx.db,
          ids,
          ctx.actorContext,
        );
        const backgroundBatches = await runMutationSideEffectsForEntities(
          ctx.db,
          ids.map((entityId) => ({
            action: "deleted" as const,
            entity: { entityType: "inventory" as const, entityId },
            source: "inventory.delete",
          })),
        );
        return { deleted, backgroundBatches };
      },
    },
  }),
  ingredient: defineBinding({
    entity: "ingredient",
    filters: ingredientFiltersSchema,
    listOutput: ingredientListItemOut,
    sort: { fields: ingredientSortableFields, default: "createdAt" },
    lifecycle: {
      delete: INGREDIENT_DELETE_EDGE_POLICY,
      merge: INGREDIENT_MERGE_EDGE_POLICY,
    },
    repository: {
      get: async (ctx, shortcode) =>
        getIngredientByID(
          ctx.db,
          await ingredientShortcodes.one(ctx.db, shortcode),
        ),
      list: (ctx, filters, sorts, pagination) =>
        ingredientList(ctx.db, filters, sorts, pagination),
      create: async (ctx, data) => {
        const output = await createIngredient(ctx.db, data, ctx.actorContext);
        return {
          output,
          entityId: await ingredientShortcodes.one(ctx.db, output.id),
        };
      },
      update: async (ctx, shortcode, data) => {
        const entityId = await ingredientShortcodes.one(ctx.db, shortcode);
        const output = await updateIngredient(
          ctx.db,
          entityId,
          data,
          ctx.actorContext,
        );
        const backgroundBatches =
          await ctx.services.recipeCosting.recomputeForIngredient(entityId, {
            source: "ingredient.update",
            entity: { entityType: "ingredient", entityId },
          });
        return { output, entityId, backgroundBatches };
      },
      delete: async (ctx, shortcodes) => {
        const ids = await ingredientShortcodes.all(ctx.db, shortcodes);
        const { deleted } = await deleteIngredients(
          ctx.db,
          ids,
          ctx.actorContext,
        );
        const backgroundBatches = await runMutationSideEffectsForEntities(
          ctx.db,
          ids.map((entityId) => ({
            action: "deleted" as const,
            entity: { entityType: "ingredient" as const, entityId },
            source: "ingredient.delete",
          })),
        );
        return { deleted, backgroundBatches };
      },
    },
    merge: {
      input: ingredientMergeInput,
      output: z.object({
        ingredient: ENTITY_BINDINGS.ingredient.crud!.output,
        mergeSummary: ingredientMergeSummary,
      }),
      item: (output) => (output as { ingredient: unknown }).ingredient,
      summary: (output) => (output as { mergeSummary: unknown }).mergeSummary,
      execute: async (ctx, value) => {
        const input = ingredientMergeInput.parse(value);
        const summary = await mergeIngredients(ctx.db, input, ctx.actorContext);
        const entityId = await ingredientShortcodes.one(ctx.db, input.keepId);
        const backgroundBatches = [
          ...(await ctx.services.recipeCosting.dispatchRecompute(
            summary.affectedRecipeIds,
            {
              source: "ingredient.merge",
              entity: { entityType: "ingredient", entityId },
            },
          )),
          ...(await runMutationSideEffectsForEntities(
            ctx.db,
            summary.deletedEntityIds.map((deletedEntityId) => ({
              action: "deleted" as const,
              entity: {
                entityType: "ingredient" as const,
                entityId: deletedEntityId,
              },
              source: "ingredient.merge",
            })),
          )),
        ];
        return {
          output: {
            ingredient: await getIngredientByID(ctx.db, entityId),
            mergeSummary: ingredientMergeSummary.parse(summary),
          },
          entityId,
          detachedImageKeys: [],
          backgroundBatches,
        };
      },
    },
  }),
  recipe: defineBinding({
    entity: "recipe",
    filters: recipeFiltersSchema,
    listOutput: recipeListItemOut,
    sort: {
      fields: recipeSortableFields,
      default: "createdAt",
      groupable: ["name"],
    },
    lifecycle: { delete: RECIPE_DELETE_EDGE_POLICY },
    repository: {
      get: (ctx, id) => getRecipeByShortcode(ctx.db, id),
      list: (ctx, filters, sorts, pagination) =>
        recipeList(ctx.db, filters, sorts, pagination),
      create: async (ctx, data) => {
        const output = await createRecipe(ctx.db, data, ctx.actorContext);
        const entityId = await recipeShortcodes.one(ctx.db, output.id);
        const backgroundBatches =
          await ctx.services.recipeCosting.dispatchRecompute([entityId], {
            source: "recipe.create",
            entity: { entityType: "recipe", entityId },
          });
        return { output, entityId, backgroundBatches };
      },
      update: async (ctx, shortcode, data) => {
        const entityId = await recipeShortcodes.one(ctx.db, shortcode);
        const { recipe: output, detachedImageKeys } = await updateRecipe(
          ctx.db,
          entityId,
          data,
          ctx.actorContext,
        );
        const backgroundBatches =
          await ctx.services.recipeCosting.dispatchRecompute([entityId], {
            source: "recipe.update",
            entity: { entityType: "recipe", entityId },
          });
        return { output, entityId, detachedImageKeys, backgroundBatches };
      },
      delete: async (ctx, shortcodes) => {
        const ids = await recipeShortcodes.all(ctx.db, shortcodes);
        const deletedSet = new Set(ids);
        const parentsByRecipe = await findParentRecipeIdsBatch(ctx.db, ids);
        const parentIds = [
          ...new Set(
            [...parentsByRecipe.values()]
              .flat()
              .filter((id) => !deletedSet.has(id)),
          ),
        ];
        const { deleted, detachedImageKeys } = await deleteRecipes(
          ctx.db,
          ids,
          ctx.actorContext,
        );
        const [backgroundBatches, recipeBatches] = await Promise.all([
          runMutationSideEffectsForEntities(
            ctx.db,
            ids.map((entityId) => ({
              action: "deleted" as const,
              entity: { entityType: "recipe" as const, entityId },
              source: "recipe.delete",
            })),
          ),
          parentIds.length > 0
            ? ctx.services.recipeCosting.dispatchRecompute(parentIds, {
                source: "recipe.delete",
              })
            : Promise.resolve([]),
        ]);
        return {
          deleted,
          detachedImageKeys,
          backgroundBatches: [...backgroundBatches, ...recipeBatches],
        };
      },
    },
  }),
  image: {
    entity: "image",
    sideEffects: false,
    schemas: {
      id: imageShortcode,
      update: imageUpdateInput,
      output: imageWithEntitySchema,
      list: imageWithEntitySchema,
      filters: imageListFiltersSchema,
    },
    sort: { fields: imageSortableFields, default: "createdAt" },
    lifecycle: { delete: IMAGE_HARD_DELETE },
    repository: {
      get: async (ctx, shortcode) =>
        getImageById(
          ctx.db,
          await imageShortcodes.one(ctx.db, shortcode as string),
        ),
      list: (ctx, filters, sorts, pagination) =>
        imageList(
          ctx.db,
          imageListFiltersSchema.parse(filters),
          sorts,
          pagination,
        ),
      update: async (ctx, shortcode, data) => {
        const entityId = await imageShortcodes.one(ctx.db, shortcode as string);
        return {
          output: await updateImage(
            ctx.db,
            entityId,
            imageUpdateInput.parse(data),
          ),
          entityId,
        };
      },
      delete: async (ctx, shortcodes) => {
        const ids = await imageShortcodes.all(ctx.db, shortcodes as string[]);
        const { deletedIds, deletedKeys } = await deleteImages(ctx.db, ids);
        return {
          deleted: deletedIds.length,
          detachedImageKeys: deletedKeys,
        };
      },
    },
  } as EntityKernelBinding,
  expense: defineBinding({
    entity: "expense",
    filters: expenseFiltersSchema,
    sort: {
      fields: expenseSortableFields,
      default: "date",
      groupable: ["costType"],
    },
    lifecycle: { delete: EXPENSE_DELETE_EDGE_POLICY },
    repository: {
      get: (ctx, id) => getExpenseByShortcode(ctx.db, id),
      list: (ctx, filters, sorts, pagination) =>
        expenseList(ctx.db, filters, sorts, pagination),
      create: async (ctx, data) => {
        const result = await createExpense(ctx.db, data, ctx.actorContext);
        await recomputeRecipesForPriceAffectedProducts(
          ctx.db,
          ctx.services.recipeCosting,
          result.priceAffectedProductIds,
          "expense.create",
        );
        return result;
      },
      update: async (ctx, id, data) => {
        const result = await updateExpense(ctx.db, id, data, ctx.actorContext);
        await recomputeRecipesForPriceAffectedProducts(
          ctx.db,
          ctx.services.recipeCosting,
          result.priceAffectedProductIds,
          "expense.update",
        );
        return result;
      },
      delete: async (ctx, ids) => {
        const { priceAffectedProductIds, result } =
          await deleteExpensesWithPurchaseEffects(
            ctx.db,
            ids,
            ctx.actorContext,
          );
        const backgroundBatches =
          await recomputeRecipesForPriceAffectedProducts(
            ctx.db,
            ctx.services.recipeCosting,
            priceAffectedProductIds,
            "expense.delete",
          );
        return { deleted: result.deleted, backgroundBatches };
      },
    },
  }),
  financialAccount: defineBinding({
    entity: "financialAccount",
    filters: financialAccountFiltersSchema,
    sort: { fields: financialAccountSortableFields, default: "name" },
    lifecycle: { delete: FINANCIAL_ACCOUNT_DELETE_EDGE_POLICY },
    repository: {
      get: (ctx, id) => getFinancialAccountByShortcode(ctx.db, id),
      list: (ctx, filters, sorts, pagination) =>
        listFinancialAccounts(ctx.db, filters, sorts, pagination),
      create: (ctx, data) =>
        createFinancialAccount(ctx.db, data, ctx.actorContext),
      update: (ctx, id, data) =>
        updateFinancialAccount(ctx.db, id, data, ctx.actorContext),
      delete: (ctx, ids) =>
        deleteFinancialAccounts(ctx.db, ids, ctx.actorContext),
    },
  }),
  financialTransaction: defineBinding({
    entity: "financialTransaction",
    filters: financialTransactionFiltersSchema,
    sort: {
      fields: financialTransactionSortableFields,
      default: "transactionDate",
    },
    lifecycle: { delete: FINANCIAL_TRANSACTION_DELETE_EDGE_POLICY },
    repository: {
      get: (ctx, id) => getFinancialTransactionByShortcode(ctx.db, id),
      list: (ctx, filters, sorts, pagination) =>
        listFinancialTransactions(ctx.db, filters, sorts, pagination),
      create: (ctx, data) =>
        createFinancialTransaction(ctx.db, data, ctx.actorContext),
      update: (ctx, id, data) =>
        updateFinancialTransaction(ctx.db, id, data, ctx.actorContext),
      delete: (ctx, ids) =>
        deleteFinancialTransactions(ctx.db, ids, ctx.actorContext),
    },
  }),
  ledgerParty: defineBinding({
    entity: "ledgerParty",
    sideEffects: false,
    filters: ledgerPartyFiltersSchema,
    sort: { fields: ledgerPartySortableFields, default: "name" },
    lifecycle: {
      delete: LEDGER_PARTY_DELETE_EDGE_POLICY,
      merge: LEDGER_PARTY_MERGE_EDGE_POLICY,
    },
    repository: {
      get: (ctx, id) => getLedgerPartyByShortcode(ctx.db, id),
      list: (ctx, filters, sorts, pagination) =>
        listLedgerParties(ctx.db, filters, sorts, pagination),
      create: (ctx, data) => createLedgerParty(ctx.db, data, ctx.actorContext),
      update: (ctx, id, data) =>
        updateLedgerParty(ctx.db, id, data, ctx.actorContext),
      delete: (ctx, ids) => deleteLedgerParties(ctx.db, ids, ctx.actorContext),
    },
    merge: {
      input: z.object({
        keepId: ENTITY_BINDINGS.ledgerParty.crud!.idSchema,
        mergeIds: z.array(ENTITY_BINDINGS.ledgerParty.crud!.idSchema).min(1),
      }),
      output: z.object({
        ledgerParty: ledgerPartyOut,
        mergeSummary: z.unknown(),
      }),
      item: (output) => (output as { ledgerParty: unknown }).ledgerParty,
      summary: (output) => (output as { mergeSummary: unknown }).mergeSummary,
      execute: async (ctx, value) => {
        const input = z
          .object({
            keepId: ENTITY_BINDINGS.ledgerParty.crud!.idSchema,
            mergeIds: z
              .array(ENTITY_BINDINGS.ledgerParty.crud!.idSchema)
              .min(1),
          })
          .parse(value);
        const { mergeSummary } = await mergeLedgerParties(
          ctx.db,
          input,
          ctx.actorContext,
        );
        const ledgerParty = await getLedgerPartyByShortcode(
          ctx.db,
          input.keepId,
        );
        if (!ledgerParty)
          throw new Error("Merged Ledger Party keeper disappeared");
        return {
          output: { ledgerParty, mergeSummary },
          entityId: null,
          detachedImageKeys: [],
        };
      },
    },
  }),
  ledgerTransfer: defineBinding({
    entity: "ledgerTransfer",
    sideEffects: false,
    filters: ledgerTransferFiltersSchema,
    sort: { fields: ledgerTransferSortableFields, default: "date" },
    lifecycle: { delete: LEDGER_TRANSFER_DELETE_EDGE_POLICY },
    repository: {
      get: (ctx, id) => getLedgerTransferByShortcode(ctx.db, id),
      list: (ctx, filters, sorts, pagination) =>
        listLedgerTransfers(ctx.db, filters, sorts, pagination),
      create: (ctx, data) =>
        createLedgerTransfer(ctx.db, data, ctx.actorContext),
      update: (ctx, id, data) =>
        updateLedgerTransfer(ctx.db, id, data, ctx.actorContext),
      delete: (ctx, ids) =>
        deleteLedgerTransfers(ctx.db, ids, ctx.actorContext),
    },
  }),
  meal: defineBinding({
    entity: "meal",
    filters: mealFiltersSchema,
    sort: { fields: mealSortableFields, default: "date" },
    lifecycle: { delete: MEAL_DELETE_EDGE_POLICY },
    repository: {
      get: (ctx, id) => getMealByShortcode(ctx.db, id),
      list: (ctx, filters, sorts, pagination) =>
        mealList(ctx.db, filters, sorts, pagination),
      create: (ctx, data) =>
        createMealWithEntityId(ctx.db, data, ctx.actorContext),
      update: async (ctx, id, data) => {
        const entityId = await mealShortcodes.one(ctx.db, id);
        const output = await updateMeal(
          ctx.db,
          entityId,
          data,
          ctx.actorContext,
        );
        return { output, entityId };
      },
      delete: async (ctx, ids) =>
        deleteMeals(
          ctx.db,
          await mealShortcodes.all(ctx.db, ids),
          ctx.actorContext,
        ),
    },
  }),
  project: defineBinding({
    entity: "project",
    filters: projectFiltersSchema,
    sort: { fields: projectSortableFields, default: "createdAt" },
    lifecycle: { delete: PROJECT_DELETE_EDGE_POLICY },
    repository: {
      get: (ctx, id) => getProjectByShortcode(ctx.db, id),
      list: (ctx, filters, sorts, pagination) =>
        projectList(ctx.db, filters, sorts, pagination),
      create: (ctx, data) => createProject(ctx.db, data, ctx.actorContext),
      update: (ctx, id, data) =>
        updateProject(ctx.db, id, data, ctx.actorContext),
      delete: (ctx, ids) => deleteProjects(ctx.db, ids, ctx.actorContext),
    },
  }),
  purchase: defineBinding({
    entity: "purchase",
    filters: purchaseFiltersSchema,
    sort: { fields: purchaseSortableFields, default: "date" },
    lifecycle: {
      delete: PURCHASE_DELETE_EDGE_POLICY,
      merge: PURCHASE_MERGE_EDGE_POLICY,
    },
    repository: {
      get: (ctx, id) => getPurchaseByShortcode(ctx.db, id),
      list: (ctx, filters, sorts, pagination) =>
        purchaseList(ctx.db, filters, sorts, pagination),
      create: (ctx, data) => createPurchase(ctx.db, data, ctx.actorContext),
      update: (ctx, id, data) =>
        updatePurchase(ctx.db, id, data, ctx.actorContext),
      delete: async (ctx, ids) => {
        const detached = await deletePurchases(ctx.db, ids, ctx.actorContext);
        const backgroundBatches = await runMutationSideEffectsForEntities(
          ctx.db,
          [
            ...detached.expenseIds.map((entityId) => ({
              action: "updated" as const,
              entity: { entityType: "expense" as const, entityId },
              source: "purchase.delete",
            })),
            ...detached.financialTransactionIds.map((entityId) => ({
              action: "updated" as const,
              entity: {
                entityType: "financialTransaction" as const,
                entityId,
              },
              source: "purchase.delete",
            })),
          ],
        );
        return {
          deleted: detached.deleted,
          detachedImageKeys: detached.detachedImageKeys,
          backgroundBatches,
        };
      },
    },
    merge: {
      input: mergePurchasesInput,
      output: mergePurchasesOut,
      item: (output) => (output as { purchase: unknown }).purchase,
      summary: (output) => (output as { mergeSummary: unknown }).mergeSummary,
      execute: async (ctx, value) => {
        const output = await mergePurchases(
          ctx.db,
          mergePurchasesInput.parse(value),
          ctx.actorContext,
        );
        return {
          output,
          entityId: await purchaseShortcodes.one(ctx.db, output.purchase.id),
          detachedImageKeys: [],
        };
      },
    },
  }),
  task: defineBinding({
    entity: "task",
    filters: taskFiltersSchema,
    sort: {
      fields: taskSortableFields,
      default: "createdAt",
      groupable: ["status"],
    },
    lifecycle: { delete: TASK_DELETE_EDGE_POLICY },
    repository: {
      get: (ctx, id) => getTaskByShortcode(ctx.db, id),
      list: (ctx, filters, sorts, pagination) =>
        taskList(ctx.db, filters, sorts, pagination),
      create: (ctx, data) => createTask(ctx.db, data, ctx.actorContext),
      update: (ctx, id, data) => updateTask(ctx.db, id, data, ctx.actorContext),
      delete: (ctx, ids) => deleteTasks(ctx.db, ids, ctx.actorContext),
    },
  }),
  vendor: defineBinding({
    entity: "vendor",
    filters: vendorFiltersSchema,
    sort: { fields: vendorSortableFields, default: "name" },
    lifecycle: {
      delete: VENDOR_DELETE_EDGE_POLICY,
      merge: VENDOR_MERGE_EDGE_POLICY,
    },
    repository: {
      get: (ctx, id) => getVendorByShortcode(ctx.db, id),
      list: (ctx, filters, sorts, pagination) =>
        vendorList(ctx.db, filters, sorts, pagination),
      create: (ctx, data) => createVendor(ctx.db, data, ctx.actorContext),
      update: (ctx, id, data) =>
        updateVendor(ctx.db, id, data, ctx.actorContext),
      delete: (ctx, ids) => deleteVendors(ctx.db, ids, ctx.actorContext),
    },
    merge: {
      input: mergeVendorsInput,
      output: mergeVendorsOut,
      item: (output) => (output as { vendor: unknown }).vendor,
      summary: (output) => (output as { mergeSummary: unknown }).mergeSummary,
      execute: async (ctx, input) => {
        const { vendor, detachedImageKeys, mergeSummary } = await mergeVendors(
          ctx.db,
          mergeVendorsInput.parse(input),
          ctx.actorContext,
        );
        const entityId = await resolveLiveShortcode(
          ctx.db,
          vendor.id,
          "vendor",
        );
        return {
          output: { vendor, mergeSummary },
          entityId: entityId ? unsafeVendorId(entityId) : null,
          detachedImageKeys,
        };
      },
    },
  }),
  wish: defineBinding({
    entity: "wish",
    filters: wishFiltersSchema,
    sort: { fields: wishSortableFields, default: "createdAt" },
    lifecycle: { delete: WISH_DELETE_EDGE_POLICY },
    repository: {
      get: (ctx, id) => getWishByShortcode(ctx.db, id),
      list: (ctx, filters, sorts, pagination) =>
        wishList(ctx.db, filters, sorts, pagination),
      create: (ctx, data) => createWish(ctx.db, data, ctx.actorContext),
      update: (ctx, id, data) => updateWish(ctx.db, id, data, ctx.actorContext),
      delete: (ctx, ids) => deleteWishes(ctx.db, ids, ctx.actorContext),
    },
  }),
} as const satisfies Record<EntityKernelEntity, unknown>;

const productShortcodes = bindShortcodeResolver("product");
const locationShortcodes = bindShortcodeResolver("location");
const inventoryShortcodes = bindShortcodeResolver("inventory");
const ingredientShortcodes = bindShortcodeResolver("ingredient");
const recipeShortcodes = bindShortcodeResolver("recipe");
const imageShortcodes = bindShortcodeResolver("image");
const mealShortcodes = bindShortcodeResolver("meal");
const purchaseShortcodes = bindShortcodeResolver("purchase");
