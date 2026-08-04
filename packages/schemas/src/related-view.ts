import { z } from "zod";
import type { Entity } from "./entity";
import { entitySchema } from "./entity";
import type { RelationshipPathStep } from "./entity-integrity";
import {
  expenseShortcode,
  financialTransactionShortcode,
  ingredientShortcode,
  inventoryShortcode,
  mealShortcode,
  productShortcode,
  projectShortcode,
  purchaseShortcode,
  recipeShortcode,
  taskShortcode,
  vendorShortcode,
} from "./identifiers";

/**
 * Curated relationship columns which supplement (rather than duplicate) the
 * direct relation columns already owned by each entity list.
 *
 * Paths use the same edge/direction vocabulary as entityManifest. Keeping the
 * declaration in schemas makes the API contract and the UI agree on the exact
 * set of paths the server is willing to execute; SQL remains server-owned.
 */
export interface RelatedViewDefinition {
  key: string;
  source: Entity;
  target: Entity;
  label: string;
  defaultVisible: boolean;
  order: "alphabetical" | "newest" | "task";
  path: readonly RelationshipPathStep[];
  /** Override when one source has multiple curated paths to the same target. */
  filterPrefix?: string;
  /**
   * The directional key that realizes this same relationship from the other
   * endpoint.  A relation can still be one-way when its reverse is not a
   * useful list/table concept; callers must not manufacture SQL from paths.
   */
  inverseKey?: string;
}

const out = (edge: string) => ({ edge, direction: "outgoing" }) as const;
const inc = (edge: string) => ({ edge, direction: "incoming" }) as const;

export const relatedViewRegistry = [
  {
    key: "product.vendors",
    source: "product",
    target: "vendor",
    label: "Vendors",
    defaultVisible: true,
    order: "alphabetical",
    path: [
      inc("Expense.productId"),
      out("Expense.purchaseId"),
      out("Purchase.vendorId"),
    ],
    inverseKey: "vendor.products",
  },
  {
    key: "product.projects",
    source: "product",
    target: "project",
    label: "Projects",
    defaultVisible: true,
    order: "alphabetical",
    path: [inc("Expense.productId"), out("Expense.projectId")],
    inverseKey: "project.purchasedProducts",
  },
  {
    key: "product.usedOnProjects",
    source: "product",
    target: "project",
    label: "Used on projects",
    defaultVisible: true,
    order: "alphabetical",
    path: [
      inc("ProjectToolUsage.productId"),
      out("ProjectToolUsage.projectId"),
    ],
    filterPrefix: "usedOnProject",
    inverseKey: "project.usedTools",
  },
  {
    key: "product.purchases",
    source: "product",
    target: "purchase",
    label: "Purchases",
    defaultVisible: false,
    order: "newest",
    path: [inc("Expense.productId"), out("Expense.purchaseId")],
  },
  {
    key: "product.expenses",
    source: "product",
    target: "expense",
    label: "Expenses",
    defaultVisible: false,
    order: "newest",
    path: [inc("Expense.productId")],
  },
  {
    key: "product.inventory",
    source: "product",
    target: "inventory",
    label: "Inventory",
    defaultVisible: false,
    order: "newest",
    path: [inc("InventoryEntry.productId")],
    filterPrefix: "relatedInventory",
  },
  {
    key: "product.tasks",
    source: "product",
    target: "task",
    label: "Tasks",
    defaultVisible: false,
    order: "task",
    path: [inc("Task.subjectProductId")],
  },
  {
    key: "recipe.ingredients",
    source: "recipe",
    target: "ingredient",
    label: "Ingredients",
    defaultVisible: false,
    order: "alphabetical",
    path: [
      inc("RecipeSection.recipeId"),
      inc("RecipeSectionIngredient.recipeSectionId"),
      out("RecipeSectionIngredient.ingredientId"),
    ],
  },
  {
    key: "recipe.meals",
    source: "recipe",
    target: "meal",
    label: "Meals",
    defaultVisible: false,
    order: "newest",
    path: [inc("MealRecipe.recipeId"), out("MealRecipe.mealId")],
    inverseKey: "meal.recipes",
  },
  {
    key: "meal.recipes",
    source: "meal",
    target: "recipe",
    label: "Recipes",
    defaultVisible: false,
    order: "alphabetical",
    path: [inc("MealRecipe.mealId"), out("MealRecipe.recipeId")],
    inverseKey: "recipe.meals",
  },
  {
    key: "location.ingredients",
    source: "location",
    target: "ingredient",
    label: "Ingredients",
    defaultVisible: false,
    order: "alphabetical",
    path: [
      inc("InventoryEntry.locationId"),
      out("InventoryEntry.productId"),
      out("Product.ingredientId"),
    ],
  },
  {
    key: "inventory.ingredient",
    source: "inventory",
    target: "ingredient",
    label: "Ingredient",
    defaultVisible: false,
    order: "alphabetical",
    path: [out("InventoryEntry.productId"), out("Product.ingredientId")],
  },
  {
    key: "project.blockedBy",
    source: "project",
    target: "project",
    label: "Blocked by",
    defaultVisible: true,
    order: "alphabetical",
    path: [
      inc("ProjectDependency.projectId"),
      out("ProjectDependency.blockedByProjectId"),
    ],
  },
  {
    key: "project.tasks",
    source: "project",
    target: "task",
    label: "Tasks",
    defaultVisible: false,
    order: "task",
    path: [inc("Task.projectId")],
  },
  {
    key: "project.expenses",
    source: "project",
    target: "expense",
    label: "Expenses",
    defaultVisible: false,
    order: "newest",
    path: [inc("Expense.projectId")],
  },
  {
    key: "project.taskProducts",
    source: "project",
    target: "product",
    label: "Task products",
    defaultVisible: false,
    order: "alphabetical",
    path: [inc("Task.projectId"), out("Task.subjectProductId")],
    filterPrefix: "taskProduct",
  },
  {
    key: "project.purchasedProducts",
    source: "project",
    target: "product",
    label: "Purchased products",
    defaultVisible: false,
    order: "alphabetical",
    path: [inc("Expense.projectId"), out("Expense.productId")],
    filterPrefix: "purchasedProduct",
    inverseKey: "product.projects",
  },
  {
    key: "project.usedTools",
    source: "project",
    target: "product",
    label: "Reusable resources",
    defaultVisible: true,
    order: "alphabetical",
    path: [
      inc("ProjectToolUsage.projectId"),
      out("ProjectToolUsage.productId"),
    ],
    filterPrefix: "usedTool",
    inverseKey: "product.usedOnProjects",
  },
  {
    key: "project.vendors",
    source: "project",
    target: "vendor",
    label: "Vendors",
    defaultVisible: false,
    order: "alphabetical",
    path: [
      inc("Expense.projectId"),
      out("Expense.purchaseId"),
      out("Purchase.vendorId"),
    ],
    inverseKey: "vendor.projects",
  },
  {
    key: "task.blockedBy",
    source: "task",
    target: "task",
    label: "Blocked by",
    defaultVisible: true,
    order: "task",
    path: [inc("TaskDependency.taskId"), out("TaskDependency.blockedByTaskId")],
    filterPrefix: "blockedByTask",
  },
  {
    key: "task.parent",
    source: "task",
    target: "task",
    label: "Parent task",
    defaultVisible: false,
    order: "task",
    path: [out("Task.parentTaskId")],
    filterPrefix: "parentTask",
  },
  {
    key: "vendor.expenses",
    source: "vendor",
    target: "expense",
    label: "Recent expenses",
    defaultVisible: true,
    order: "newest",
    path: [inc("Purchase.vendorId"), inc("Expense.purchaseId")],
  },
  {
    key: "vendor.purchases",
    source: "vendor",
    target: "purchase",
    label: "Purchases",
    defaultVisible: false,
    order: "newest",
    path: [inc("Purchase.vendorId")],
  },
  {
    key: "vendor.products",
    source: "vendor",
    target: "product",
    label: "Products",
    defaultVisible: false,
    order: "alphabetical",
    path: [
      inc("Purchase.vendorId"),
      inc("Expense.purchaseId"),
      out("Expense.productId"),
    ],
    inverseKey: "product.vendors",
  },
  {
    key: "vendor.projects",
    source: "vendor",
    target: "project",
    label: "Projects",
    defaultVisible: false,
    order: "alphabetical",
    path: [
      inc("Purchase.vendorId"),
      inc("Expense.purchaseId"),
      out("Expense.projectId"),
    ],
    inverseKey: "project.vendors",
  },
  {
    key: "vendor.transactions",
    source: "vendor",
    target: "financialTransaction",
    label: "Financial transactions",
    defaultVisible: false,
    order: "newest",
    path: [inc("Purchase.vendorId"), inc("FinancialTransaction.purchaseId")],
  },
  {
    key: "purchase.expenses",
    source: "purchase",
    target: "expense",
    label: "Expenses",
    defaultVisible: true,
    order: "newest",
    path: [inc("Expense.purchaseId")],
  },
  {
    key: "purchase.transactions",
    source: "purchase",
    target: "financialTransaction",
    label: "Transactions",
    defaultVisible: true,
    order: "newest",
    path: [inc("FinancialTransaction.purchaseId")],
  },
  {
    key: "purchase.products",
    source: "purchase",
    target: "product",
    label: "Products",
    defaultVisible: false,
    order: "alphabetical",
    path: [inc("Expense.purchaseId"), out("Expense.productId")],
  },
  {
    key: "purchase.projects",
    source: "purchase",
    target: "project",
    label: "Projects",
    defaultVisible: false,
    order: "alphabetical",
    path: [inc("Expense.purchaseId"), out("Expense.projectId")],
  },
  {
    key: "expense.transactions",
    source: "expense",
    target: "financialTransaction",
    label: "Purchase transactions",
    defaultVisible: false,
    order: "newest",
    path: [out("Expense.purchaseId"), inc("FinancialTransaction.purchaseId")],
  },
  {
    key: "financialAccount.transactions",
    source: "financialAccount",
    target: "financialTransaction",
    label: "Transactions",
    defaultVisible: true,
    order: "newest",
    path: [inc("FinancialTransaction.accountId")],
  },
  {
    key: "financialAccount.purchases",
    source: "financialAccount",
    target: "purchase",
    label: "Purchases",
    defaultVisible: false,
    order: "newest",
    path: [
      inc("FinancialTransaction.accountId"),
      out("FinancialTransaction.purchaseId"),
    ],
  },
  {
    key: "financialAccount.vendors",
    source: "financialAccount",
    target: "vendor",
    label: "Vendors",
    defaultVisible: false,
    order: "alphabetical",
    path: [
      inc("FinancialTransaction.accountId"),
      out("FinancialTransaction.purchaseId"),
      out("Purchase.vendorId"),
    ],
  },
  {
    key: "financialTransaction.vendor",
    source: "financialTransaction",
    target: "vendor",
    label: "Vendor",
    defaultVisible: true,
    order: "alphabetical",
    path: [out("FinancialTransaction.purchaseId"), out("Purchase.vendorId")],
  },
  {
    key: "financialTransaction.expenses",
    source: "financialTransaction",
    target: "expense",
    label: "Expenses",
    defaultVisible: false,
    order: "newest",
    path: [out("FinancialTransaction.purchaseId"), inc("Expense.purchaseId")],
  },
  {
    key: "financialTransaction.products",
    source: "financialTransaction",
    target: "product",
    label: "Products",
    defaultVisible: false,
    order: "alphabetical",
    path: [
      out("FinancialTransaction.purchaseId"),
      inc("Expense.purchaseId"),
      out("Expense.productId"),
    ],
  },
] as const satisfies readonly RelatedViewDefinition[];

export const relatedViewKeys = relatedViewRegistry.map((view) => view.key) as [
  (typeof relatedViewRegistry)[number]["key"],
  ...(typeof relatedViewRegistry)[number]["key"][],
];
export const relatedViewKeySchema = z.enum(relatedViewKeys);
export type RelatedViewKey = z.infer<typeof relatedViewKeySchema>;

export const relatedPreviewInput = z.object({
  source: entitySchema,
  // Infinite tables accumulate pages. Keep one request bounded, but high
  // enough that loading a few pages never turns a successful list into a 400.
  sourceIds: z.array(z.string()).max(1000),
  relationKeys: z.array(relatedViewKeySchema).max(16),
});
export type RelatedPreviewInput = z.infer<typeof relatedPreviewInput>;

export const relatedPreviewItem = z.object({
  entity: entitySchema,
  id: z.string(),
  label: z.string(),
});
export type RelatedPreviewItem = z.infer<typeof relatedPreviewItem>;

export const relatedPreviewGroup = z.object({
  sourceId: z.string(),
  relationKey: relatedViewKeySchema,
  totalCount: z.number().int().nonnegative(),
  items: z.array(relatedPreviewItem).max(3),
});
export type RelatedPreviewGroup = z.infer<typeof relatedPreviewGroup>;

export const relatedPreviewOutput = z.array(relatedPreviewGroup);

/** A page of full related records for the detail-page outline tree. */
export const relatedBranchInput = z.object({
  relationKey: relatedViewKeySchema,
  sourceId: z.string().min(1),
  offset: z.number().int().nonnegative().default(0),
  limit: z.number().int().min(1).max(100).default(25),
});
export type RelatedBranchInput = z.infer<typeof relatedBranchInput>;

export const relatedBranchOutput = z.object({
  sourceId: z.string(),
  relationKey: relatedViewKeySchema,
  totalCount: z.number().int().nonnegative(),
  items: z.array(relatedPreviewItem),
  nextOffset: z.number().int().nonnegative().nullable(),
});

/** Expense-backed aggregates for the purchasing provenance mini tables. */
export const relatedSummaryRelationKeys = [
  "vendor.products",
  "vendor.projects",
  "purchase.projects",
  "project.vendors",
  "project.purchasedProducts",
  "product.vendors",
] as const;
export const relatedSummaryRelationKeySchema = z.enum(
  relatedSummaryRelationKeys,
);
export type RelatedSummaryRelationKey = z.infer<
  typeof relatedSummaryRelationKeySchema
>;

export const relatedSummarySortFieldSchema = z.enum([
  "target",
  "latestActivity",
  "netSpend",
  "purchaseCount",
  "expenseCount",
  "knownAcquiredUnits",
]);

export const relatedSummaryInput = z
  .object({
    relationKey: relatedSummaryRelationKeySchema,
    sourceId: z.string().min(1),
    includeSubProjects: z.boolean().optional(),
    search: z.string().trim().max(200).optional(),
    sort: z
      .object({
        field: relatedSummarySortFieldSchema,
        direction: z.enum(["asc", "desc"]),
      })
      .strict()
      .optional(),
    offset: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(100).default(25),
  })
  .strict();
export type RelatedSummaryInput = z.infer<typeof relatedSummaryInput>;

const relatedSummaryImage = z
  .object({
    id: z.string(),
    url: z.string(),
    filename: z.string(),
    contentType: z.string(),
  })
  .strict();
const relatedSummaryTarget = z
  .object({
    // Summary targets are deliberately narrower than the general relationship
    // graph: these six aggregates only ever group products, projects, or
    // vendors. Keeping that in the public contract prevents UI casts from
    // masking a repository/registry mismatch.
    entity: z.enum(["product", "project", "vendor"]),
    id: z.string(),
    label: z.string(),
    image: relatedSummaryImage.nullable(),
  })
  .strict();
const relatedSummaryRow = z
  .object({
    target: relatedSummaryTarget.nullable(),
    expenseCount: z.number().int().nonnegative(),
    purchaseCount: z.number().int().nonnegative(),
    unpricedExpenseCount: z.number().int().nonnegative(),
    netSpend: z.number(),
    latestActivity: z.string().nullable(),
    knownAcquiredUnits: z.number().int().nonnegative(),
    unknownAcquisitionQuantityCount: z.number().int().nonnegative(),
  })
  .strict();
const relatedSummaryTotals = z
  .object({
    expenseCount: z.number().int().nonnegative(),
    purchaseCount: z.number().int().nonnegative(),
    unpricedExpenseCount: z.number().int().nonnegative(),
    netSpend: z.number(),
    knownAcquiredUnits: z.number().int().nonnegative(),
    unknownAcquisitionQuantityCount: z.number().int().nonnegative(),
  })
  .strict();
export const relatedSummaryOutput = z
  .object({
    data: z.array(relatedSummaryRow),
    count: z.number().int().nonnegative(),
    totals: relatedSummaryTotals,
    nextOffset: z.number().int().nonnegative().nullable(),
  })
  .strict();
export type RelatedSummaryOutput = z.infer<typeof relatedSummaryOutput>;
export type RelatedBranchOutput = z.infer<typeof relatedBranchOutput>;

/** Searchable relation target options; count is distinct matching source rows. */
export const relatedOptionsInput = z.object({
  relationKey: relatedViewKeySchema,
  search: z.string().trim().max(200).optional(),
  limit: z.number().int().min(1).max(100).default(25),
});
export type RelatedOptionsInput = z.infer<typeof relatedOptionsInput>;

export const relatedOptionsOutput = z.array(
  z.object({
    entity: entitySchema,
    id: z.string(),
    label: z.string(),
    count: z.number().int().nonnegative(),
  }),
);
export type RelatedOptionsOutput = z.infer<typeof relatedOptionsOutput>;

export const relatedFilterPrefix = (view: RelatedViewDefinition): string =>
  view.filterPrefix ?? view.target;

const relatedPresence = z.enum(["has", "none"]).optional();
const relatedSearch = z.string().optional();
type RelatedTrio<Prefix extends string, Ids extends z.ZodType> = {
  [K in `${Prefix}Id`]: Ids;
} & {
  [K in `${Prefix}PresenceFilter`]: typeof relatedPresence;
} & {
  [K in `${Prefix}Search`]: typeof relatedSearch;
};
const trio = <Prefix extends string, IdSchema extends z.ZodType>(
  prefix: Prefix,
  idSchema: IdSchema,
) => {
  const ids = z.union([idSchema, z.array(idSchema)]).optional();
  return {
    [`${prefix}Id`]: ids,
    [`${prefix}PresenceFilter`]: relatedPresence,
    [`${prefix}Search`]: relatedSearch,
  } as RelatedTrio<Prefix, typeof ids>;
};

export const productRelatedFilterFields = {
  ...trio("vendor", vendorShortcode),
  ...trio("project", projectShortcode),
  ...trio("usedOnProject", projectShortcode),
  ...trio("purchase", purchaseShortcode),
  ...trio("expense", expenseShortcode),
  ...trio("relatedInventory", inventoryShortcode),
  ...trio("task", taskShortcode),
};
export const recipeRelatedFilterFields = {
  ...trio("ingredient", ingredientShortcode),
  ...trio("meal", mealShortcode),
};
export const mealRelatedFilterFields = trio("recipe", recipeShortcode);
export const locationRelatedFilterFields = trio(
  "ingredient",
  ingredientShortcode,
);
export const inventoryRelatedFilterFields = trio(
  "ingredient",
  ingredientShortcode,
);
export const projectRelatedFilterFields = {
  ...trio("project", projectShortcode),
  ...trio("task", taskShortcode),
  ...trio("expense", expenseShortcode),
  ...trio("taskProduct", productShortcode),
  ...trio("purchasedProduct", productShortcode),
  ...trio("usedTool", productShortcode),
  ...trio("vendor", vendorShortcode),
};
export const taskRelatedFilterFields = {
  ...trio("blockedByTask", taskShortcode),
  ...trio("parentTask", taskShortcode),
};
export const vendorRelatedFilterFields = {
  ...trio("expense", expenseShortcode),
  ...trio("purchase", purchaseShortcode),
  ...trio("product", productShortcode),
  ...trio("project", projectShortcode),
  ...trio("financialTransaction", financialTransactionShortcode),
};
export const purchaseRelatedFilterFields = {
  ...trio("expense", expenseShortcode),
  ...trio("financialTransaction", financialTransactionShortcode),
  ...trio("product", productShortcode),
  ...trio("project", projectShortcode),
};
export const expenseRelatedFilterFields = trio(
  "financialTransaction",
  financialTransactionShortcode,
);
export const financialAccountRelatedFilterFields = {
  ...trio("financialTransaction", financialTransactionShortcode),
  ...trio("purchase", purchaseShortcode),
  ...trio("vendor", vendorShortcode),
};
export const financialTransactionRelatedFilterFields = {
  ...trio("vendor", vendorShortcode),
  ...trio("expense", expenseShortcode),
  ...trio("product", productShortcode),
};
