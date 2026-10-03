import { mapRecord } from "@cubby/shared";
import type { Entity } from "./entity-core";
import type {
  ControlRendererId,
  DetailRendererId,
  ListRendererId,
} from "./generated/entity-field-model.gen";
import type {
  DetailSlotId,
  entitySummary,
  ListSlotId,
} from "./generated/entity-summary.gen";

/**
 * The single, reviewed record of which manifest presentation ids the native
 * Apple app draws. `pnpm generate` writes it into the CubbyKit bundle
 * (`native-coverage.json`); `NativePresentationCoverage` reads status and
 * reason from there, and the web registries in `apps/web/src/entity/` keep
 * their own implementation maps.
 *
 * Every record is keyed by the generated id union, so adding a renderer, slot,
 * or hero action to a declaration is a type error here until it is classified.
 * `unsupported` is a deliberate, disclosed gap (the native screen shows the
 * reason); `NATIVE_UNSUPPORTED_CEILING` only shrinks.
 */
export type NativeCoverageEntry =
  | { readonly status: "implemented" | "generic" | "ownedElsewhere" }
  | { readonly status: "unsupported"; readonly reason: string };

type ListId = { [E in Entity]: ListRendererId<E> }[Entity];
type DetailId = { [E in Entity]: DetailRendererId<E> }[Entity];
type HeroActionId =
  (typeof entitySummary)[Entity]["detail"]["hero"]["actions"][number];
/** Slot ids are entity-qualified (`meal.nutrition`), as the Swift manifest spells them. */
type DetailSlotKey = { [E in Entity]: `${E}.${DetailSlotId<E>}` }[Entity];
type ListSlotKey = { [E in Entity]: `${E}.${ListSlotId<E>}` }[Entity];

export const NATIVE_COVERAGE_KINDS = [
  "control",
  "list",
  "detail",
  "heroAction",
  "detailSlot",
  "listSlot",
] as const;
export type NativeCoverageKind = (typeof NATIVE_COVERAGE_KINDS)[number];

const classify =
  <const Status extends "implemented" | "generic" | "ownedElsewhere">(
    status: Status,
  ) =>
  <const Id extends string>(ids: readonly Id[]) =>
    mapRecord(ids, () => ({ status }) as const);
const implemented = classify("implemented");
const generic = classify("generic");
const ownedElsewhere = classify("ownedElsewhere");
const unsupported = <const Id extends string>(
  ids: readonly Id[],
  reason: string,
) => mapRecord(ids, () => ({ status: "unsupported", reason }) as const);
const unsupportedEach = <const Id extends string>(
  ids: readonly Id[],
  reasonFor: (id: Id) => string,
) =>
  mapRecord(
    ids,
    (id) => ({ status: "unsupported", reason: reasonFor(id) }) as const,
  );

export const nativeCoverage = {
  /** Specialized control renderers; `generic` ones draw as their `controlKind` primitive. */
  control: {
    ...implemented([
      "amount",
      "entity-multi-select",
      "ledger-attributions",
      "tag-list",
      "vendor-name",
    ]),
    // `upc-lookup`/`usda-food` are plain text/number fields once their AI action strips away.
    ...generic(["entity-select", "money", "url", "upc-lookup", "usda-food"]),
    // The editor's image block owns image ordering; it is never a field control.
    ...ownedElsewhere(["image-order"]),
    ...unsupported(
      ["structured-field"],
      "Structured fields are available on web.",
    ),
    ...unsupportedEach(
      [
        "external-ids",
        "label-nutrition",
        "product-tags",
        "source-aliases",
        "source-refs",
        "unit-mappings",
      ],
      (id) => `No native control for ${id}; edit it on web.`,
    ),
  },
  list: {
    ...implemented([
      "recipe-source",
      "spending-category-summary",
      "data-quality",
    ]),
    ...unsupported(
      [
        "expected-quantity",
        "quantity-variance",
        "estimate-cost",
        "estimate-kcal",
        "total-time",
        "meal-cost",
        "unit-price",
        "valuation-summary",
        "financial-settlement",
        "reconciliation-status",
        "expense-count",
      ],
      "This computed figure is available on web.",
    ),
    ...unsupported(
      [
        "tag-links",
        "recipe-links",
        "product-link",
        "usda-food-link",
        "vendor-cell",
        "order-link",
        "possible-vendor",
      ],
      "This linked cell is available on web; the field reads as a reference natively.",
    ),
    ...unsupported(
      ["uploaded-image"],
      "The thumbnail is drawn from the row image natively.",
    ),
  },
  detail: {
    ...generic([
      "expense-project",
      "ownerLedgerPartyId",
      "ownershipMode",
      "product-category",
      "product-fdc-id",
      "product-external-ids",
      "product-id",
      "product-ingredient",
      "product-primary-gtin",
      "product-tags",
      "financial-transaction-allocations",
      "run-failure-details",
    ]),
    ...implemented([
      "recipe-source",
      "expense-spending-category",
      "spending-category-summary",
    ]),
    // `image-capture-location` is `ImageEntityDetailView`'s own Provenance map row; Image never
    // uses the generic detail view, so it is reachable only defensively.
    ...ownedElsewhere(["effectiveOwnership", "image-capture-location"]),
    ...unsupported(
      [
        "product-category-path",
        "financial-account-identity",
        "financial-account-source-aliases",
        "financial-account-card-numbers",
        "financial-transaction-source-refs",
        "financial-transaction-vendor-inference",
        "ledger-transfer-classification",
        "recipe-meta",
        "recipe-sections",
        "recipe-totals",
        "recipe-yield",
        "vendor-agent-hints",
        "wish-candidates",
        "image-provenance-evidence",
        "image-sightings",
      ],
      "This structured detail is available on web.",
    ),
  },
  /** `edit` stays in the screen toolbar; the other declared verbs have no native handler yet. */
  heroAction: {
    ...ownedElsewhere(["edit"]),
    ...unsupported(
      [
        "addToInventory",
        "bulkEdit",
        "delete",
        "discard",
        "markPurchased",
        "recordSale",
        "setStatus",
      ],
      "This action is available on web.",
    ),
  },
  /**
   * `implemented` slots are exactly the keys of `DetailSlotRegistry` in
   * `apps/apple/App/Shared/Browse/DetailSlots.swift` (asserted by a Swift test).
   */
  detailSlot: {
    ...implemented([
      "ledgerParty.wardrobe",
      "meal.nutrition",
      "run.import-controls",
      "run.photo-batch",
      "purchase.order-mail",
      "purchase.receiving",
      "vendor.order-mail",
      "vendorAccount.order-mail",
      "vendor.spending-classification",
      "productCategory.spending-classification",
      "product.ownership",
      "product.nutrition",
      "product.unit-mappings",
      "product.fits-with",
      "product.runs",
    ]),
    ...unsupported(
      [
        "cookbook.import-progress",
        "cookbook.toc",
        "expense.settlement",
        "image.associations",
        "ingredient.nutrition-product",
        "ingredient.recipe-usages",
        "location.ai-description",
        "location.contents-valuation",
        "meal.composition",
        "product.cookbooks",
        "product.labels",
        "product.recipe-appearances",
        "project.analytics",
        "project.budget",
        "project.contribution",
        "project.schedule",
        "purchase.financial-settlement",
        "purchase.project-allocation",
        "purchase.reconciliation",
        "purchase.runs",
        "recipe.workflow",
        "run.ai-usage",
        "run.changes",
        "run.import-agent-live",
        "run.import-agent-stopped",
        "run.import-approvals",
        "run.import-debug-log",
        "run.import-evidence",
        "run.import-findings",
        "run.import-prepared-orders",
        "run.import-progress-live",
        "run.import-progress-stopped",
        "run.import-purchases",
        "run.import-stats",
        "run.import-targets",
        "run.import-timeline",
        "run.live-progress",
        "vendorAccount.charge-search",
      ],
      "This detail is available on web.",
    ),
  },
  /**
   * `implemented` slots are exactly the keys of `ListSlotRegistry` in
   * `apps/apple/App/Shared/Browse/SpecialistListViews.swift`; `ownedElsewhere` ones are
   * covered by the generic list's own affordances and never selectable as a slot.
   */
  listSlot: {
    ...implemented([
      "location.gallery",
      "meal.calendar",
      "project.analytics",
      "task.board",
      "expense.analytics",
    ]),
    ...ownedElsewhere([
      "location.visualizations",
      "meal.nutrition",
      "productCategory.hierarchy",
      "project.overview",
      "project.schedule",
      "planting.schedule",
      "run.history",
      "task.agenda",
    ]),
  },
} as const satisfies {
  control: Record<ControlRendererId, NativeCoverageEntry>;
  list: Record<ListId, NativeCoverageEntry>;
  detail: Record<DetailId, NativeCoverageEntry>;
  heroAction: Record<HeroActionId, NativeCoverageEntry>;
  detailSlot: Record<DetailSlotKey, NativeCoverageEntry>;
  listSlot: Record<ListSlotKey, NativeCoverageEntry>;
};

/**
 * Reviewed count of `unsupported` ids per kind. It only shrinks: implement an
 * id natively, flip its status above, and lower the number. Raising it means a
 * new web-only declaration shipped without a native path and needs a
 * justification in review.
 */
export const NATIVE_UNSUPPORTED_CEILING = {
  control: 7,
  list: 19,
  detail: 15,
  heroAction: 7,
  detailSlot: 38,
  listSlot: 0,
} as const satisfies Record<NativeCoverageKind, number>;
