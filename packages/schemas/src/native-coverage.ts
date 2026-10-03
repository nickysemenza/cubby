// Not "@cubby/shared": its index reaches generated files, and this module is imported by the
// generator before they exist.
import { mapRecord } from "../../shared/src/record";
import { TRADE_LABELS, tradeValues } from "./task-fields";
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
  /**
   * `implemented` verbs each have a plan in `nativeHeroActionPlans` that the one generic runner
   * (`HeroActionRunner`) executes; `edit` stays in the screen toolbar.
   */
  heroAction: {
    ...implemented([
      "addToInventory",
      "delete",
      "discard",
      "markPurchased",
      "recordSale",
      "setStatus",
    ]),
    // `edit` is the toolbar's editor. `bulkEdit` is a list/multi-select verb: on a task's detail
    // hero it is the same field editor over one row, which the toolbar `edit` already is, and a
    // selection-wide edit has no row to anchor to on a detail screen.
    ...ownedElsewhere(["edit", "bulkEdit"]),
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

/** A literal body value, or a `$` slot the runner fills: `$row.id` or `$<field key>`. */
export type HeroActionBodyValue =
  | string
  | number
  | boolean
  | null
  | readonly HeroActionBodyValue[]
  | { readonly [key: string]: HeroActionBodyValue };

/** One input the runner asks for. Everything else in the request body is the plan's literal. */
export type HeroActionField = {
  readonly key: string;
  readonly label: string;
  readonly kind:
    | "number"
    | "text"
    | "date"
    | "toggle"
    | "choice"
    | "location"
    | "amount"
    /** Options come from the plan's preview (`shelves`), never a guess. */
    | "shelf";
  /** `today` seeds a date field; `one` seeds an amount with a single `each`. */
  readonly default?: string | number | boolean | "today" | "one";
  readonly options?: readonly {
    readonly value: string;
    readonly label: string;
  }[];
  /** An empty value is sent as null (otherwise the runner refuses to submit). */
  readonly optional?: boolean;
  /** Shown, and sent, only while this toggle field is on; otherwise null. */
  readonly showWhen?: string;
};

/**
 * What the one generic native hero-action runner (`HeroActionRunner`) does for a verb. The verb
 * is the manifest's hero action id; the plan names the operation (an HTTP operation id, so the
 * client is generated and `pnpm generate` fails when it is not flagged `native:`), the confirmation
 * the runner requires, and the input form. Nothing here is per entity: `entities` only gates which
 * declarations may offer the verb.
 */
export type NativeHeroActionPlan = {
  /** The menu title, sentence case (the web registry's label without its trailing `...`). */
  readonly label: string;
  /** An SF Symbol name. */
  readonly symbol: string;
} & (
  | {
      /** `resources.<entity>.delete`, behind the connection-impact preview. */
      readonly kind: "delete";
      readonly confirmation: "destructive";
      readonly preview: "entity.connections";
    }
  | {
      readonly kind: "operation";
      readonly operation: string;
      readonly entities: readonly Entity[];
      readonly confirmation: "none" | "destructive";
      /** A query that answers "what will this do?" with the current field values. */
      readonly preview?: {
        readonly operation: string;
        readonly body: HeroActionBodyValue;
      };
      readonly fields: readonly HeroActionField[];
      readonly body: HeroActionBodyValue;
    }
  | {
      /** Opens the generic create editor with the entity's fields pre-seeded. */
      readonly kind: "create";
      readonly entity: Entity;
      readonly entities: readonly Entity[];
      readonly seed: { readonly [field: string]: HeroActionBodyValue };
    }
  | {
      /** Picks a value for one declared enum field, then updates the row. */
      readonly kind: "setField";
      readonly entities: readonly Entity[];
      readonly field: string;
    }
  | {
      /** Flips a boolean update field whose current state is read from `stateField`. */
      readonly kind: "toggleField";
      readonly entities: readonly Entity[];
      readonly field: string;
      readonly stateField: string;
    }
);

const tradeOptions = tradeValues.map((value) => ({
  value,
  label: TRADE_LABELS[value],
}));

/**
 * Reviewed plans for the `implemented` hero actions; the keys are exactly those verbs
 * (asserted by the unit test). Emitted into `native-coverage.json`.
 */
export const nativeHeroActionPlans = {
  delete: {
    label: "Delete",
    symbol: "trash",
    kind: "delete",
    confirmation: "destructive",
    preview: "entity.connections",
  },
  discard: {
    label: "Discard",
    symbol: "minus.square",
    kind: "operation",
    operation: "product.discard",
    entities: ["product"],
    // Writes a ledger exit and, when asked, empties a shelf entry: never one tap.
    confirmation: "destructive",
    preview: {
      operation: "product.discardPreview",
      body: {
        productId: "$row.id",
        quantity: "$quantity",
        adjustInventory: "$adjustInventory",
        inventoryEntryId: "$inventoryEntryId",
      },
    },
    fields: [
      { key: "quantity", label: "Units discarded", kind: "number", default: 1 },
      {
        key: "trade",
        label: "Trade",
        kind: "choice",
        default: "other",
        options: tradeOptions,
      },
      // Required on the wire (nullable, no default): the generated client omits a nil optional
      // instead of sending null, so the form always sends a date.
      { key: "date", label: "Date", kind: "date", default: "today" },
      { key: "reason", label: "Reason", kind: "text", optional: true },
      {
        key: "adjustInventory",
        label: "Also take these units off the shelf",
        kind: "toggle",
        default: true,
      },
      {
        key: "inventoryEntryId",
        label: "Take from",
        kind: "shelf",
        optional: true,
        showWhen: "adjustInventory",
      },
    ],
    body: {
      productId: "$row.id",
      quantity: "$quantity",
      trade: "$trade",
      date: "$date",
      reason: "$reason",
      adjustInventory: "$adjustInventory",
      inventoryEntryId: "$inventoryEntryId",
    },
  },
  addToInventory: {
    label: "Add to inventory",
    symbol: "shippingbox",
    kind: "operation",
    operation: "inventory.bulkAdd",
    entities: ["product"],
    // An explicit, named stocking action; inventory never changes as a side effect.
    confirmation: "none",
    fields: [
      { key: "location", label: "Location", kind: "location" },
      { key: "amount", label: "Amount", kind: "amount", default: "one" },
    ],
    body: {
      locationId: "$location",
      items: [{ productId: "$row.id", amount: "$amount" }],
    },
  },
  recordSale: {
    label: "Record sale",
    symbol: "dollarsign.circle",
    kind: "create",
    entity: "expense",
    entities: ["product"],
    // A disposition expense: attributed to no project, filed under tools (the web seed).
    seed: { productId: "$row.id", projectId: null, costType: "tools" },
  },
  setStatus: {
    label: "Set status",
    symbol: "checklist",
    kind: "setField",
    entities: ["project"],
    field: "status",
  },
  markPurchased: {
    label: "Mark purchased",
    symbol: "checkmark.circle",
    kind: "toggleField",
    entities: ["wish"],
    field: "acquired",
    stateField: "acquiredAt",
  },
} as const satisfies Partial<Record<HeroActionId, NativeHeroActionPlan>>;

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
  heroAction: 0,
  detailSlot: 38,
  listSlot: 0,
} as const satisfies Record<NativeCoverageKind, number>;
