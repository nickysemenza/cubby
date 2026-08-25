import type { BrowserRoutedEntity } from "@cubby/schemas/entity-manifest";
import {
  expenseLineBasisSchema,
  expenseLineKindSchema,
} from "@cubby/schemas/expense-line-kind";
import { financialAccountIdentityKind } from "@cubby/schemas/financial-account";
import {
  financialTransactionKind,
  financialTransactionStatus,
} from "@cubby/schemas/financial-transaction";
import { ImageStatus } from "@cubby/schemas/image";
import {
  costTypeSchema,
  plainDate,
  projectKindSchema,
  projectStatusSchema,
  tradeSchema,
} from "@cubby/schemas/project";
import { recipeSourceValues } from "@cubby/schemas/recipe-shared";
import { locationTypeValues, productCategoryValues } from "@cubby/shared";
import { z } from "zod";
import { tableSearchFields } from "~/app/_components/data-table/table-search";
import { createDialogSearchField } from "~/app/_components/forms/create-dialog-action";
import {
  expenseAnalyzeConfigFromSearch,
  expenseAnalyzeSearchFields,
  expenseAnalyzeSearchPatch,
} from "~/app/expenses/expense-analyze-config";
import { entityFilterSearchFields } from "~/entities/filter-search-fields";
import {
  isValidProjectDateFilter,
  isValidTaskStatusFilter,
  normalizeProjectRenderer,
  normalizeTaskRenderer,
  PROJECT_ROWS_RENDERERS,
} from "~/lib/list-view-normalization";
import {
  urlEnumListParam,
  urlShortcodeListParam,
  urlShortcodeParam,
  urlStringParam,
} from "~/lib/search-params";

/**
 * The URL search shape of every entity list route, in one place.
 *
 * Three traps are baked into {@link listSearchSchema} so no route has to
 * remember them:
 *
 * 1. `entityFilterSearchFields()` is spread FIRST. A route with a `z.object`
 *    `validateSearch` strips every key it doesn't declare, which would let the
 *    table write a filter to the URL only for the router to remove it again.
 *    Deriving the fragment from the manifest means a spec added later can't be
 *    silently forgotten by a route.
 * 2. The per-entity `overrides` are spread LAST so they win. That ordering is
 *    load-bearing: a manifest key re-declared here must override the generic
 *    string parser, not be overridden by it.
 * 3. Every override is a `urlStringParam` (or a codec built on it), never a
 *    bare `z.string()`. TanStack's `parseSearch` JSON-parses first, so
 *    `?q=486242` arrives as a number and `?future=true` as a boolean — a plain
 *    string schema drops both silently.
 *
 * The generic `T` exists for a fourth reason: `entityFilterSearchFields()`
 * returns a `Record<string, …>` whose keys are invisible to `Route.useSearch()`
 * and `<Link search={…}>`. Keeping the overrides a literal type parameter is
 * what makes those keys statically known at every call site.
 */
function listSearchSchema<T extends z.ZodRawShape>(
  entity: BrowserRoutedEntity,
  overrides: T,
) {
  // `tableSearchFields` is spread between the manifest and the overrides. No
  // entity re-declares one of its keys (`sort` / `page` / `pageSize` /
  // `worklist`) today; one that did would silently lose to this fragment.
  return z.object({
    ...entityFilterSearchFields(entity),
    ...tableSearchFields,
    ...overrides,
  });
}

/* -------------------------------------------------------------------------- */
/* Catalog                                                                     */
/* -------------------------------------------------------------------------- */

const PRODUCT_LIST_VIEWS = ["table", "shelf", "events", "lifecycles"] as const;

export const productSearchSchema = listSearchSchema("product", {
  view: z.enum(PRODUCT_LIST_VIEWS).optional().catch(undefined),
  movementFrom: plainDate.optional().catch(undefined),
  movementTo: plainDate.optional().catch(undefined),
  movementOrder: z.enum(["asc", "desc"]).optional().catch(undefined),
  category: urlEnumListParam(z.enum(productCategoryValues)),
  // Navigated to programmatically (the "Fits With" tag chips; the Problems
  // page's manufacturer-spelling cards), so these need literal key types.
  tags: urlStringParam,
  manufacturer: urlStringParam,
  model: urlStringParam,
  ingredient: urlShortcodeListParam("ingredient"),
});

export const productSearchDefaults = {
  category: undefined,
  view: undefined,
  movementFrom: undefined,
  movementTo: undefined,
  movementOrder: undefined,
} as const;

/* -------------------------------------------------------------------------- */
/* Inventory                                                                   */
/* -------------------------------------------------------------------------- */

export const inventorySearchSchema = listSearchSchema("inventory", {
  productId: urlShortcodeParam("product"),
  locationId: urlShortcodeParam("location"),
});

export const LOCATION_LIST_VIEWS = [
  "gallery",
  "table",
  "visualizations",
] as const;

export const locationSearchSchema = listSearchSchema("location", {
  view: z.enum(LOCATION_LIST_VIEWS).optional().catch(undefined),
  type: urlEnumListParam(z.enum(locationTypeValues)),
  product: urlShortcodeListParam("product"),
  parent: urlShortcodeListParam("location"),
});

export const locationSearchDefaults = { view: undefined } as const;

export const imageListSearchSchema = listSearchSchema("image", {
  status: urlEnumListParam(ImageStatus),
});

/* -------------------------------------------------------------------------- */
/* Kitchen                                                                     */
/* -------------------------------------------------------------------------- */

export const recipeListSearchSchema = listSearchSchema("recipe", {
  tags: urlStringParam,
  source: urlShortcodeListParam("cookbook"),
  sourceType: urlEnumListParam(z.enum(recipeSourceValues)),
});

/** Ingredients now use the same generated filter/search contract as every list route. */
export const ingredientListSearchSchema = listSearchSchema("ingredient", {});

export const wishSearchSchema = listSearchSchema("wish", {
  q: urlStringParam,
  ...createDialogSearchField,
});

export const wishSearchDefaults = { q: undefined, create: undefined } as const;

/* -------------------------------------------------------------------------- */
/* Projects and tasks                                                          */
/* -------------------------------------------------------------------------- */

const dateFilterParam = urlStringParam
  .refine(isValidProjectDateFilter, "Invalid project date filter")
  .catch(undefined);
const completionYearParam = urlStringParam
  .refine(
    (value) => value === undefined || /^\d{4}$/.test(value),
    "Invalid completion year",
  )
  .catch(undefined);
/**
 * Which renderer the Data tab's Projects section uses. Piped through the enum
 * rather than left a loose string so the value arrives typed. Unknown renderers
 * are dropped so stale URLs fall back to the canonical default.
 */
const rowsRendererParam = urlStringParam
  .pipe(z.enum(PROJECT_ROWS_RENDERERS).optional())
  .catch(undefined);
const commaSeparatedArray = <T extends z.ZodType>(itemSchema: T) =>
  z.preprocess(
    (value) =>
      typeof value === "string"
        ? value.split(",").filter((item) => item.length > 0)
        : value,
    z.array(itemSchema).optional(),
  );

export const projectSearchSchema = listSearchSchema("project", {
  // Absent `statuses` is unrestricted. Invalid enum values fail this route's
  // validation instead of being forwarded as a widened server query.
  statuses: commaSeparatedArray(projectStatusSchema),
  kinds: commaSeparatedArray(projectKindSchema),
  locations: commaSeparatedArray(z.string()),
  parent: urlShortcodeListParam("project"),
  date: dateFilterParam,
  view: urlStringParam,
  rows: rowsRendererParam,
  // Quick-capture deep link (navbar "+" / command palette) — there is no
  // /projects/new route, so the create dialog is opened by this param.
  create: z.boolean().optional().catch(undefined),
  // ProjectTable's sort/page URL sync writes to this route already — a
  // strict validateSearch without these would strip them.
  completed: completionYearParam,
}).transform(({ view, ...rest }) => {
  const normalized = normalizeProjectRenderer(view);
  return {
    ...rest,
    ...normalized,
    statuses: normalized.statuses ?? rest.statuses,
  };
});

export const projectSearchDefaults = {
  statuses: undefined,
  kinds: undefined,
  locations: undefined,
  date: undefined,
  completed: undefined,
  view: "overview",
  rows: "flat",
  create: undefined,
} as const;

const taskStatusParam = urlStringParam
  .refine(isValidTaskStatusFilter, "Invalid task status filter")
  .catch(undefined);

export const taskSearchSchema = listSearchSchema("task", {
  q: urlStringParam,
  status: taskStatusParam,
  trade: urlEnumListParam(tradeSchema),
  project: urlShortcodeListParam("project"),
  parentTask: urlShortcodeListParam("task"),
  // Declared by name as well as through the manifest so typed links can set an
  // exact product scope and the visible "For" presence filter.
  productId: urlShortcodeListParam("product"),
  subjectProduct: urlShortcodeListParam("product"),
  view: urlStringParam,
  // Board layout: column axis + swimlane axis. `lane` is normalized to only
  // apply when `cols === "status"` inside TasksBoardView.
  cols: z.enum(["status", "project", "trade"]).optional().catch(undefined),
  lane: z.enum(["project", "trade"]).optional().catch(undefined),
  // Quick-capture deep link (navbar "+" / command palette) — there is no
  // /tasks/new route, so the create dialog is opened by this param.
  create: z.boolean().optional().catch(undefined),
}).transform(({ view, ...rest }) => {
  const normalized = normalizeTaskRenderer(view);
  if (normalized.clearFilters) {
    return {
      ...rest,
      view: normalized.view,
      q: undefined,
      status: undefined,
      project: undefined,
      parentTask: undefined,
      dueDate: undefined,
      trade: undefined,
      subjectProduct: undefined,
      productId: undefined,
    };
  }
  return {
    ...rest,
    ...normalized,
  };
});

export const taskSearchDefaults = {
  q: undefined,
  productId: undefined,
  subjectProduct: undefined,
  view: undefined,
  cols: undefined,
  lane: undefined,
  create: undefined,
} as const;

/* -------------------------------------------------------------------------- */
/* Money                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Old bookmarks pointed at `?view=planned|unclassified|unassigned`. Those tabs
 * are gone; map each to the filter state its preset used to pin, so a stale
 * link lands on the same rows instead of a dead tab. Precedent:
 * `RecipeDetail.tsx`'s legacy-tab normalizer.
 */
const LEGACY_EXPENSE_VIEW_FILTERS: Record<string, Record<string, string>> = {
  planned: { future: "true" },
  unassigned: { project: "__none__" },
  unclassified: { trade: "other", cost: "none" },
};

export const EXPENSE_LIST_VIEWS = ["ledger", "analytics"] as const;

const isExpenseView = (
  value: string | undefined,
): value is (typeof EXPENSE_LIST_VIEWS)[number] =>
  value !== undefined &&
  (EXPENSE_LIST_VIEWS as readonly string[]).includes(value);

/**
 * The ledger's filter params are also what the Analytics view decodes back out,
 * so `expense.analytics` is always called with the exact filter set the Ledger
 * table shows. `productId` is the raw id for an exact-product deep link (from a
 * product's "See all in ledger"); `product` is the presence value
 * ("has"/"none"), deliberately a separate key since the product column's filter
 * offers presence rather than a specific-product select.
 */
export const expenseSearchSchema = listSearchSchema("expense", {
  // Deliberately a loose string, not `z.enum(EXPENSE_LIST_VIEWS)`: a legacy
  // `?view=planned` must survive validation long enough for the transform below
  // to translate it. The transform is what narrows this to a renderer.
  view: urlStringParam,
  q: urlStringParam,
  trade: urlEnumListParam(tradeSchema),
  costType: urlEnumListParam(costTypeSchema),
  lineKind: urlEnumListParam(expenseLineKindSchema),
  lineBasis: urlEnumListParam(expenseLineBasisSchema),
  cost: urlStringParam,
  project: urlShortcodeListParam("project"),
  subprojects: urlStringParam,
  future: urlEnumListParam(z.enum(["true", "false"])),
  date: urlStringParam,
  dateFrom: urlStringParam,
  dateTo: urlStringParam,
  productId: urlShortcodeListParam("product"),
  product: urlStringParam,
  // `order` (the manifest's `orderIdExact` url key) and `vendor` are set
  // together as a pair by the "Same Order" section and the ledger's Order #
  // cell — an order id only identifies an order within one vendor. Declared
  // by name so those `<Link search={{ order, vendor }}>` calls typecheck.
  order: urlStringParam,
  vendor: urlShortcodeListParam("vendor"),
  orderId: urlStringParam,
  // Deep link from a charge's own detail page — the exact-charge scope,
  // same treatment as `productId` above.
  purchaseId: urlStringParam,
  ...expenseAnalyzeSearchFields,
  // Quick-capture deep link (navbar "+" / command palette) — there is no
  // /expenses/new route, so the create dialog is opened by this param.
  create: z.boolean().optional().catch(undefined),
}).transform(({ view, ...rest }) => {
  const legacy = view ? LEGACY_EXPENSE_VIEW_FILTERS[view] : undefined;
  const normalizedRest = {
    ...rest,
    ...expenseAnalyzeSearchPatch(expenseAnalyzeConfigFromSearch(rest)),
  };
  // A retired preset tab becomes the filter state it used to pin, so the
  // bookmark lands on the same rows — and now says so in the URL.
  if (legacy) return { ...normalizedRest, ...legacy, view: undefined };
  return {
    ...normalizedRest,
    view: isExpenseView(view) ? view : undefined,
  };
});

export const expenseSearchDefaults = {
  q: undefined,
  view: undefined,
  cost: undefined,
  trade: undefined,
  costType: undefined,
  lineKind: undefined,
  lineBasis: undefined,
  project: undefined,
  subprojects: undefined,
  future: undefined,
  date: undefined,
  dateFrom: undefined,
  dateTo: undefined,
  productId: undefined,
  product: undefined,
  order: undefined,
  vendor: undefined,
  orderId: undefined,
  purchaseId: undefined,
  analyzeRows: undefined,
  analyzeColumns: undefined,
  analyzeMetric: undefined,
  analyzeCompare: undefined,
  analyzeShow: undefined,
  create: undefined,
} as const;

export const vendorSearchSchema = listSearchSchema("vendor", {
  q: urlStringParam,
  ...createDialogSearchField,
});

export const vendorSearchDefaults = {
  create: undefined,
  q: undefined,
} as const;

export const purchaseSearchSchema = listSearchSchema("purchase", {
  q: urlStringParam,
  label: urlStringParam,
  vendor: urlShortcodeListParam("vendor"),
  orderId: urlStringParam,
  date: urlStringParam,
  statedTotal: urlStringParam,
  lines: urlStringParam,
  lineTotal: urlStringParam,
  reconciliation: urlStringParam,
  documents: urlStringParam,
  transactions: urlStringParam,
  dataQuality: urlStringParam,
  dataGaps: urlStringParam,
  lineTotalMin: urlStringParam,
  lineTotalMax: urlStringParam,
  ...createDialogSearchField,
});

export const purchaseSearchDefaults = {
  create: undefined,
  q: undefined,
  label: undefined,
  vendor: undefined,
  orderId: undefined,
  date: undefined,
  statedTotal: undefined,
  lines: undefined,
  lineTotal: undefined,
  reconciliation: undefined,
  documents: undefined,
  transactions: undefined,
  dataQuality: undefined,
  dataGaps: undefined,
  lineTotalMin: undefined,
  lineTotalMax: undefined,
} as const;

export const financialAccountSearchSchema = listSearchSchema(
  "financialAccount",
  {
    q: urlStringParam,
    identity: urlEnumListParam(financialAccountIdentityKind),
    provisional: urlEnumListParam(z.enum(["true", "false"])),
    ...createDialogSearchField,
  },
);

export const financialTransactionSearchSchema = listSearchSchema(
  "financialTransaction",
  {
    q: urlStringParam,
    merchant: urlStringParam,
    kind: urlEnumListParam(financialTransactionKind),
    status: urlEnumListParam(financialTransactionStatus),
    accountId: urlShortcodeListParam("financialAccount"),
    purchaseId: urlShortcodeListParam("purchase"),
    ...createDialogSearchField,
  },
);

/** Both finance rosters share the same stripped defaults. */
export const financeSearchDefaults = {
  q: undefined,
  create: undefined,
} as const;
