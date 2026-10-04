// Not "@cubby/shared": its index reaches generated files, and this module is imported by the
// generator before they exist.
import { mapRecord } from "../../shared/src/record";
import {
  EXPENSE_DISPOSITION_COST_TYPE,
  EXPENSE_DISPOSITION_EDITOR,
} from "./expense-fields";
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

/**
 * Control renderers whose value is an object or array the generic structured-value editor draws
 * from the field's `valueSchema` (derived from its Zod input schema by `pnpm generate`), so none
 * has a per-renderer view path. Classified `generic` below; the generator refuses a field here
 * whose input schema it cannot describe.
 */
export const STRUCTURED_VALUE_RENDERERS = [
  "external-ids",
  "label-nutrition",
  "source-aliases",
  "source-refs",
  "unit-mappings",
] as const satisfies readonly ControlRendererId[];

export const nativeCoverage = {
  /**
   * Specialized control renderers; `generic` ones draw as their `controlKind` primitive or, for
   * `STRUCTURED_VALUE_RENDERERS`, from the field's declared `valueSchema`.
   */
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
    ...generic(STRUCTURED_VALUE_RENDERERS),
    // Native edits a structured field only where web also edits it and a golden read-to-input
    // vector proves the round trip (`structured-roundtrip.json`). Web draws none of these.
    ...unsupported(
      ["structured-field"],
      "Web has no editor for this structured field; native shows it read-only.",
    ),
    // Web splits `collection:*` entries from compatibility tags; native shows the raw list.
    ...unsupported(["product-tags"], "Tags and Collections are edited on web."),
    // The editor's image block owns image ordering; it is never a field control.
    ...ownedElsewhere(["image-order"]),
  },
  list: {
    ...implemented([
      "recipe-source",
      "spending-category-summary",
      "data-quality",
    ]),
    // Drawn from the field's declared `display.labelPath`: the server-composed figure (a rule
    // computed once, not per client) or the display name of the record a cell links to. The rich
    // web cell (tooltip, pill, link, workbench) stays web-only; the fact it carries does not.
    ...generic([
      "estimate-cost",
      "estimate-kcal",
      "financial-settlement",
      "reconciliation-status",
      "valuation-summary",
      "tag-links",
      "recipe-links",
      "product-link",
      "usda-food-link",
      "vendor-cell",
      "order-link",
      "possible-vendor",
    ]),
    // The Image row IS the picture: native draws it as the row thumbnail.
    ...ownedElsewhere(["uploaded-image"]),
  },
  detail: {
    // Drawn by the one generic detail row from what the declaration says to read: a reference,
    // `valueOptions` labels (`financial-account-identity` via `readPath`, `ledger-transfer-
    // classification`), the server-composed `detailLabelPath` text (`financial-transaction-
    // vendor-inference`), or the `itemsPath` rows (`wish-candidates`). The richer web cell
    // (filter link, pill, thumbnails) stays web-only; the fact it carries does not.
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
      "financial-account-identity",
      "financial-transaction-vendor-inference",
      "ledger-transfer-classification",
      "wish-candidates",
    ]),
    ...implemented([
      "recipe-source",
      "expense-spending-category",
      "spending-category-summary",
    ]),
    // `ImageEntityDetailView` draws Image's Provenance map row (`image-capture-location`) and
    // "In libraries" rows (`image-sightings`) itself; Image never uses the generic detail view,
    // so these are reachable only defensively.
    ...ownedElsewhere([
      "effectiveOwnership",
      "image-capture-location",
      "image-sightings",
    ]),
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

/**
 * A literal body value. Only a string starting `$row.` (the row's `id`) or `$field.` (a form
 * field's key) is a slot the runner fills; any other string, `$` or not, is literal.
 */
export type HeroActionBodyValue =
  | string
  | number
  | boolean
  | null
  | readonly HeroActionBodyValue[]
  | { readonly [key: string]: HeroActionBodyValue };

/** One input the runner asks for. Everything else in the request body is the plan's literal. */
type HeroActionField = {
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
      /** The editor's title and guidance when the capture is not a plain "New <entity>". */
      readonly editor?: {
        readonly title: string;
        readonly description: string;
      };
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
        quantity: "$field.quantity",
        adjustInventory: "$field.adjustInventory",
        inventoryEntryId: "$field.inventoryEntryId",
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
      quantity: "$field.quantity",
      trade: "$field.trade",
      date: "$field.date",
      reason: "$field.reason",
      adjustInventory: "$field.adjustInventory",
      inventoryEntryId: "$field.inventoryEntryId",
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
    preview: {
      operation: "product.addToInventoryPreview",
      body: { productId: "$row.id", locationId: "$field.location" },
    },
    fields: [
      { key: "location", label: "Location", kind: "location" },
      { key: "amount", label: "Amount", kind: "amount", default: "one" },
    ],
    body: {
      locationId: "$field.location",
      items: [{ productId: "$row.id", amount: "$field.amount" }],
    },
  },
  recordSale: {
    label: "Record sale",
    symbol: "dollarsign.circle",
    kind: "create",
    entity: "expense",
    entities: ["product"],
    // A disposition expense: attributed to no project, filed under tools, in the editor web
    // titles "Record Sale or Disposal" (its `disposition` context).
    seed: {
      productId: "$row.id",
      projectId: null,
      costType: EXPENSE_DISPOSITION_COST_TYPE,
    },
    editor: EXPENSE_DISPOSITION_EDITOR,
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
  control: 2,
  list: 0,
  detail: 0,
  heroAction: 0,
  detailSlot: 38,
  listSlot: 0,
} as const satisfies Record<NativeCoverageKind, number>;
