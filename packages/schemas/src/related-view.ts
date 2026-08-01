import { z } from "zod";
import type { Entity } from "./entity";
import { entitySchema } from "./entity";
import type { RelationshipPathStep } from "./entity-integrity";
import {
  expenseShortcode,
  financialTransactionShortcode,
  ingredientShortcode,
  mealShortcode,
  productShortcode,
  projectShortcode,
  purchaseShortcode,
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
}

const out = (edge: string) => ({ edge, direction: "outgoing" }) as const;
const inc = (edge: string) => ({ edge, direction: "incoming" }) as const;

export const relatedViewRegistry = [
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
  ...trio("expense", expenseShortcode),
  ...trio("task", taskShortcode),
};
export const recipeRelatedFilterFields = {
  ...trio("ingredient", ingredientShortcode),
  ...trio("meal", mealShortcode),
};
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
};
export const taskRelatedFilterFields = {
  ...trio("blockedByTask", taskShortcode),
  ...trio("parentTask", taskShortcode),
};
export const vendorRelatedFilterFields = {
  ...trio("expense", expenseShortcode),
  ...trio("purchase", purchaseShortcode),
  ...trio("product", productShortcode),
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
