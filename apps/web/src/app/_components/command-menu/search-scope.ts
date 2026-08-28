import type { SearchableEntity } from "@cubby/schemas/search";

const SEARCH_SCOPE_ALIASES = {
  product: "product",
  products: "product",
  recipe: "recipe",
  recipes: "recipe",
  ingredient: "ingredient",
  ingredients: "ingredient",
  cookbook: "cookbook",
  cookbooks: "cookbook",
  location: "location",
  locations: "location",
  inventory: "inventory",
  "inventory item": "inventory",
  "inventory items": "inventory",
  meal: "meal",
  meals: "meal",
  project: "project",
  projects: "project",
  task: "task",
  tasks: "task",
  vendor: "vendor",
  vendors: "vendor",
  purchase: "purchase",
  purchases: "purchase",
  account: "financialAccount",
  accounts: "financialAccount",
  "financial account": "financialAccount",
  "financial accounts": "financialAccount",
  transaction: "financialTransaction",
  transactions: "financialTransaction",
  "financial transaction": "financialTransaction",
  "financial transactions": "financialTransaction",
  expense: "expense",
  expenses: "expense",
} as const satisfies Record<string, SearchableEntity>;

const isSearchScopeAlias = (
  value: string,
): value is keyof typeof SEARCH_SCOPE_ALIASES => value in SEARCH_SCOPE_ALIASES;

interface CommandSearchScope {
  entityType: SearchableEntity | null;
  query: string;
}

/**
 * Recognizes an explicit leading entity scope such as `inventory:m18`.
 * Unknown prefixes remain ordinary search text so names containing a colon
 * keep working.
 */
export function parseCommandSearchScope(value: string): CommandSearchScope {
  const separatorIndex = value.indexOf(":");
  if (separatorIndex < 0) return { entityType: null, query: value };

  const alias = value.slice(0, separatorIndex).trim().toLocaleLowerCase();
  const entityType = isSearchScopeAlias(alias)
    ? SEARCH_SCOPE_ALIASES[alias]
    : undefined;

  return entityType
    ? {
        entityType,
        query: value.slice(separatorIndex + 1).trimStart(),
      }
    : { entityType: null, query: value };
}
