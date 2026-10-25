import type { DerivedStoredInput } from "./definition";

const COMPONENTS = {
  table: "EntityLink",
  from: "fromEntityId",
  to: "toEntityId",
  where: { kind: "productComponent" },
};
const PRICE_COLUMNS = ["price", "categoryId", "deletedAt"];
const EXPENSE_COLUMNS = [
  "cost",
  "productQuantity",
  "lineKind",
  "future",
  "date",
  "deletedAt",
];
const CATEGORY_COLUMNS = ["parentId", "feature", "deletedAt"];

/** Authoritative pricing reads, rooted at Product ids rather than rounded cache values. */
export const PRODUCT_PRICING_INPUTS: DerivedStoredInput[] = [
  { table: "Product", match: { id: "id" }, columns: PRICE_COLUMNS },
  { table: "Expense", match: { productId: "id" }, columns: EXPENSE_COLUMNS },
  {
    table: "EntityLink",
    match: { fromEntityId: "id" },
    where: { kind: "productComponent" },
  },
  {
    table: "EntityLink",
    match: { toEntityId: "id" },
    where: { kind: "productComponent" },
  },
  {
    table: "ProductCategory",
    match: { id: "id" },
    columns: CATEGORY_COLUMNS,
    path: [{ table: "Product", from: "categoryId", to: "id" }],
  },
  // A changed kit line changes every sibling's share even when the kit's
  // published price is unchanged. Old/new fromEntityId marks both kits.
  {
    table: "EntityLink",
    match: { fromEntityId: "id" },
    where: { kind: "productComponent" },
    path: [COMPONENTS],
  },
  {
    table: "Expense",
    match: { productId: "id" },
    columns: EXPENSE_COLUMNS,
    path: [COMPONENTS],
  },
  {
    table: "Product",
    match: { id: "id" },
    columns: PRICE_COLUMNS,
    path: [COMPONENTS],
  },
  {
    table: "ProductCategory",
    match: { id: "id" },
    columns: CATEGORY_COLUMNS,
    path: [{ table: "Product", from: "categoryId", to: "id" }, COMPONENTS],
  },
];

/** Map the same raw pricing dependencies from Product ids to a consuming entity. */
export const productPricingInputsFor = (
  path: NonNullable<DerivedStoredInput["path"]>,
): DerivedStoredInput[] =>
  PRODUCT_PRICING_INPUTS.map((input) => ({
    ...input,
    path: [...(input.path ?? []), ...path],
  }));
