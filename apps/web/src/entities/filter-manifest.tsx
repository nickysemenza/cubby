import type { Entity } from "@cubby/schemas/entity";
import { financialAccountFilterFields } from "@cubby/schemas/financial-account";
import { financialTransactionFilterFields } from "@cubby/schemas/financial-transaction";
import {
  unsafeCookbookId,
  unsafeFinancialAccountShortcode,
  unsafeIngredientId,
  unsafeLocationId,
  unsafeProductId,
  unsafeProjectId,
  unsafePurchaseId,
  unsafeTaskId,
  unsafeVendorId,
} from "@cubby/schemas/identifiers";
import { imageFilterFields } from "@cubby/schemas/image";
import { ingredientFilterFields } from "@cubby/schemas/ingredient";
import { inventoryFilterFields } from "@cubby/schemas/inventory";
import { locationFilterFields } from "@cubby/schemas/location";
import { mealFilterFields } from "@cubby/schemas/meal";
import { productFilterFields } from "@cubby/schemas/product";
import {
  expenseFilterFields,
  projectFilterFields,
  taskFilterFields,
} from "@cubby/schemas/project";
import { purchaseFilterFields } from "@cubby/schemas/purchase";
import { recipeFilterFields, recipeSourceValues } from "@cubby/schemas/recipe";
import {
  relatedFilterPrefix,
  relatedViewRegistry,
} from "@cubby/schemas/related-view";
import { vendorFilterFields } from "@cubby/schemas/vendor";
import { wishFilterFields } from "@cubby/schemas/wish";
import { uniq } from "es-toolkit";
import type { FilterConfig } from "~/app/_components/data-table/columnHelpers";
import {
  barFieldFromConfig,
  type FilterBarField,
} from "~/app/_components/data-table/filter-bar-core";
import {
  deferredFilterOptionSource,
  filterOptionItems,
  type RuntimeFilterOptions,
} from "~/app/_components/hooks/filter-option-types";
import { locationTypeOptionsWithTheme } from "~/app/_components/locations/location-icons";
import { productCategoryOptionsWithTheme } from "~/app/_components/products/product-category-icons";
import {
  costRangeOptions,
  costTypeOptions,
  dateRangeOptions,
  expenseLineBasisOptions,
  expenseLineKindOptions,
  futureFilterOptions,
  productQuantityRangeOptions,
  resolveCostFilter,
  resolveDateRange,
  resolveProductQuantityFilter,
} from "~/app/expenses/expense-options";
import {
  amountRangeOptions,
  resolveAmountFilter,
} from "~/app/finance/financial-transaction-options";
import { imageStatusOptions } from "~/app/images/image-options";
import { mealKindOptions, mealTypeOptions } from "~/app/meals/meal-options";
import {
  PROJECT_STATUS_OPTIONS,
  projectKindOptions,
} from "~/app/projects/project-options";
import { tradeOptions } from "~/app/projects/trade-options";
import {
  purchaseExpenseStatusOptions,
  purchaseExpenseTotalOptions,
  purchaseReconciliationOptions,
  resolvePurchaseExpenseTotalFilter,
} from "~/app/purchases/purchase-options";
import {
  dueRangeOptions,
  resolveDueRange,
  taskStatusOptions,
} from "~/app/tasks/task-options";
import type { FilterableComboboxItem } from "~/components/ui/combobox";
import { dataQualityOptions } from "~/lib/data-quality-options";
import {
  type FilterKind,
  type FilterSpecCore,
  humanize,
  isMultiFilterKind,
  nullableSentinelOptions,
  presenceFilterOptions,
} from "./filters";

/**
 * The filter manifest: what each entity's list table can be filtered by.
 *
 * One entry drives the toolbar filter control, the server filter field, and
 * (via `kind`) how the column's state is shaped. The pure builders that
 * consume it live in `./filters`, kept separate so they're unit-testable.
 *
 * Import direction matters: `useStandardColumns` imports this, so nothing
 * here may import a module that reaches back into the table hooks. That's why
 * `tradeOptions` lives in a leaf module rather than in `app/projects/shared.tsx`.
 */
export interface FilterSpec extends FilterSpecCore {
  /** Full placeholder. The toolbar shortens it for select controls. */
  placeholder: string;
  /** Static options. Mutually exclusive with `optionsKey`. */
  options?: FilterableComboboxItem[];
  /**
   * Names a runtime option list the page supplies via `filterOptions` — for
   * picklists that come from the server (the project roster, a recipe's tag
   * universe) and so can't be static module data.
   */
  optionsKey?: string;
  /**
   * Control label. Defaults to `humanize(columnId)`.
   *
   * Only a bar with no table under it needs this — a column-backed control
   * reads its label off the column header. Set it where the column id doesn't
   * read as one on its own, which on a cross-kind surface is most of them
   * ("taskStatus" has to render as "Task status", because the whole point is
   * that it constrains tasks and nothing else).
   */
  label?: string;
}

const resolveProductPurchaseDateFilter = (
  preset: string | undefined,
): {
  purchaseDatePresenceFilter?: "has" | "none";
  purchaseDateFrom?: string;
  purchaseDateTo?: string;
} => {
  if (preset === "has" || preset === "none") {
    return { purchaseDatePresenceFilter: preset };
  }
  const { dateFrom, dateTo } = resolveDateRange(preset);
  return {
    ...(dateFrom ? { purchaseDateFrom: dateFrom } : {}),
    ...(dateTo ? { purchaseDateTo: dateTo } : {}),
  };
};

const resolveAuditDateRange =
  (prefix: "created" | "updated") =>
  (preset: string | undefined): Record<string, string | undefined> => {
    const { dateFrom, dateTo } = resolveDateRange(preset);
    return {
      [`${prefix}From`]: dateFrom,
      [`${prefix}To`]: dateTo,
    };
  };

const expenseCountOptions: FilterableComboboxItem[] = [
  ...presenceFilterOptions("expenses"),
  { value: "1", label: "1+ expenses" },
  { value: "2", label: "2+ expenses" },
  { value: "5", label: "5+ expenses" },
];

const resolveExpenseCount = (value: string | undefined) =>
  value === "has" || value === "none"
    ? { expensePresenceFilter: value }
    : value
      ? { expenseCountMin: Number(value) }
      : {};

const netBasisOptions: FilterableComboboxItem[] = [
  { value: "positive", label: "Positive basis" },
  { value: "zero", label: "Zero basis" },
  { value: "negative", label: "Credit / negative" },
  { value: "gte100", label: "$100 and up" },
  { value: "gte500", label: "$500 and up" },
];

const resolveNetBasis = (value: string | undefined) => {
  if (value === "positive") return { expenseTotalMin: 0.01 };
  if (value === "zero") return { expenseTotalMin: 0, expenseTotalMax: 0 };
  if (value === "negative") return { expenseTotalMax: -0.01 };
  if (value === "gte100") return { expenseTotalMin: 100 };
  if (value === "gte500") return { expenseTotalMin: 500 };
  return {};
};

/**
 * Units bought minus units gone. "Negative" is the defect worklist — you cannot
 * have sold or returned more than you ever bought — and is the reason the
 * server-side bounds are signed rather than clamped at zero.
 */
const priceOptions: FilterableComboboxItem[] = [
  ...presenceFilterOptions("price"),
  { value: "none-real", label: "No price (excluding buckets)" },
  { value: "none-bucket", label: "No price (buckets only)" },
];

const resolvePrice = (value: string | undefined) => {
  if (value === "has" || value === "none")
    return { pricePresenceFilter: value };
  // The two worklists behind the unpriced half: a `misc:` bucket has no
  // meaningful unit price and is expected to be unpriced, so it is reported
  // separately rather than kept permanently red alongside real gaps.
  if (value === "none-real")
    return {
      pricePresenceFilter: "none" as const,
      miscBucketFilter: "none" as const,
    };
  if (value === "none-bucket")
    return {
      pricePresenceFilter: "none" as const,
      miscBucketFilter: "has" as const,
    };
  return {};
};

const expectedQuantityOptions: FilterableComboboxItem[] = [
  { value: "negative", label: "Negative (sold more than bought)" },
  { value: "zero", label: "Zero (none expected)" },
  { value: "positive", label: "One or more expected" },
  { value: "gte5", label: "5 or more expected" },
  { value: "unknown", label: "Has lines with no quantity" },
];

const resolveExpectedQuantity = (value: string | undefined) => {
  if (value === "negative") return { expectedQuantityMax: -1 };
  if (value === "zero")
    return { expectedQuantityMin: 0, expectedQuantityMax: 0 };
  if (value === "positive") return { expectedQuantityMin: 1 };
  if (value === "gte5") return { expectedQuantityMin: 5 };
  if (value === "unknown")
    return { unknownQuantityLinesFilter: "has" as const };
  return {};
};

/**
 * Shelf against ledger. Both options are scoped server-side to stocked
 * products — see `quantityVarianceFilter` in the product schema for why an
 * unscoped "matched" would be meaningless.
 */
const quantityVarianceOptions: FilterableComboboxItem[] = [
  { value: "mismatched", label: "Shelf disagrees with ledger" },
  { value: "matched", label: "Shelf matches ledger" },
];

const resolveQuantityVariance = (value: string | undefined) =>
  value === "mismatched" || value === "matched"
    ? { quantityVarianceFilter: value }
    : {};

const resolveVendorPurchases = (value: string | undefined) =>
  value === "none"
    ? { purchaseCountMax: 0 }
    : value === "has"
      ? { purchaseCountMin: 1 }
      : value
        ? { purchaseCountMin: Number(value) }
        : {};

const resolveVendorSpend = (value: string | undefined) => {
  if (value === "positive") return { spendMin: 0.01 };
  if (value === "zero") return { spendMin: 0, spendMax: 0 };
  if (value === "negative") return { spendMax: -0.01 };
  if (value === "gte100") return { spendMin: 100 };
  if (value === "gte500") return { spendMin: 500 };
  return {};
};

const resolveLatestPurchaseDate = (preset: string | undefined) => {
  if (preset === "has" || preset === "none") {
    return { latestPurchaseDatePresenceFilter: preset };
  }
  const { dateFrom, dateTo } = resolveDateRange(preset);
  return {
    latestPurchaseDateFrom: dateFrom,
    latestPurchaseDateTo: dateTo,
  };
};

const resolveVerifiedDate = (preset: string | undefined) => {
  if (preset === "has" || preset === "none") {
    return { verifiedPresenceFilter: preset };
  }
  const { dateFrom, dateTo } = resolveDateRange(preset);
  return { verifiedFrom: dateFrom, verifiedTo: dateTo };
};

const resolveProductTaskFilter = (value: string | undefined) => {
  if (value === "has" || value === "none") {
    return { taskPresenceFilter: value };
  }
  if (value === "open") return { taskOpenOnly: true };
  if (taskStatusOptions.some((option) => option.value === value)) {
    return { taskStatusFilter: value };
  }
  const { dueFrom, dueTo } = resolveDueRange(value);
  return { taskDueFrom: dueFrom, taskDueTo: dueTo };
};

const resolveTaskDueFilter = (value: string | undefined) => {
  if (value === "has" || value === "none") {
    return { duePresenceFilter: value };
  }
  return resolveDueRange(value);
};

const recountAgeOptions: FilterableComboboxItem[] = [
  { value: "30", label: "Not counted in 30 days" },
  { value: "60", label: "Not counted in 60 days" },
  { value: "90", label: "Not counted in 90 days" },
];

/** Each option is "older than N days, or never recounted" — see the field's
 *  schema doc for why the never-recounted half is part of the predicate. */
const resolveRecountAge = (value: string | undefined) => {
  const days = Number(value);
  return Number.isInteger(days) && days > 0
    ? { lastBulkInventoryOlderThanDays: days }
    : {};
};

const resolveLocationItems = (value: string | undefined) =>
  value === "none"
    ? { directItemCountMax: 0 }
    : value === "has"
      ? { directItemCountMin: 1 }
      : value
        ? { directItemCountMin: Number(value) }
        : {};

const resolveLocationValuation = (value: string | undefined) => {
  if (value === "positive") return { valuationMin: 0.01 };
  if (value === "zero") return { valuationMin: 0, valuationMax: 0 };
  if (value === "negative") return { valuationMax: -0.01 };
  if (value === "gte100") return { valuationMin: 100 };
  if (value === "gte500") return { valuationMin: 500 };
  return {};
};

const recipeSourceOptions: FilterableComboboxItem[] = recipeSourceValues.map(
  (value) => ({ value, label: value }),
);

const recipeCostOptions: FilterableComboboxItem[] = [
  { value: "under10", label: "Under $10" },
  { value: "10to25", label: "$10–$25" },
  { value: "25plus", label: "$25 and up" },
];
const resolveRecipeCost = (value: string | undefined) =>
  value === "under10"
    ? { costTotalMax: 10 }
    : value === "10to25"
      ? { costTotalMin: 10, costTotalMax: 25 }
      : value === "25plus"
        ? { costTotalMin: 25 }
        : {};

// The weeknight axis: "what can I actually cook tonight". Buckets, not a free
// numeric input, because that's how the decision is actually made.
const recipeTotalTimeOptions: FilterableComboboxItem[] = [
  { value: "under30", label: "Under 30 min" },
  { value: "30to60", label: "30–60 min" },
  { value: "60plus", label: "Over an hour" },
];
const resolveRecipeTotalTime = (value: string | undefined) =>
  value === "under30"
    ? { totalMinutesMax: 30 }
    : value === "30to60"
      ? { totalMinutesMin: 30, totalMinutesMax: 60 }
      : value === "60plus"
        ? { totalMinutesMin: 60 }
        : {};

const calorieOptions: FilterableComboboxItem[] = [
  { value: "under500", label: "Under 500 cal" },
  { value: "500to1000", label: "500–1,000 cal" },
  { value: "1000plus", label: "1,000+ cal" },
];
const resolveCalories = (value: string | undefined) =>
  value === "under500"
    ? { caloriesTotalMax: 500 }
    : value === "500to1000"
      ? { caloriesTotalMin: 500, caloriesTotalMax: 1000 }
      : value === "1000plus"
        ? { caloriesTotalMin: 1000 }
        : {};

/**
 * Every entity's own `*FilterFields` map, keyed by entity — the single place
 * that has to be kept current when a new filterable entity is added.
 * `auditFilterEntities` below is DERIVED from this rather than hand-listing
 * entity names a second time: that hand-kept list had already drifted —
 * `projectFilterFields` and `mealFilterFields` both spread
 * `auditDateFilterFields`, so the server accepted `createdFrom`/`updatedTo`
 * for project and meal while no UI control could ever send them. Deriving
 * means a `*FilterFields` gaining `auditDateFilterFields` later (or losing
 * it) doesn't also require a matching edit to a second set here.
 *
 * Exported for the two drift guards in `filter-manifest.unit.test.tsx`, which
 * compare the manifest against these maps in both directions. They must read
 * the map `auditFilterEntities` is derived from, not a second copy — a copy
 * would agree with itself while this one went stale.
 */
export const entityFilterFieldMaps: Partial<
  Record<Entity, Record<string, unknown>>
> = {
  financialAccount: financialAccountFilterFields,
  financialTransaction: financialTransactionFilterFields,
  expense: expenseFilterFields,
  vendor: vendorFilterFields,
  purchase: purchaseFilterFields,
  task: taskFilterFields,
  product: productFilterFields,
  recipe: recipeFilterFields,
  ingredient: ingredientFilterFields,
  inventory: inventoryFilterFields,
  location: locationFilterFields,
  image: imageFilterFields,
  meal: mealFilterFields,
  project: projectFilterFields,
  wish: wishFilterFields,
};

const auditFilterEntities = new Set<Entity>(
  (Object.entries(entityFilterFieldMaps) as [Entity, Record<string, unknown>][])
    .filter(([, fields]) => "createdFrom" in fields)
    .map(([entity]) => entity),
);

const auditFilterSpecs: readonly FilterSpec[] = [
  {
    columnId: "createdAt",
    kind: "range",
    placeholder: "Filter by created date...",
    options: dateRangeOptions,
    expand: resolveAuditDateRange("created"),
  },
  {
    columnId: "updatedAt",
    kind: "range",
    placeholder: "Filter by updated date...",
    options: dateRangeOptions,
    expand: resolveAuditDateRange("updated"),
  },
];

const imageAuditFilterSpecs: readonly FilterSpec[] = [
  {
    columnId: "createdAt",
    kind: "range",
    placeholder: "Filter by created date...",
    options: [
      { value: "olderThan1h", label: "Older than 1 hour" },
      ...dateRangeOptions,
    ],
    expand: (value) =>
      value === "olderThan1h"
        ? { uploadedAgeHoursMin: 1 }
        : resolveAuditDateRange("created")(value),
  },
  auditFilterSpecs[1]!,
];

/** The control a kind renders as. */
const filterTypeForKind = (
  kind: FilterKind,
): "text" | "select" | "multiselect" =>
  kind === "text" ? "text" : isMultiFilterKind(kind) ? "multiselect" : "select";

/**
 * Entities that deliberately declare no filters, so "nobody has added them yet"
 * stops looking identical to "there is nothing to add". `entityFilters` below is
 * a TOTAL record over the remainder, so a new Entity must either bring a filter
 * list or be named here with the reason — the `?? []` fallback used to swallow
 * both cases silently.
 */
const ENTITIES_WITHOUT_FILTERS = {
  // No list table of its own: cookbooks are browsed as a gallery, and the
  // recipe list carries the `cookbookId` filter that scopes into one.
  cookbook: "browsed as a gallery; recipe.cookbookId is the way in",
  // Not a local entity — the USDA surface is a remote search box against the
  // usda-api worker, with no column set to filter.
  "usda-food": "remote USDA search, not a local list",
} as const satisfies Partial<Record<Entity, string>>;

type FilteredEntity = Exclude<Entity, keyof typeof ENTITIES_WITHOUT_FILTERS>;

const entityFilters: Record<FilteredEntity, readonly FilterSpec[]> = {
  financialAccount: [
    {
      columnId: "name",
      field: "search",
      urlKey: "q",
      kind: "text",
      placeholder: "Search accounts...",
    },
    {
      columnId: "identity",
      field: "identityKind",
      kind: "multiselect",
      placeholder: "Filter by account type...",
      options: [
        { value: "credit_card", label: "Credit card" },
        { value: "bank_account", label: "Bank account" },
        { value: "stored_value", label: "Stored value" },
        { value: "cash", label: "Cash" },
        { value: "other", label: "Other" },
      ],
    },
    {
      columnId: "provisional",
      kind: "boolean",
      placeholder: "Filter by status...",
      options: [
        { value: "false", label: "Known" },
        { value: "true", label: "Provisional" },
      ],
    },
    {
      columnId: "aliases",
      field: "sourceAliasPresenceFilter",
      kind: "presence",
      placeholder: "Filter aliases...",
      options: presenceFilterOptions("aliases"),
    },
    {
      columnId: "last4",
      urlOnly: true,
      kind: "text",
      placeholder: "Filter by last four digits...",
    },
    {
      columnId: "source",
      urlOnly: true,
      kind: "multiselect",
      placeholder: "Filter by source...",
    },
    {
      columnId: "externalAccountId",
      urlOnly: true,
      kind: "multiselect",
      placeholder: "Filter by external account id...",
    },
  ],

  financialTransaction: [
    {
      columnId: "allocationIntegrity",
      urlOnly: true,
      kind: "select",
      placeholder: "Filter allocation integrity...",
    },
    {
      columnId: "transaction",
      field: "search",
      urlKey: "q",
      kind: "text",
      placeholder: "Search transactions...",
    },
    {
      columnId: "kind",
      kind: "multiselect",
      placeholder: "Filter by kind...",
      options: [
        { value: "purchase", label: "Purchase" },
        { value: "refund", label: "Refund" },
        { value: "account_transfer", label: "Account transfer" },
        { value: "credit_card_payment", label: "Credit card payment" },
        { value: "fee", label: "Fee" },
        { value: "interest", label: "Interest" },
        { value: "income", label: "Income" },
        { value: "adjustment", label: "Adjustment" },
        { value: "other", label: "Other" },
      ],
    },
    {
      columnId: "status",
      kind: "multiselect",
      placeholder: "Filter by status...",
      options: [
        { value: "expected", label: "Expected" },
        { value: "pending", label: "Pending" },
        { value: "posted", label: "Posted" },
        { value: "void", label: "Void" },
      ],
    },
    {
      columnId: "postedDate",
      kind: "range",
      placeholder: "Filter by posted date...",
      options: dateRangeOptions,
      expand: (preset) => {
        const { dateFrom, dateTo } = resolveDateRange(preset);
        return { postedDateFrom: dateFrom, postedDateTo: dateTo };
      },
    },
    {
      columnId: "accountId",
      kind: "idMulti",
      brand: unsafeFinancialAccountShortcode,
      placeholder: "Filter by account...",
      optionsKey: "account",
    },
    {
      // Stays URL-only: the purchase universe is unbounded, so this is a deep
      // link's scope (from a purchase's detail page), not a picklist. The
      // `purchasePresence` spec below is the filterable half.
      columnId: "purchaseId",
      urlOnly: true,
      kind: "multiselect",
      placeholder: "Filter by purchase...",
    },
    {
      columnId: "purchasePresence",
      field: "purchasePresenceFilter",
      kind: "presence",
      placeholder: "Filter purchase links...",
      options: presenceFilterOptions("purchase"),
    },
    {
      columnId: "source",
      kind: "multiselect",
      placeholder: "Filter by source...",
      optionsKey: "source",
    },
    {
      // Stays URL-only for the same reason as `purchaseId` — an external id is
      // one row's provider reference, not a category.
      columnId: "externalId",
      urlOnly: true,
      kind: "multiselect",
      placeholder: "Filter by external id...",
    },
    {
      columnId: "merchant",
      kind: "text",
      placeholder: "Filter by merchant...",
    },
    {
      // One control for the whole Amount column, resolving to the `amountMin` /
      // `amountMax` pair below — which stay URL-only as its expansion targets,
      // the same split `postedDate` has with `postedDateFrom`/`To`.
      columnId: "amount",
      kind: "range",
      placeholder: "Filter by amount...",
      options: amountRangeOptions,
      expand: resolveAmountFilter,
    },
    {
      columnId: "amountMin",
      urlOnly: true,
      kind: "text",
      placeholder: "Minimum amount...",
    },
    {
      columnId: "amountMax",
      urlOnly: true,
      kind: "text",
      placeholder: "Maximum amount...",
    },
    {
      columnId: "transactionDateFrom",
      urlOnly: true,
      kind: "text",
      placeholder: "Transaction date from...",
    },
    {
      columnId: "transactionDateTo",
      urlOnly: true,
      kind: "text",
      placeholder: "Transaction date to...",
    },
    {
      columnId: "postedDateFrom",
      urlOnly: true,
      kind: "text",
      placeholder: "Posted date from...",
    },
    {
      columnId: "postedDateTo",
      urlOnly: true,
      kind: "text",
      placeholder: "Posted date to...",
    },
  ],

  expense: [
    {
      columnId: "name",
      field: "search",
      // `?q=`, not `?name=` — an established link shape (command palette, the
      // "see all in ledger" links), kept working across the URL-sync move.
      urlKey: "q",
      kind: "text",
      placeholder: "Search expenses...",
    },
    {
      columnId: "date",
      kind: "range",
      placeholder: "Filter by date...",
      options: dateRangeOptions,
      expand: resolveDateRange,
    },
    {
      columnId: "dateFrom",
      urlOnly: true,
      kind: "text",
      placeholder: "Expense date from...",
    },
    {
      columnId: "dateTo",
      urlOnly: true,
      kind: "text",
      placeholder: "Expense date to...",
    },
    {
      // Server-relative dates keep Problem links stable across midnight instead
      // of freezing today's ISO date into a saved URL.
      columnId: "dateRelative",
      urlOnly: true,
      kind: "select",
      placeholder: "Filter by relative date...",
    },
    {
      columnId: "costType",
      kind: "multiselect",
      placeholder: "Filter by cost type...",
      options: costTypeOptions,
    },
    {
      columnId: "lineKind",
      kind: "multiselect",
      placeholder: "Filter by line kind...",
      options: expenseLineKindOptions,
    },
    {
      // Orthogonal to `lineKind`, despite the adjacent names — see
      // `expenseLineBasisValues`. Surfaced as "Itemization" so the two never
      // read as one taxonomy split across two controls.
      columnId: "lineBasis",
      kind: "multiselect",
      placeholder: "Filter by itemization...",
      options: expenseLineBasisOptions,
    },
    {
      columnId: "trade",
      kind: "multiselect",
      placeholder: "Filter by trade...",
      options: tradeOptions,
    },
    {
      columnId: "future",
      kind: "boolean",
      placeholder: "Filter by status...",
      options: futureFilterOptions,
    },
    {
      // ONE control for the Cost column, covering both "is a number recorded at
      // all" (the two sentinels, which make the Unclassified predicate
      // `trade='other' AND cost IS NULL` expressible as plain URL state) and
      // "how big is it" (the amount buckets).
      //
      // `kind: "range"` rather than `presence` because a range spec's `expand`
      // returns a whole patch — that is what lets one selected value resolve to
      // EITHER `costPresenceFilter` or a `costMin`/`costMax` pair. `?cost=has` /
      // `?cost=none` bookmarks are unaffected: `resolveCostFilter` handles them
      // first and emits exactly what the old `presence` spec did.
      //
      // Merging the two is safe because a bucket already implies a recorded
      // cost, so no meaningful combination is lost — and the column has exactly
      // one filter slot to spend.
      columnId: "cost",
      kind: "range",
      placeholder: "Filter by cost...",
      options: [...presenceFilterOptions("cost"), ...costRangeOptions],
      expand: resolveCostFilter,
    },
    {
      // Exact money bounds, URL/MCP only — the header offers presets (above)
      // because the control layer has no numeric-range widget. Distinct
      // `columnId`s: two specs may not share a slot, and `cost` is the presets'.
      //
      // `kind: "text"` yields the raw string off the URL; `costMin`/`costMax`
      // are `z.coerce.number()` server-side precisely so `?costMin=500` parses.
      columnId: "costMin",
      urlOnly: true,
      kind: "text",
      placeholder: "Minimum cost...",
    },
    {
      columnId: "costMax",
      urlOnly: true,
      kind: "text",
      placeholder: "Maximum cost...",
    },
    {
      // Strict direction is needed by exit worklists; the friendly Cost
      // picker deliberately keeps zero-dollar rows with credits instead.
      columnId: "costSign",
      urlOnly: true,
      kind: "select",
      placeholder: "Filter by cost direction...",
    },
    {
      // A disposal is a Purchase relationship fact from the ownership ledger,
      // not simply a negative Expense line.
      columnId: "disposalPurchasePresenceFilter",
      urlOnly: true,
      kind: "presence",
      placeholder: "Filter disposal purchase presence...",
    },
    {
      // Like Cost, the header owns one slot and combines presence with the
      // useful fixed whole-unit buckets. Exact bounds remain URL/MCP inputs.
      columnId: "productQuantity",
      kind: "range",
      placeholder: "Filter by quantity...",
      options: [
        ...presenceFilterOptions("quantity"),
        ...productQuantityRangeOptions,
      ],
      expand: resolveProductQuantityFilter,
    },
    {
      columnId: "productQuantityMin",
      urlOnly: true,
      kind: "text",
      placeholder: "Minimum product quantity...",
    },
    {
      columnId: "productQuantityMax",
      urlOnly: true,
      kind: "text",
      placeholder: "Maximum product quantity...",
    },
    {
      // `notes` and `url` aren't rendered columns, so these are URL/MCP-only —
      // the same treatment `productId` and `orderIdExact` get below. Separate
      // fields rather than a widening of `search`, because the server ANDs its
      // search filters and most rows have neither value (see
      // `expenseFilterFields`).
      columnId: "notesSearch",
      urlOnly: true,
      kind: "text",
      placeholder: "Search notes...",
    },
    {
      columnId: "urlSearch",
      urlOnly: true,
      kind: "text",
      placeholder: "Search url...",
    },
    {
      columnId: "project",
      field: "projectId",
      kind: "idMulti",
      brand: unsafeProjectId,
      placeholder: "Filter by project...",
      optionsKey: "project",
      nullable: { field: "projectPresenceFilter", label: "project" },
    },
    {
      // URL-only companion to an exact project deep link. Project detail
      // summaries aggregate the complete descendant subtree, so their ledger
      // links must carry the same scope to reconcile exactly.
      columnId: "includeSubProjects",
      urlKey: "subprojects",
      urlOnly: true,
      kind: "boolean",
      placeholder: "Include sub-projects...",
    },
    {
      // No column renders this — it's seeded from the URL only (a deep link
      // from a product's detail page). Declared so the builder still maps it.
      columnId: "productId",
      urlOnly: true,
      kind: "id",
      brand: unsafeProductId,
      placeholder: "Filter by product id...",
    },
    {
      // A full product picklist isn't practical (the product universe is
      // unbounded, unlike projects), so this only distinguishes linked vs not.
      columnId: "product",
      field: "productPresenceFilter",
      kind: "presence",
      placeholder: "Filter by product...",
      options: presenceFilterOptions("product"),
    },
    {
      // Vendor **ids**, not the free-text name that used to sit on the row: a
      // vendor is a real entity now, reached through the purchase
      // (`expense.purchaseId → Purchase.vendorId`). So this is `idMulti` on
      // `vendorId`, modelled on `project` above — the column still RENDERS the
      // name, but the roster and the filter trade in ids, which is what makes
      // "Amazon (254)" unable to drag in "Amazon Business".
      //
      // Options come from `expense.vendorOptions` at runtime (`{id, name,
      // count}`): a bounded roster, but a DB one, so it can't be static module
      // data. Each option keeps the vendor's brand mark and row count.
      //
      // The URL key stays `vendor` and now holds an id — same shape as
      // `?project=<projectId>`. A stale bookmark carrying a vendor NAME simply
      // matches nothing; there's no name→id fallback, since resolving one would
      // mean guessing at a roster the URL can't see.
      //
      // `(none)` is the where-did-this-come-from worklist: `purchase.vendorId`
      // is NOT NULL, so "no vendor" and "no purchase attached" are one predicate.
      columnId: "vendor",
      field: "vendorId",
      kind: "idMulti",
      brand: unsafeVendorId,
      placeholder: "Filter by vendor...",
      optionsKey: "vendor",
      nullable: { field: "vendorPresenceFilter", label: "purchase" },
    },
    {
      // "none" is the unreconciled worklist — no order id recorded. The id lives
      // on the PURCHASE now, so this covers both "a purchase with no order id" and
      // "no purchase at all"; both have always read as "no order id" here.
      columnId: "orderId",
      field: "orderIdPresenceFilter",
      kind: "presence",
      placeholder: "Filter by order id...",
      options: presenceFilterOptions("order id"),
    },
    {
      // URL-only, like `productId` above — seeded by the purchase section's header
      // and the ledger's Order # cell, surfaced as a ScopeChip.
      // Its `columnId` can't be `orderId`: that one is the presence control,
      // and a second spec on the same id would read the same filter slot.
      //
      // No longer paired with a vendor. The order id resolves through
      // `purchaseId`, and `(vendorId, orderId)` is partial-unique on the purchase,
      // so a short id like Tool Nirvana's "#11325" can't reach another
      // retailer's — the pairing existed only because the old key was two loose
      // string columns on the ledger row.
      columnId: "orderIdExact",
      urlOnly: true,
      field: "orderId",
      urlKey: "order",
      kind: "id",
      placeholder: "Filter by order id...",
    },
    {
      // URL-only, like `productId`/`orderIdExact` above — seeded by a deep
      // link from a purchase's own detail page, surfaced as a ScopeChip. Its
      // `columnId` is distinct from both of those (and from `orderId`'s
      // presence control): two specs may not share a slot.
      columnId: "purchaseId",
      urlOnly: true,
      kind: "id",
      brand: unsafePurchaseId,
      placeholder: "Filter by purchase id...",
    },
  ],

  // The roster of places money goes. One spec, covering all of
  // `vendorFiltersSchema` (packages/schemas/src/vendor.ts) — just `search`. The
  // rollup columns (`purchaseCount`, `spend`) are correlated subqueries the repo
  // computes for display and sorting; there is no server filter behind either,
  // so neither gets a spec.
  vendor: [
    {
      // `?q=`, like the ledger's name search and purchases' `q` — the money
      // family's search key. `field: "search"` because the server matches it as
      // a substring of the vendor NAME (`vendorFilterFields.search`).
      columnId: "name",
      field: "search",
      urlKey: "q",
      kind: "text",
      placeholder: "Search vendors...",
    },
    {
      columnId: "purchaseCount",
      kind: "range",
      placeholder: "Filter purchase count...",
      options: expenseCountOptions.map((option) => ({
        ...option,
        label: option.label.replace("expenses", "purchases"),
      })),
      expand: resolveVendorPurchases,
    },
    {
      columnId: "spend",
      kind: "range",
      placeholder: "Filter spend...",
      options: netBasisOptions,
      expand: resolveVendorSpend,
    },
    {
      columnId: "latestPurchaseDate",
      kind: "range",
      placeholder: "Filter latest purchase...",
      options: [...presenceFilterOptions("purchase"), ...dateRangeOptions],
      expand: resolveLatestPurchaseDate,
    },
    {
      columnId: "logo",
      field: "logoPresenceFilter",
      kind: "presence",
      placeholder: "Filter logos...",
      options: presenceFilterOptions("logo"),
    },
  ],

  // One row per vendor purchase. These specs cover `purchaseFiltersSchema`,
  // including the exact line-total bounds kept URL-only for callers that need
  // values outside the UI presets. A purchase has its own detail route, so there
  // is no expense-style exact-order-id scope here.
  purchase: [
    {
      columnId: "financialReconciliation",
      urlOnly: true,
      kind: "select",
      placeholder: "Filter financial reconciliation...",
    },
    {
      // `?q=`, the money family's search key — and it hangs on `purchase`, not
      // `orderId`. `purchase` IS purchase's name column (`standardColumns` is
      // `[]`, so there's no hook-prepended `name`): a bespoke identity accessor,
      // which is why it's absent from `purchaseSortableFields` and stays
      // unsortable. Server-side the term is a broad substring match over order
      // id OR display label; the dedicated label column below can narrow that
      // to human context alone.
      columnId: "purchase",
      field: "search",
      urlKey: "q",
      kind: "text",
      placeholder: "Search order id or label...",
    },
    {
      columnId: "displayLabel",
      field: "displayLabelSearch",
      urlKey: "label",
      kind: "text",
      placeholder: "Search display label...",
    },
    {
      // Id-based, like the ledger's vendor filter: the column RENDERS
      // `vendorName`, but the roster and the filter trade in ids.
      //
      // No `nullable` sentinels — `Purchase.vendorId` is NOT NULL, so there is
      // no "(none)" cohort to offer. (Expense's vendor filter does have them,
      // because there "no vendor" means "no purchase attached".)
      //
      // `optionsKey: "vendor"` names the same key as expense's spec but is fed a
      // DIFFERENT roster: this page injects `vendor.options` (purchase counts),
      // the ledger injects `expense.vendorOptions` (ledger-row counts). Rosters
      // stay page-fed per `filterOptions`; they must not be collapsed into one
      // shared options hook.
      columnId: "vendor",
      field: "vendorId",
      kind: "idMulti",
      brand: unsafeVendorId,
      placeholder: "Filter by vendor...",
      optionsKey: "vendor",
    },
    {
      // "(none)" is the reconciliation worklist: the ~40% of purchases the vendor
      // never issued an order id for.
      columnId: "orderId",
      field: "orderIdPresenceFilter",
      kind: "presence",
      placeholder: "Filter by order id...",
      options: presenceFilterOptions("order id"),
    },
    {
      // Same presets and expander as the ledger's date filter — one `?date=30d`
      // means the same window on both money tables.
      columnId: "date",
      kind: "range",
      placeholder: "Filter by date...",
      options: dateRangeOptions,
      expand: resolveDateRange,
    },
    {
      // "(none)" is the purchases with no paperwork total recorded yet — the ones
      // `ReconciliationBadge` has nothing to reconcile against.
      columnId: "statedTotal",
      field: "statedTotalPresenceFilter",
      kind: "presence",
      placeholder: "Filter by stated total...",
      options: presenceFilterOptions("stated total"),
    },
    {
      columnId: "expenseCount",
      field: "expenseStatus",
      urlKey: "lines",
      kind: "multiselect",
      placeholder: "Filter by expense status...",
      options: purchaseExpenseStatusOptions,
    },
    {
      columnId: "expenseTotal",
      urlKey: "lineTotal",
      kind: "range",
      placeholder: "Filter by expense total...",
      options: purchaseExpenseTotalOptions,
      expand: resolvePurchaseExpenseTotalFilter,
    },
    {
      columnId: "reconciliation",
      kind: "multiselect",
      placeholder: "Filter reconciliation...",
      options: purchaseReconciliationOptions,
    },
    {
      columnId: "documentCount",
      field: "documentPresenceFilter",
      urlKey: "documents",
      kind: "presence",
      placeholder: "Filter by documents...",
      options: presenceFilterOptions("documents"),
    },
    {
      // Deliberately distinct from the `settlement_reference` data gap: this is
      // "no FinancialTransaction at all", that one is "no POSTED transaction of
      // a settlement kind carrying statement or cash evidence". A purchase can
      // have three transactions and still fail the gap.
      //
      // Shares its server field with the related-view registry's own
      // `financialTransactionPresenceFilter` spec (urlOnly, keyed by field
      // name). Both are entry points to one server filter, and an absent value
      // emits no patch, so they only interact if a URL sets both by hand.
      columnId: "transactionCount",
      field: "financialTransactionPresenceFilter",
      urlKey: "transactions",
      kind: "presence",
      placeholder: "Filter by transactions...",
      options: presenceFilterOptions("transactions"),
    },
    {
      columnId: "dataQuality",
      field: "dataStatus",
      kind: "select",
      placeholder: "Filter data quality...",
      options: dataQualityOptions,
    },
    {
      // `primary_document` is deliberately absent. The check is unscoped and
      // fires on almost every purchase, so offering it here would just enshrine
      // a signal that can't discriminate — the same call #599 made when it
      // declined to give it a saved view. The server still accepts it from a
      // URL or over MCP; this is only what the picklist advertises.
      columnId: "dataGaps",
      field: "dataGap",
      kind: "multiselect",
      placeholder: "Filter data gaps...",
      options: [
        { value: "settlement_reference", label: "No settlement evidence" },
        { value: "purchase_date", label: "Missing date" },
        { value: "order_id", label: "Missing order ID" },
        { value: "stated_total", label: "Missing stated total" },
        { value: "empty_expenses", label: "No expense lines" },
        { value: "unpriced_expense", label: "Unpriced expense line" },
        { value: "paperwork_mismatch", label: "Paperwork mismatch" },
      ],
    },
    {
      columnId: "expenseTotalMin",
      urlKey: "lineTotalMin",
      urlOnly: true,
      kind: "text",
      placeholder: "Minimum expense total...",
    },
    {
      columnId: "expenseTotalMax",
      urlKey: "lineTotalMax",
      urlOnly: true,
      kind: "text",
      placeholder: "Maximum expense total...",
    },
  ],

  task: [
    {
      columnId: "name",
      field: "search",
      kind: "text",
      placeholder: "Search tasks...",
    },
    {
      columnId: "status",
      kind: "multiselect",
      placeholder: "Filter by status...",
      options: taskStatusOptions,
    },
    {
      columnId: "trade",
      kind: "multiselect",
      placeholder: "Filter by trade...",
      options: tradeOptions,
    },
    {
      // `dueDate`, not `due` — the column comes from `createPlainDateColumn`
      // keyed on the field name. The pre-manifest filter list said "due", so
      // this control matched no column and never rendered at all.
      columnId: "dueDate",
      kind: "range",
      placeholder: "Filter by due date...",
      options: [...presenceFilterOptions("due date"), ...dueRangeOptions],
      expand: resolveTaskDueFilter,
    },
    {
      // Exact Problem continuation: unlike the friendly inclusive `overdue`
      // preset, this resolves server-side as strictly before today.
      columnId: "dueRelative",
      urlOnly: true,
      kind: "select",
      placeholder: "Filter by relative due date...",
      options: [{ value: "beforeToday", label: "Before today" }],
    },
    {
      columnId: "completion",
      urlOnly: true,
      kind: "select",
      placeholder: "Filter task completion...",
      options: [
        { value: "open", label: "Open" },
        { value: "done", label: "Done" },
      ],
    },
    {
      columnId: "project",
      field: "projectId",
      kind: "idMulti",
      brand: unsafeProjectId,
      placeholder: "Filter by project...",
      optionsKey: "project",
      nullable: { field: "projectPresenceFilter", label: "project" },
    },
    {
      // Product-detail task history deep-links here. The unbounded product
      // catalog makes a synchronous header picklist impractical, so the exact
      // id stays URL-only while the visible "For" column offers has/none.
      columnId: "productId",
      urlOnly: true,
      field: "subjectProductId",
      urlKey: "productId",
      kind: "id",
      brand: unsafeProductId,
      placeholder: "Filter by product id...",
    },
    {
      columnId: "subjectProduct",
      field: "subjectProductId",
      kind: "idMulti",
      brand: unsafeProductId,
      placeholder: "Filter by product...",
      optionsKey: "taskProducts",
      nullable: {
        field: "subjectProductPresenceFilter",
        label: "product",
      },
    },
    {
      columnId: "parentTask",
      field: "parentTaskId",
      kind: "idMulti",
      brand: unsafeTaskId,
      placeholder: "Filter by parent task...",
      optionsKey: "parentTask",
      nullable: { field: "parentTaskPresenceFilter", label: "parent task" },
    },
  ],

  product: [
    {
      columnId: "name",
      field: "nameFilter",
      kind: "text",
      placeholder: "Filter by name...",
    },
    {
      columnId: "manufacturer",
      field: "manufacturerExact",
      kind: "multiselect",
      placeholder: "Filter by manufacturer...",
      optionsKey: "manufacturers",
    },
    {
      columnId: "manufacturerSearch",
      field: "manufacturerFilter",
      urlOnly: true,
      kind: "text",
      placeholder: "Search manufacturer...",
    },
    {
      // Labelled UPC, keyed on the derived barcode column. Matches ANY of the
      // product's barcodes, not just the primary one shown in the cell.
      columnId: "primaryGtin",
      field: "upcFilter",
      kind: "text",
      placeholder: "Filter by UPC...",
    },
    {
      // Model number is a tool's real identity when the name is generic
      // ("Impact Driver" vs "M18 FUEL 2853-20").
      columnId: "model",
      field: "modelFilter",
      kind: "text",
      placeholder: "Filter by model...",
    },
    {
      columnId: "modelPresence",
      field: "modelPresenceFilter",
      kind: "presence",
      placeholder: "Filter model presence...",
      options: presenceFilterOptions("model"),
    },
    {
      columnId: "upcPresence",
      field: "upcPresenceFilter",
      kind: "presence",
      placeholder: "Filter UPC presence...",
      options: presenceFilterOptions("UPC"),
    },
    {
      columnId: "category",
      field: "categoryFilter",
      kind: "multiselect",
      placeholder: "Filter by category...",
      options: productCategoryOptionsWithTheme,
      nullable: { field: "categoryPresenceFilter", label: "category" },
    },
    {
      columnId: "location",
      field: "locationIdFilter",
      kind: "idMulti",
      brand: unsafeLocationId,
      placeholder: "Filter locations...",
      optionsKey: "productLocations",
      nullable: { field: "inventoryPresenceFilter", label: "inventory" },
    },
    {
      // A second kind of presence: the product IS a bin somewhere, rather than
      // sitting on a shelf as stock. "none" plus `location: none` is the
      // genuine "owned and nowhere" set.
      columnId: "servingAsLocations",
      field: "servingAsLocationPresenceFilter",
      kind: "presence",
      placeholder: "Filter in service...",
      options: presenceFilterOptions("in service as a location"),
    },
    {
      columnId: "ingredient",
      field: "ingredientIdFilter",
      kind: "idMulti",
      brand: unsafeIngredientId,
      placeholder: "Filter ingredient...",
      optionsKey: "productIngredients",
      nullable: { field: "ingredientPresenceFilter", label: "ingredient" },
    },
    {
      columnId: "expenses",
      kind: "range",
      placeholder: "Filter expenses...",
      options: expenseCountOptions,
      expand: resolveExpenseCount,
    },
    {
      columnId: "expenseTotal",
      kind: "range",
      placeholder: "Filter net basis...",
      options: netBasisOptions,
      expand: resolveNetBasis,
    },
    {
      columnId: "expectedQuantity",
      kind: "range",
      placeholder: "Filter expected quantity...",
      options: expectedQuantityOptions,
      expand: resolveExpectedQuantity,
    },
    {
      columnId: "quantityVariance",
      kind: "range",
      placeholder: "Filter shelf vs. ledger...",
      options: quantityVarianceOptions,
      expand: resolveQuantityVariance,
    },
    {
      columnId: "notes",
      field: "notesFilter",
      kind: "text",
      placeholder: "Search notes...",
    },
    {
      columnId: "notesPresence",
      field: "notesPresenceFilter",
      kind: "presence",
      placeholder: "Filter notes presence...",
      options: presenceFilterOptions("notes"),
    },
    {
      columnId: "dataQuality",
      field: "dataStatus",
      kind: "select",
      placeholder: "Filter data quality...",
      options: dataQualityOptions,
    },
    {
      columnId: "dataGaps",
      field: "dataGap",
      kind: "multiselect",
      placeholder: "Filter data gaps...",
      options: [
        { value: "product_manufacturer", label: "Manufacturer" },
        { value: "product_category", label: "Category" },
        { value: "product_model", label: "Model" },
        // Offered, unlike the purchase list's `primary_document`, because this
        // one is scoped to stocked products and therefore discriminates.
        { value: "product_image", label: "No image (stocked)" },
        { value: "amazon_asin", label: "Amazon ASIN" },
        { value: "duplicate_external_id", label: "Duplicate external ID" },
      ],
    },
    {
      // An exact SOURCE roster rather than the has/none it replaced: "which of
      // these came from Home Depot" is the question the column is opened for,
      // and has/none survives as the two nullable sentinels.
      //
      // `optionsKey`, not `options`: a source is an open kebab-case slug
      // (external-id.ts validates the shape, it is not a `z.enum`), so the
      // roster is whatever importers have actually written and must come from
      // `product.externalIdSourceOptions` at runtime. A stale bookmark naming
      // a source nobody uses anymore simply matches nothing.
      columnId: "externalIds",
      field: "externalIdSource",
      kind: "multiselect",
      placeholder: "Filter by external ID source...",
      optionsKey: "externalIdSources",
      nullable: { field: "externalIdPresenceFilter", label: "external ID" },
    },
    {
      // Products may appear on several ledger lines; the cell shows the latest
      // linked Purchase date, while a range matches when ANY linked live
      // Purchase falls inside it. Has/(none) separates purchased provenance
      // from products that have never been tied to a Purchase.
      columnId: "purchaseDate",
      kind: "range",
      placeholder: "Filter by purchase date...",
      options: [...presenceFilterOptions("purchase date"), ...dateRangeOptions],
      expand: resolveProductPurchaseDateFilter,
    },
    {
      // Combined with `inventoryPresenceFilter: "has"` this is the
      // valuation-gap worklist: products physically on a shelf that nobody
      // has priced yet.
      //
      // A range rather than a bare presence, because the unpriced half splits:
      // a `misc:` bucket is a heterogeneous pile with no meaningful unit price
      // and is EXPECTED to be unpriced, so the two belong in different
      // worklists. One control emitting a two-field patch is the same shape
      // `verifiedAt` and `expectedQuantity` use.
      columnId: "price",
      kind: "range",
      placeholder: "Filter price...",
      options: priceOptions,
      expand: resolvePrice,
    },
    {
      // "USDA key", not "USDA food" — the predicate is `fdc_id IS NOT NULL OR
      // a gtin identifier row EXISTS`, and SQL can't know whether the usda
      // worker actually resolves a food for that key. See
      // `usdaPresenceFilter`'s schema doc.
      columnId: "food",
      field: "usdaPresenceFilter",
      kind: "presence",
      placeholder: "Filter USDA...",
      options: presenceFilterOptions("USDA key"),
    },
    {
      columnId: "image",
      field: "imagePresenceFilter",
      kind: "presence",
      placeholder: "Filter images...",
      options: presenceFilterOptions("image"),
    },
    {
      // Exact entity-grain duplicate placement worklist. This is not a generic
      // quantity range: it preserves the stock-vs-installed distinction.
      columnId: "inventoryMultiplicity",
      field: "inventoryMultiplicity",
      kind: "select",
      placeholder: "Filter inventory multiplicity...",
      options: [
        {
          value: "duplicate_within_placement",
          label: "Duplicate within placement",
        },
      ],
    },
    {
      columnId: "kitAccounting",
      field: "kitAccounting",
      kind: "select",
      placeholder: "Filter kit accounting...",
      options: [{ value: "double_counted", label: "Counted twice" }],
    },
    {
      columnId: "ownershipReconciliation",
      field: "ownershipReconciliation",
      kind: "select",
      placeholder: "Filter ownership reconciliation...",
      options: [
        {
          value: "disposed_still_on_hand",
          label: "Disposed but still on hand",
        },
      ],
    },
    {
      columnId: "conversionCoverage",
      field: "conversionCoverage",
      kind: "select",
      placeholder: "Filter conversion coverage...",
      options: [{ value: "partial", label: "Partial coverage" }],
    },
    {
      columnId: "conversionTopology",
      field: "conversionTopology",
      kind: "select",
      placeholder: "Filter conversion topology...",
      options: [{ value: "islanded", label: "Islanded mappings" }],
    },
    {
      // Bare presence, not a quality tier — and it has to stay that way. The
      // cell's tier is conversion COVERAGE: graph reachability through the unit
      // engine over stored edges PLUS USDA-derived ones (portions, servings,
      // per-nutrient calories) that live in the usda-api service, not Postgres.
      // No SQL predicate can reproduce it, so a "Complete/Good/Partial" control
      // here would return rows whose badge says something else. Presence has no
      // such conflict: "(none)" is exactly "no chips", which is always tier
      // `none`. A truthful quality filter needs a persisted coverage column.
      columnId: "unitMappingQuality",
      field: "unitMappingPresenceFilter",
      kind: "presence",
      placeholder: "Filter mappings...",
      options: presenceFilterOptions("mappings"),
    },
    {
      // Hand-written options, not `presenceFilterOptions("stock tracking")`:
      // that helper emits "Has X"/"No X", and "Has stock tracking" would be a
      // lie for a product whose stockTracked was reviewed and set to false.
      // "none" is the undecided worklist; "has" is reviewed either way.
      columnId: "stockTracked",
      field: "stockTrackedPresenceFilter",
      kind: "presence",
      placeholder: "Filter stock tracking...",
      options: [
        { value: "none", label: "Undecided" },
        { value: "has", label: "Reviewed" },
      ],
    },
    {
      // Hand-written options for the same reason as `stockTracked` above:
      // `presenceFilterOptions("components")` would emit "Has components" /
      // "(none)", which buries the concept the filter actually names. A
      // product that contains components IS a kit, so say that.
      columnId: "components",
      field: "componentPresenceFilter",
      kind: "presence",
      placeholder: "Filter kits...",
      options: [
        { value: "has", label: "Is a kit" },
        { value: "none", label: "Not a kit" },
      ],
    },
    {
      // Compatibility/grouping tags — the same value sits on a tool and on the
      // consumables that fit it, so this answers "what's in the 4.5in grinder
      // ecosystem". Options come from `product.tagOptions` at runtime (free
      // text, so there's no static roster). `(none)` is the untagged worklist.
      columnId: "tags",
      field: "tagFilters",
      kind: "multiselect",
      placeholder: "Filter by tag...",
      optionsKey: "tags",
      nullable: { field: "tagsPresenceFilter", label: "tags" },
    },
  ],

  meal: [
    {
      columnId: "mealType",
      kind: "multiselect",
      placeholder: "Filter by meal type...",
      options: mealTypeOptions,
      nullable: { field: "mealTypePresenceFilter", label: "meal type" },
    },
    {
      columnId: "mealKind",
      kind: "multiselect",
      placeholder: "Filter by kind...",
      options: mealKindOptions,
    },
    {
      columnId: "recipeCostCoverage",
      field: "recipeCostCoverage",
      kind: "select",
      placeholder: "Filter recipe cost coverage...",
      options: [{ value: "understated", label: "Understated" }],
    },
  ],
  recipe: [
    {
      columnId: "name",
      field: "nameFilter",
      kind: "text",
      placeholder: "Filter by recipe name...",
    },
    {
      // Already array-shaped server-side (`recipe.tags && tagFilters`, a
      // Postgres array overlap — i.e. ANY/OR semantics), so this is the
      // cheapest column to give a real multi-select control to.
      columnId: "tags",
      field: "tagFilters",
      kind: "multiselect",
      placeholder: "Filter by tag...",
      optionsKey: "tags",
      nullable: { field: "tagsPresenceFilter", label: "tags" },
    },
    {
      // The Source column renders the cookbook link (RecipeSourceLink) for
      // book recipes; this scopes it to one or more cookbooks.
      columnId: "source",
      field: "cookbookId",
      kind: "idMulti",
      brand: unsafeCookbookId,
      placeholder: "Filter by cookbook...",
      optionsKey: "cookbook",
      nullable: { field: "cookbookPresenceFilter", label: "cookbook" },
    },
    {
      // "none" is the never-planned worklist. A live MealRecipe under a
      // soft-deleted Meal doesn't count.
      columnId: "meals",
      field: "mealPresenceFilter",
      kind: "presence",
      placeholder: "Filter meals...",
      options: presenceFilterOptions("meals"),
    },
    {
      columnId: "image",
      field: "imagePresenceFilter",
      kind: "presence",
      placeholder: "Filter images...",
      options: presenceFilterOptions("image"),
    },
    {
      columnId: "instructions",
      field: "instructionsPresenceFilter",
      kind: "presence",
      placeholder: "Filter instructions...",
      options: presenceFilterOptions("instructions"),
    },
    {
      columnId: "sourceType",
      field: "sourceTypeFilter",
      kind: "multiselect",
      placeholder: "Filter by source...",
      options: recipeSourceOptions,
      nullable: { field: "sourceTypePresenceFilter", label: "source" },
    },
    {
      columnId: "costTotal",
      kind: "range",
      placeholder: "Filter recipe cost...",
      options: recipeCostOptions,
      expand: resolveRecipeCost,
    },
    {
      columnId: "caloriesTotal",
      kind: "range",
      placeholder: "Filter calories...",
      options: calorieOptions,
      expand: resolveCalories,
    },
    {
      columnId: "totalMinutes",
      kind: "range",
      placeholder: "Filter total time...",
      options: recipeTotalTimeOptions,
      expand: resolveRecipeTotalTime,
    },
  ],

  ingredient: [
    {
      columnId: "name",
      field: "nameFilter",
      kind: "text",
      placeholder: "Filter by ingredient name...",
    },
    {
      columnId: "product",
      field: "productPresenceFilter",
      kind: "presence",
      placeholder: "Filter product...",
      options: presenceFilterOptions("product"),
    },
    {
      // "none" is the orphaned-ingredient worklist — the list already excludes
      // recipe-as-ingredient pointer rows, so a hit really is unused.
      columnId: "ownRecipes",
      field: "ownRecipePresenceFilter",
      kind: "presence",
      placeholder: "Filter own recipes...",
      options: presenceFilterOptions("own recipes"),
    },
    {
      // "none" is the orphaned-ingredient worklist — the list already excludes
      // recipe-as-ingredient pointer rows, so a hit really is unused.
      columnId: "appearsInRecipes",
      field: "recipePresenceFilter",
      kind: "presence",
      placeholder: "Filter recipes...",
      options: presenceFilterOptions("recipes"),
    },
  ],

  inventory: [
    {
      // Exact deep-link scope from an Inventory detail page. The visible
      // Product column keeps its human-friendly name search below.
      columnId: "productId",
      field: "productIdFilter",
      urlOnly: true,
      kind: "id",
      brand: unsafeProductId,
      placeholder: "Filter by product id...",
    },
    {
      // Exact deep-link scope from an Inventory detail page. Location names
      // are not unique, so the readable column filter cannot stand in for it.
      columnId: "locationId",
      field: "locationIdFilter",
      urlOnly: true,
      kind: "id",
      brand: unsafeLocationId,
      placeholder: "Filter by location id...",
    },
    {
      columnId: "product",
      field: "productNameFilter",
      kind: "text",
      placeholder: "Filter by product...",
    },
    {
      columnId: "location",
      field: "locationNameFilter",
      kind: "text",
      placeholder: "Filter by location...",
    },
    {
      columnId: "manufacturer",
      field: "manufacturerFilter",
      kind: "text",
      placeholder: "Filter by manufacturer...",
    },
    {
      columnId: "category",
      field: "categoryFilter",
      kind: "multiselect",
      placeholder: "Filter by category...",
      options: productCategoryOptionsWithTheme,
    },
    {
      columnId: "verifiedAt",
      kind: "range",
      placeholder: "Filter verification date...",
      options: [...presenceFilterOptions("verification"), ...dateRangeOptions],
      expand: resolveVerifiedDate,
    },
    {
      // Tri-state on purpose, and the server defaults an omitted value to
      // "stock" rather than treating it as unrestricted — see
      // `inventoryPlacementFilter` in @cubby/schemas/inventory. The chip is how
      // you get back to the fixtures the browse contract hides.
      columnId: "placement",
      field: "placementFilter",
      kind: "select",
      placeholder: "Filter placement...",
      options: [
        { value: "stock", label: "Stock" },
        { value: "installed", label: "Installed" },
        { value: "all", label: "Stock and installed" },
      ],
    },
    {
      columnId: "locationRole",
      field: "locationRole",
      kind: "select",
      placeholder: "Filter location role...",
      options: [{ value: "global_unknown", label: "Global Unknown" }],
    },
    {
      columnId: "valuationStatus",
      field: "valuationStatus",
      kind: "select",
      placeholder: "Filter valuation...",
      options: [
        { value: "valued", label: "Valued" },
        { value: "missing", label: "Missing valuation" },
        {
          value: "missing_with_priced_product",
          label: "Missing despite product price",
        },
      ],
    },
  ],

  location: [
    {
      columnId: "image",
      field: "imagePresenceFilter",
      kind: "presence",
      placeholder: "Filter images...",
      options: presenceFilterOptions("image"),
    },
    {
      // Presets rather than a date range: the predicate is "older than N days
      // OR never", which no From/To pair expresses — and a relative bound is
      // the only shape a saved view can pin, since an absolute date computed
      // from the browser clock changes daily.
      columnId: "lastBulkInventory",
      kind: "range",
      placeholder: "Filter recounts...",
      options: recountAgeOptions,
      expand: resolveRecountAge,
    },
    {
      // "none" is the leaf-location worklist; with `inventoryEntries: none`
      // it's an empty leaf — nothing in it, and not a shelf for other bins.
      columnId: "children",
      field: "childPresenceFilter",
      kind: "presence",
      placeholder: "Filter children...",
      options: presenceFilterOptions("children"),
    },
    {
      // "none" alongside `image: has` is the describable backlog — there's
      // nothing to describe about a location with no photo.
      columnId: "aiDescription",
      field: "aiDescriptionPresenceFilter",
      kind: "presence",
      placeholder: "Filter descriptions...",
      options: presenceFilterOptions("description"),
    },
    {
      columnId: "name",
      field: "nameFilter",
      kind: "text",
      placeholder: "Filter by location name...",
    },
    {
      columnId: "type",
      field: "itemTypeFilter",
      kind: "multiselect",
      placeholder: "Filter by type...",
      options: locationTypeOptionsWithTheme,
    },
    {
      // Which SKU a location IS. "none" is the structural remainder — rooms,
      // areas and drawers, the locations you never bought as a thing.
      columnId: "product",
      field: "productId",
      kind: "idMulti",
      brand: unsafeProductId,
      placeholder: "Filter product...",
      optionsKey: "locationProducts",
      nullable: { field: "productPresenceFilter", label: "product" },
    },
    {
      // Matches direct children only — this is what the Parent column
      // literally shows on each row. There's no location-side descendant walk
      // (unlike projects' `collectDescendantIds`); subtree scoping would be a
      // separate, larger change.
      columnId: "parent",
      field: "parentId",
      kind: "idMulti",
      brand: unsafeLocationId,
      placeholder: "Filter parent...",
      optionsKey: "parentLocation",
      nullable: { field: "parentPresenceFilter", label: "parent" },
    },
    {
      // "none" is the empty-shelf worklist. Counts only entries whose product
      // is live, matching what the cell renders (it drops deleted products).
      columnId: "inventoryEntries",
      kind: "range",
      placeholder: "Filter inventory...",
      options: expenseCountOptions.map((option) => ({
        ...option,
        label: option.label.replace("expenses", "items"),
      })),
      expand: resolveLocationItems,
    },
    {
      columnId: "valuation",
      kind: "range",
      placeholder: "Filter valuation...",
      options: netBasisOptions,
      expand: resolveLocationValuation,
    },
  ],

  image: [
    {
      columnId: "filename",
      field: "nameFilter",
      kind: "text",
      placeholder: "Filter by filename...",
    },
    {
      columnId: "status",
      kind: "multiselect",
      placeholder: "Filter by upload status...",
      options: imageStatusOptions,
    },
    {
      columnId: "entity",
      field: "referencePresenceFilter",
      kind: "presence",
      placeholder: "Filter references...",
      options: presenceFilterOptions("reference"),
    },
  ],

  project: [
    {
      columnId: "image",
      field: "imagePresenceFilter",
      kind: "presence",
      placeholder: "Filter images...",
      options: presenceFilterOptions("image"),
    },
    {
      columnId: "name",
      // `columnId` is what the client-side filter matches (the Name column);
      // `field` is what would reach the server if this table ever moves to
      // `useEntityList`. They differ here — `projectFilterFields` calls it
      // `search`, not `name` — so without this the filter would silently do
      // nothing on that day, which is exactly the wrong-but-plausible failure
      // the manifest-vs-schema test now pins.
      field: "search",
      kind: "text",
      placeholder: "Filter by project name...",
    },
    {
      columnId: "status",
      urlKey: "statuses",
      kind: "multiselect",
      placeholder: "Filter by status...",
      options: PROJECT_STATUS_OPTIONS,
    },
    {
      columnId: "kind",
      urlKey: "kinds",
      kind: "multiselect",
      placeholder: "Filter by kind...",
      options: projectKindOptions,
    },
    {
      columnId: "attention",
      kind: "select",
      placeholder: "Filter tracker attention...",
      options: [
        { value: "stalled", label: "Stalled" },
        { value: "missing_budget", label: "Missing budget" },
        {
          value: "blocked_no_next_action",
          label: "Blocked with no next action",
        },
      ],
    },
    {
      columnId: "locations",
      field: "location",
      urlKey: "locations",
      kind: "multiselect",
      placeholder: "Filter by location...",
      optionsKey: "projectLocations",
    },
    {
      columnId: "dateRange",
      urlKey: "date",
      urlOnly: true,
      kind: "range",
      placeholder: "Filter by project activity...",
      options: dateRangeOptions,
      expand: resolveDateRange,
    },
    {
      columnId: "completionYear",
      urlKey: "completed",
      urlOnly: true,
      kind: "select",
      placeholder: "Filter by completion year...",
      optionsKey: "projectCompletionYears",
    },
    {
      columnId: "parent",
      field: "parentProjectId",
      kind: "idMulti",
      brand: unsafeProjectId,
      placeholder: "Filter by parent project...",
      optionsKey: "project",
      nullable: {
        field: "parentProjectPresenceFilter",
        label: "parent project",
      },
    },
  ],

  wish: [
    {
      columnId: "name",
      field: "search",
      urlKey: "q",
      kind: "text",
      placeholder: "Search wishlist...",
    },
    {
      columnId: "acquired",
      kind: "boolean",
      placeholder: "Filter by status...",
      options: [
        { value: "false", label: "Wanted" },
        { value: "true", label: "Acquired" },
      ],
    },
  ],
};

const NO_FILTERS: readonly FilterSpec[] = [];

/** The declared specs for an entity, or nothing for an opted-out one. */
const declaredFilters = (entity: Entity): readonly FilterSpec[] =>
  entity in ENTITIES_WITHOUT_FILTERS
    ? NO_FILTERS
    : entityFilters[entity as FilteredEntity];

/** The specs for an entity, or an empty list when it has no list table. */
const relatedFilterSpecs = Object.fromEntries(
  uniq(relatedViewRegistry.map((view) => view.source)).map((entity) => {
    const existing = declaredFilters(entity);
    const existingColumns = new Set(existing.map((spec) => spec.columnId));
    const generated: FilterSpec[] = [];
    for (const view of relatedViewRegistry.filter(
      (candidate) => candidate.source === entity,
    )) {
      const prefix = relatedFilterPrefix(view);
      // Product provenance is most useful as an exact Vendor roster filter,
      // not as a free-text match on the rendered preview. Keep the control on
      // the related column itself so its header, URL state, and server
      // predicate are one piece of state. Other relationship filters retain
      // their generated text/id/presence trio until they gain their own
      // target-aware picker.
      if (view.key === "product.vendors") {
        generated.push({
          columnId: `related:${view.key}`,
          field: `${prefix}Id`,
          urlKey: `related-${prefix}`,
          kind: "idMulti",
          brand: unsafeVendorId,
          placeholder: "Filter by vendor...",
          optionsKey: "productVendors",
          nullable: { field: "vendorPresenceFilter", label: "vendor" },
        });
        continue;
      }
      if (view.key === "product.projects") {
        generated.push({
          columnId: `related:${view.key}`,
          field: `${prefix}Id`,
          urlKey: `related-${prefix}`,
          kind: "idMulti",
          brand: unsafeProjectId,
          placeholder: "Filter by project...",
          optionsKey: "project",
          nullable: { field: "projectPresenceFilter", label: "project" },
        });
        continue;
      }
      if (view.key === "product.purchases") {
        generated.push({
          columnId: `related:${view.key}`,
          field: `${prefix}Id`,
          urlKey: `related-${prefix}`,
          kind: "idMulti",
          brand: unsafePurchaseId,
          placeholder: "Filter by purchase...",
          optionsKey: "productPurchases",
          nullable: {
            field: `${prefix}PresenceFilter`,
            label: "purchase",
          },
        });
        continue;
      }
      if (view.key === "product.tasks") {
        generated.push({
          columnId: `related:${view.key}`,
          kind: "range",
          placeholder: "Filter tasks...",
          options: [
            ...presenceFilterOptions("task"),
            { value: "open", label: "Has open task" },
            ...taskStatusOptions,
            ...dueRangeOptions,
          ],
          expand: resolveProductTaskFilter,
        });
        // The deep-link scope the range control can't express. Every other
        // related view gets this from the generated trio; the `continue` above
        // skips it, which left `taskId` reachable from nowhere. No matching
        // `taskPresenceFilter` scope — `resolveProductTaskFilter` already
        // reaches that field, and a second URL writer for one server field is
        // a conflict, not a convenience.
        generated.push({
          columnId: `${prefix}Id`,
          urlOnly: true,
          kind: "idMulti",
          placeholder: `Filter by related ${view.label.toLowerCase()} id...`,
        });
        continue;
      }
      if (view.key === "purchase.projects") {
        generated.push({
          columnId: `related:${view.key}`,
          field: `${prefix}Id`,
          urlKey: `related-${prefix}`,
          kind: "idMulti",
          brand: unsafeProjectId,
          placeholder: "Filter by project...",
          optionsKey: "project",
          nullable: {
            field: `${prefix}PresenceFilter`,
            label: "project",
          },
        });
        generated.push(
          {
            columnId: `${prefix}Id`,
            urlOnly: true,
            kind: "idMulti",
            brand: unsafeProjectId,
            placeholder: "Filter by project id...",
          },
          {
            columnId: `${prefix}PresenceFilter`,
            urlOnly: true,
            kind: "presence",
            placeholder: "Filter project presence...",
          },
        );
        continue;
      }
      if (view.key === "wish.candidates") {
        // `candidateProductId`, not the generated `productId`: both predicates
        // mean "wishes naming this candidate", but only the former is the
        // wish repo's own `WishCandidate` EXISTS clause. The generated urlOnly
        // pair below stays so existing deep links keep working.
        generated.push({
          columnId: `related:${view.key}`,
          field: "candidateProductId",
          urlKey: `related-${prefix}`,
          kind: "idMulti",
          placeholder: "Filter by candidate product...",
          optionsKey: "wishCandidates",
          nullable: {
            field: `${prefix}PresenceFilter`,
            label: "candidate",
          },
        });
        generated.push(
          {
            columnId: `${prefix}Id`,
            urlOnly: true,
            kind: "idMulti",
            placeholder: "Filter by candidate product id...",
          },
          {
            columnId: `${prefix}PresenceFilter`,
            urlOnly: true,
            kind: "presence",
            placeholder: "Filter candidate presence...",
          },
        );
        continue;
      }
      if (view.key === "meal.recipes") {
        // Column-backed presence rather than the generated free-text trio.
        // `partitionFilterSpecs` keeps `urlOnly` specs out of `columnFilters`,
        // so the generated `recipePresenceFilter` could never be pinned by a
        // saved view — which is what the `meal/empty-cooked` view needs.
        //
        // A plain `presence` kind, not the `idMulti` + `nullable` shape
        // `recipe.ingredients` uses: that one carries an `optionsKey` roster,
        // and `MealTable` passes no `filterOptions` at all, so a roster-backed
        // picker would render empty. Same shape as `ingredient.appearsInRecipes`.
        generated.push({
          columnId: `related:${view.key}`,
          field: `${prefix}PresenceFilter`,
          urlKey: `related-${prefix}`,
          kind: "presence",
          placeholder: "Filter recipes...",
          options: presenceFilterOptions("recipes"),
        });
        // The deep-link scope, kept so existing links still resolve. No
        // matching presence scope — the column above already writes that field,
        // and a second URL writer for one server field is a conflict.
        generated.push({
          columnId: `${prefix}Id`,
          urlOnly: true,
          kind: "idMulti",
          placeholder: "Filter by related recipe id...",
        });
        continue;
      }
      if (view.key === "recipe.ingredients") {
        generated.push({
          columnId: `related:${view.key}`,
          field: `${prefix}Id`,
          urlKey: `related-${prefix}`,
          kind: "idMulti",
          brand: unsafeIngredientId,
          placeholder: "Filter by ingredient...",
          optionsKey: "recipeIngredients",
          nullable: {
            field: `${prefix}PresenceFilter`,
            label: "ingredient",
          },
        });
        continue;
      }
      const candidates: FilterSpec[] = [
        {
          columnId: `related:${view.key}`,
          field: `${prefix}Search`,
          urlKey: `related-${prefix}`,
          kind: "text",
          placeholder: `Search related ${view.label.toLowerCase()}...`,
        },
        {
          columnId: `${prefix}Id`,
          urlOnly: true,
          kind: "idMulti",
          placeholder: `Filter by related ${view.label.toLowerCase()} id...`,
        },
        {
          columnId: `${prefix}PresenceFilter`,
          urlOnly: true,
          kind: "presence",
          placeholder: `Filter related ${view.label.toLowerCase()} presence...`,
        },
      ];
      for (const candidate of candidates) {
        if (!existingColumns.has(candidate.columnId)) {
          existingColumns.add(candidate.columnId);
          generated.push(candidate);
        }
      }
    }
    return [entity, generated] as const;
  }),
) as Partial<Record<Entity, readonly FilterSpec[]>>;

const filterSpecCache = new Map<Entity, readonly FilterSpec[]>();
export const getEntityFilters = (entity: Entity): readonly FilterSpec[] => {
  const cached = filterSpecCache.get(entity);
  if (cached) return cached;
  const specs = [
    ...declaredFilters(entity),
    ...(relatedFilterSpecs[entity] ?? []),
    ...(auditFilterEntities.has(entity)
      ? entity === "image"
        ? imageAuditFilterSpecs
        : auditFilterSpecs
      : []),
  ];
  filterSpecCache.set(entity, specs);
  return specs;
};

/**
 * The `FilterConfig` for one column, straight from the manifest.
 *
 * `useStandardColumns` applies this to every column automatically. Tables that
 * bypass that hook (the embedded project-detail tables, which call `useTable`
 * over a caller-supplied array) call it explicitly through
 * their column factories, so their controls match the index pages' instead of
 * silently staying single-select.
 */
export function manifestFilterConfig(
  entity: Entity,
  columnId: string,
  runtimeOptions?: RuntimeFilterOptions,
): FilterConfig | undefined {
  const spec = getEntityFilters(entity).find((s) => s.columnId === columnId);
  if (!spec) return undefined;
  // A urlOnly spec has no column state to bind to: `partitionFilterSpecs` keeps
  // it out of `columnFilters`, so a header control for one can neither read its
  // current value nor write a new one. Handing back a config anyway renders an
  // inert combobox over an empty option list — which is exactly what the
  // transactions table's Account and Purchase headers did, silently, because
  // those two specs happen to share a columnId with a rendered column. Every
  // other urlOnly spec escaped only by not colliding with one.
  if (spec.urlOnly) return undefined;
  return specFilterConfig(spec, runtimeOptions);
}

/** A spec's rendered options: runtime roster or static list, sentinels first. */
function resolveSpecOptions(
  spec: FilterSpec,
  runtimeOptions?: RuntimeFilterOptions,
): FilterableComboboxItem[] {
  // A runtime picklist (project roster, tag universe) can't be static module
  // data, so the caller injects it by key.
  const resolved = spec.optionsKey
    ? filterOptionItems(runtimeOptions?.[spec.optionsKey])
    : (spec.options ?? []);
  // Sentinels come first so they're reachable without scrolling a long roster.
  return spec.nullable
    ? [...nullableSentinelOptions(spec.nullable.label), ...resolved]
    : resolved;
}

function specFilterConfig(
  spec: FilterSpec,
  runtimeOptions?: RuntimeFilterOptions,
): FilterConfig {
  const deferred = spec.optionsKey
    ? deferredFilterOptionSource(runtimeOptions?.[spec.optionsKey])
    : undefined;
  return {
    placeholder: spec.placeholder,
    filterType: filterTypeForKind(spec.kind),
    options: resolveSpecOptions(spec, runtimeOptions),
    onActivate: deferred?.onActivate,
    onSearchChange: deferred?.onSearchChange,
    isLoading: deferred?.isLoading,
  };
}

/**
 * Chip-bar fields straight from a spec list, for a bar with no table under it.
 *
 * The table path derives its fields by walking mounted columns for
 * `meta.filterConfig`; this one skips the column layer entirely. Both end at
 * `barFieldFromConfig`, so the two bars can't drift in operator set, option
 * shape, or searchability.
 *
 * `urlOnly` specs are skipped for the same reason `manifestFilterConfig`
 * returns undefined for them: there is no state a control could bind to.
 */
export function manifestFilterFields(
  specs: readonly FilterSpec[],
  runtimeOptions?: RuntimeFilterOptions,
): FilterBarField[] {
  return specs
    .filter((spec) => !spec.urlOnly)
    .map((spec) =>
      barFieldFromConfig(
        spec.columnId,
        spec.label ?? humanize(spec.columnId),
        specFilterConfig(spec, runtimeOptions),
      ),
    );
}

/**
 * `validateSearch` fragment for an entity's filter params.
 *
 * A route with a strict `z.object` schema strips any key it doesn't declare —
 * so without this, `useTableState` writes a filter to the URL and the router
 * removes it again before anything can read it back. Derived from the manifest
 * rather than hand-listed per route, so a new spec can't be forgotten here.
 *
 * Every value is a {@link urlStringParam}: sets are comma-joined, and the enums
 * are validated where they're consumed (`decodeFilters` →
 * `buildFiltersFromManifest` → the tRPC input schema). Routes that ALSO
 * re-declare a key by name (for `<Link search>` literal key types) must use it
 * there too — a bare `z.string()` reinstates the silently-dropped-value hole
 * that schema exists to close.
 */
export { entityFilterSearchFields } from "./filter-search-fields";
