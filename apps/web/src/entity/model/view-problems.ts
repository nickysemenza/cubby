import { entitySchema, type Entity } from "@cubby/schemas/entity";
import { entityKeys, entitySummary } from "@cubby/schemas/entity-summary";
import { PROBLEM_CLASS } from "@cubby/schemas/problems";

import { FILTER_NONE } from "~/entity/filters";

import {
  defineProblem,
  type EntityProblemSource,
  type ProblemQuery,
  validateProblemQueries,
} from "../problems/problem-query";
import { toViewDefinition, type ViewDefinition } from "./view-manifest";

/** Server Problems owns the aggregate declaration roster; browser views use one slice. */
export const viewManifest = Object.fromEntries(
  entityKeys.map((entity) => [
    entity,
    entitySummary[entity].list.savedViews.map(toViewDefinition),
  ]),
);
const isEntity = (value: string): value is Entity =>
  entitySchema.safeParse(value).success;

/** A view that also declares a Problems section, paired with its entity. */
export interface ViewProblemDeclaration {
  entity: Entity;
  viewId: string;
  sort: ViewDefinition["sort"];
  problem: ProblemQuery;
}

/**
 * Every problem-backed view, flattened.
 *
 * The single roster the Problems service iterates to run its list queries and
 * and the canonical Problem Query registry. Derived from `viewManifest` rather than
 * hand-listed, so declaring a view IS declaring the section — there is no
 * second place to register it and therefore no way for the two to disagree.
 */
export function viewProblemDeclarations(): ViewProblemDeclaration[] {
  const declarations = Object.entries(viewManifest).flatMap(
    ([entity, views]) =>
      !isEntity(entity)
        ? []
        : (views ?? []).flatMap((view) => {
            if (!("problem" in view) || !view.problem) return [];
            const problem = view.problem;
            if (!problem) return [];
            const viewSort = "sort" in view ? view.sort : undefined;
            const viewLayout = "layout" in view ? view.layout : undefined;
            const source: EntityProblemSource = {
              kind: "entity",
              entity,
              filters: view.filters,
            };
            if (viewSort) source.sort = viewSort;
            if (viewLayout?.columnVisibility) {
              source.columnVisibility = viewLayout.columnVisibility;
            }
            return [
              {
                entity,
                viewId: view.id,
                sort: viewSort,
                problem: defineProblem({
                  ...problem,
                  problemClass: PROBLEM_CLASS[problem.key],
                  executionLane: "views",
                  continuation: { kind: "entity-list" },
                  freshness: { kind: "live" },
                  source,
                }),
              },
            ];
          }),
  );
  validateProblemQueries(declarations.map(({ problem }) => problem));
  return declarations;
}

/**
 * Exact entity Problems that are not named saved views. They remain ordinary
 * filter assemblies; a dedicated view would only add a redundant tab to the
 * ledger while the Problems page is their intended entry point.
 */
const standaloneEntityProblems = [
  defineProblem({
    key: "purchaseFinancialSettlementMismatches",
    problemClass: PROBLEM_CLASS.purchaseFinancialSettlementMismatches,
    executionLane: "fast",
    continuation: { kind: "entity-list" as const },
    freshness: { kind: "live" as const },
    title: "Purchase financial settlement mismatches",
    description:
      "Purchase settlement evidence disagrees with the incurred expense total.",
    emptyMessage: "Every comparable purchase settlement reconciles.",
    source: {
      kind: "entity" as const,
      entity: "purchase" as const,
      filters: [{ id: "financialReconciliation", value: "mismatch" }],
    },
  }),
  defineProblem({
    key: "financialTransactionAllocationDefects",
    quality: {
      rowChecks: [
        {
          entity: "financialTransaction",
          check: "financial_transaction_allocation_integrity",
        },
      ],
    },
    problemClass: PROBLEM_CLASS.financialTransactionAllocationDefects,
    executionLane: "fast",
    continuation: { kind: "entity-list" as const },
    freshness: { kind: "live" as const },
    title: "Financial transaction allocation defects",
    description:
      "A transaction's settlement split doesn't add up, or points the wrong way — the amounts don't match the transaction, or a credit is recorded as a charge.",
    emptyMessage: "Every settlement allocation is internally consistent.",
    source: {
      kind: "entity" as const,
      entity: "financialTransaction" as const,
      filters: [
        {
          id: "dataGaps",
          value: ["financial_transaction_allocation_integrity"],
        },
      ],
      sort: [{ id: "postedDate", desc: true }],
    },
  }),
  defineProblem({
    key: "purchasesNotReconciling",
    problemClass: PROBLEM_CLASS.purchasesNotReconciling,
    executionLane: "fast",
    continuation: { kind: "entity-list" as const },
    freshness: { kind: "live" as const },
    title: "Purchases whose totals do not reconcile",
    description:
      "What a receipt says it totalled and what its recorded lines add up to differ by more than rounding.",
    emptyMessage: "Every purchase reconciles with its expense lines.",
    source: {
      kind: "entity" as const,
      entity: "purchase" as const,
      filters: [{ id: "reconciliation", value: ["mismatch"] }],
      sort: [{ id: "reconciliationGap", desc: true }],
    },
  }),
  defineProblem({
    key: "unlinkedExitExpenses",
    problemClass: PROBLEM_CLASS.unlinkedExitExpenses,
    executionLane: "fast",
    continuation: { kind: "entity-list" as const },
    freshness: { kind: "live" as const },
    title: "Productless lines in disposal purchases",
    description:
      "Negative itemized principal lines without a product link. Some describe intentionally untracked goods; review them as provenance coverage.",
    emptyMessage:
      "No itemized principal disposal line is missing a product link.",
    source: {
      kind: "entity" as const,
      entity: "expense" as const,
      filters: [
        { id: "future", value: "false" },
        { id: "costSign", value: "negative" },
        { id: "lineKind", value: ["principal"] },
        { id: "lineBasis", value: ["item_line"] },
        { id: "productId", value: "none" },
        { id: "disposalPurchasePresenceFilter", value: "has" },
      ],
      sort: [{ id: "date", desc: true }],
    },
  }),
  defineProblem({
    key: "purchaselessExitExpenses",
    problemClass: PROBLEM_CLASS.purchaselessExitExpenses,
    executionLane: "fast",
    continuation: { kind: "entity-list" as const },
    freshness: { kind: "live" as const },
    title: "Possible exits without a purchase",
    description:
      "Money that came back in — a sale or refund — recorded against neither a product nor an order, so there's no telling what left the house.",
    emptyMessage: "Every recorded sale or refund traces back to an order.",
    source: {
      kind: "entity" as const,
      entity: "expense" as const,
      filters: [
        { id: "future", value: "false" },
        { id: "costSign", value: "negative" },
        { id: "productId", value: "none" },
        { id: "purchaseId", value: [FILTER_NONE] },
        { id: "lineKind", value: ["principal"] },
        { id: "lineBasis", value: ["item_line"] },
      ],
      sort: [{ id: "date", desc: true }],
    },
  }),
  defineProblem({
    key: "pastDuePlannedExpenses",
    problemClass: PROBLEM_CLASS.pastDuePlannedExpenses,
    executionLane: "tracker",
    continuation: { kind: "entity-list" as const },
    freshness: { kind: "live" as const },
    title: "Past-due planned expenses",
    description: "Planned expenses dated before the household's current day.",
    emptyMessage: "No planned expenses are past due.",
    source: {
      kind: "entity" as const,
      entity: "expense" as const,
      filters: [
        { id: "future", value: "true" },
        { id: "date", value: "..@today-1d" },
      ],
      sort: [{ id: "date", desc: false }],
    },
  }),
  defineProblem({
    key: "productsWithNoImages",
    problemClass: PROBLEM_CLASS.productsWithNoImages,
    executionLane: "fast",
    continuation: { kind: "entity-list" as const },
    freshness: { kind: "live" as const },
    title: "Products with no images",
    // `product_image`'s own `expected` is "has inventory" (checks/product.ts)
    // — STOCKED products, regardless of ingredient link. NARROWER than the old
    // predicate for a non-stocked, non-ingredient product with no image (now
    // excluded), and WIDER for a stocked product that IS an ingredient (now
    // included, where it used to be excluded). See the migration note in this
    // lane's report for the population delta.
    description: "Non-ingredient products with no displayable image.",
    emptyMessage: "Every standalone product has an image.",
    source: {
      kind: "entity" as const,
      entity: "product" as const,
      filters: [{ id: "dataGaps", value: ["product_image"] }],
      sort: [{ id: "createdAt", desc: false }],
      columnVisibility: { image: true, ingredient: true },
    },
  }),
  defineProblem({
    key: "duplicateInventory",
    problemClass: PROBLEM_CLASS.duplicateInventory,
    executionLane: "fast",
    continuation: { kind: "entity-list" as const },
    freshness: { kind: "live" as const },
    title: "Products recorded twice",
    description:
      "Single-unit products duplicated within stock or installed placement.",
    emptyMessage: "No single-unit products are duplicated within a placement.",
    source: {
      kind: "entity" as const,
      entity: "product" as const,
      filters: [{ id: "inventoryMultiplicity", value: "true" }],
      sort: [{ id: "name", desc: false }],
      columnVisibility: { ledgerExpectedQuantity: true, location: true },
    },
  }),
  defineProblem({
    key: "soldButStillStocked",
    problemClass: PROBLEM_CLASS.soldButStillStocked,
    executionLane: "fast",
    continuation: { kind: "entity-list" as const },
    freshness: { kind: "live" as const },
    title: "Disposed but still on hand",
    description:
      "A recorded disposal closed the known quantity while inventory remains on hand.",
    emptyMessage: "No disposed products remain in inventory.",
    source: {
      kind: "entity" as const,
      entity: "product" as const,
      filters: [{ id: "ownershipReconciliation", value: "true" }],
      sort: [{ id: "updatedAt", desc: true }],
      columnVisibility: { ledgerExpectedQuantity: true, location: true },
    },
  }),
  defineProblem({
    key: "kitsCountedTwice",
    problemClass: PROBLEM_CLASS.kitsCountedTwice,
    executionLane: "fast",
    continuation: { kind: "entity-list" as const },
    freshness: { kind: "live" as const },
    title: "Kits counted twice",
    description:
      "Stocked under its own name and by its components, together accounting for more units than were bought.",
    emptyMessage: "No kit is counted twice.",
    source: {
      kind: "entity" as const,
      entity: "product" as const,
      filters: [{ id: "kitAccounting", value: "true" }],
      sort: [{ id: "updatedAt", desc: true }],
      columnVisibility: {
        ledgerExpectedQuantity: true,
        location: true,
        components: true,
      },
    },
  }),
  defineProblem({
    key: "unknownParkedItems",
    quality: {
      rowChecks: [{ entity: "inventory", check: "inventory_unknown_location" }],
    },
    problemClass: PROBLEM_CLASS.unknownParkedItems,
    executionLane: "fast",
    continuation: { kind: "entity-list" as const },
    freshness: { kind: "live" as const },
    title: "Items parked in Unknown",
    description: "Inventory in the household-wide Unknown location.",
    emptyMessage: "No inventory is parked in Unknown.",
    source: {
      kind: "entity" as const,
      entity: "inventory" as const,
      filters: [{ id: "locationRole", value: "true" }],
      sort: [{ id: "createdAt", desc: false }],
      columnVisibility: { location: true, placement: true },
    },
  }),
  defineProblem({
    key: "inventoryWithoutPricePath",
    problemClass: PROBLEM_CLASS.inventoryWithoutPricePath,
    executionLane: "fast",
    continuation: { kind: "entity-list" as const },
    freshness: { kind: "live" as const },
    title: "Inventory without a price path",
    description:
      "Inventory whose product has a price but whose stored unit cannot reach it.",
    emptyMessage: "Every priced product can value its inventory.",
    source: {
      kind: "entity" as const,
      entity: "inventory" as const,
      filters: [{ id: "valuationStatus", value: ["priceable"] }],
      sort: [{ id: "createdAt", desc: false }],
      columnVisibility: { valuation: true, product: true },
    },
  }),
  defineProblem({
    key: "understatedCostMeals",
    quality: {
      rowChecks: [{ entity: "meal", check: "meal_recipe_cost_incomplete" }],
    },
    problemClass: PROBLEM_CLASS.understatedCostMeals,
    executionLane: "fast",
    continuation: { kind: "entity-list" as const },
    freshness: { kind: "live" as const },
    title: "Meals with understated recipe cost",
    description:
      "Meals whose live recipes have incomplete priced ingredient coverage.",
    emptyMessage: "Every meal has complete recipe cost coverage.",
    source: {
      kind: "entity" as const,
      entity: "meal" as const,
      filters: [{ id: "recipeCostCoverage", value: "true" }],
      sort: [{ id: "date", desc: false }],
      columnVisibility: { recipes: true },
    },
  }),
] as const satisfies readonly ProblemQuery[];

/** All exact entity-grain Problem declarations currently migrated. */
export function entityProblemDeclarations(): readonly ProblemQuery[] {
  const definitions = [
    ...viewProblemDeclarations().map(({ problem }) => problem),
    ...standaloneEntityProblems,
  ];
  validateProblemQueries(definitions);
  return definitions;
}
