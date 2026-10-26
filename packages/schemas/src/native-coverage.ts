import { imageOut } from "./entity-definitions/field-primitives";
import { dataQuality } from "./data-quality-shape";
import { locationValuation } from "./location-fields";
import { recipeSource } from "./recipe-shared";
import { merchantVendorInference } from "./financial-transaction-fields";
import { projectRollup } from "./project-output-fields";
import { recipeTotals, recipeTopLevelFields } from "./recipe-shared";
import { listLabel } from "./entity-definitions/label-field";
import { runWorkProgress } from "./run-work-progress";
import { financialReconciliationSummary } from "./financial-reconciliation";
import { purchaseReconciliation } from "./purchase-fields";
import {
  purchaseShortcode,
  recipeShortcode,
  vendorShortcode,
} from "./identifier-fields";
import { imageUrlSummary } from "./image-summary";
import { foodSummary } from "@cubby/usda";
import { z } from "zod";
// Not "@cubby/shared": its index reaches generated files, and this module is imported by the
// generator before they exist.
import { mapRecord } from "../../shared/src/record";
import {
  EXPENSE_DISPOSITION_COST_TYPE,
  EXPENSE_DISPOSITION_EDITOR,
} from "./expense-fields";
import type { CollectionActionId } from "./entity-definitions/collection-actions";
import type { SectionActionId } from "./entity-section-actions";
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
 * `handoff` is a reviewed web-only surface: native draws one row (and a record
 * More item) that opens `web` — a declared detail `section` of the record, or a
 * list route `query` — named by `label`; `reason` says why it stays on web. The
 * unit test pins the roster, so adding a handoff is a deliberate declaration change.
 */
export type NativeWebHandoff = {
  /** A detail section id the entity declares; the web hash. */
  readonly section?: string;
  /** List-route query parameters, for a list-level handoff. */
  readonly query?: Readonly<Record<string, string>>;
  /** The row and menu text, named after the web surface. */
  readonly label: string;
};

export type NativeCoverageEntry = (
  | { readonly status: "implemented" | "generic" | "ownedElsewhere" }
  | {
      readonly status: "handoff";
      readonly web: NativeWebHandoff;
      readonly reason: string;
    }
) & {
  readonly inputs?: readonly {
    readonly path: string;
    readonly schema: z.ZodType;
  }[];
};

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
  "structuredField",
  "sectionAction",
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
const handoff = <const Web extends NativeWebHandoff>(
  web: Web,
  reason: string,
) => ({ status: "handoff", web, reason }) as const;

/**
 * Control renderers whose value is an object or array the generic structured-value editor draws
 * from the field's `valueSchema` (derived from its Zod input schema by `pnpm generate`), so none
 * has a per-renderer view path. Classified `generic` below; the generator refuses a field here
 * whose input schema it cannot describe.
 */
const STRUCTURED_VALUE_RENDERERS = [
  "external-ids",
  "label-nutrition",
  "source-aliases",
  "source-refs",
  "unit-mappings",
] as const satisfies readonly ControlRendererId[];

/** Whether the generator derives a `valueSchema` (and native draws the structured editor) for a field. */
export const drawsFromValueSchema = (
  entity: string,
  field: {
    key: string;
    control?: { renderer?: string | null | undefined } | null;
  },
): boolean => {
  const renderer = field.control?.renderer;
  return (
    STRUCTURED_VALUE_RENDERERS.some((id) => id === renderer) ||
    (renderer === "structured-field" &&
      Object.entries<NativeCoverageEntry>(nativeCoverage.structuredField).some(
        ([id, entry]) =>
          id === `${entity}.${field.key}` && entry.status === "implemented",
      ))
  );
};

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
    // Drawn from the field's `valueSchema` only where `structuredField` marks it implemented
    // (a golden read-to-input vector proves the round trip); the other fields of this renderer
    // are read-only, as on web.
    ...generic(["structured-field"]),
    // Product tags use the ordinary token editor.
    ...implemented(["product-tags"]),
    // The editor's image block owns image ordering; it is never a field control.
    ...ownedElsewhere(["image-order"]),
  },
  list: {
    "possible-vendor": {
      status: "generic",
      inputs: [{ path: "vendorInference", schema: merchantVendorInference }],
    },
    "valuation-summary": {
      status: "generic",
      inputs: [{ path: "valuation", schema: locationValuation }],
    },
    "recipe-source": {
      status: "implemented",
      inputs: [{ path: "source", schema: recipeSource }],
    },
    "data-quality": {
      status: "implemented",
      inputs: [{ path: "dataQuality", schema: dataQuality }],
    },
    "uploaded-image": {
      status: "ownedElsewhere",
      inputs: [
        { path: "id", schema: imageOut.shape.id },
        { path: "url", schema: imageOut.shape.url },
        { path: "status", schema: imageOut.shape.status },
      ],
    },
    "estimate-kcal": {
      status: "generic",
      inputs: [
        { path: "totals", schema: recipeTotals },
        { path: "caloriesTotalLabel", schema: listLabel },
        { path: "yield", schema: recipeTopLevelFields.yield },
        { path: "servings", schema: recipeTopLevelFields.servings },
        { path: "updatedAt", schema: z.date() },
      ],
    },
    "estimate-cost": {
      status: "generic",
      inputs: [
        { path: "totals", schema: recipeTotals },
        { path: "costTotalLabel", schema: listLabel },
        { path: "yield", schema: recipeTopLevelFields.yield },
        { path: "servings", schema: recipeTopLevelFields.servings },
        { path: "updatedAt", schema: z.date() },
      ],
    },
    "recipe-links": {
      status: "generic",
      inputs: [
        { path: "recipes[].recipeId", schema: recipeShortcode },
        { path: "recipes[].recipe.name", schema: z.string() },
      ],
    },
    "reconciliation-status": {
      status: "generic",
      inputs: [
        { path: "reconciliation", schema: purchaseReconciliation },
        { path: "expenseTotal", schema: z.number() },
        { path: "statedTotal", schema: z.number() },
        {
          path: "financialReconciliation",
          schema: financialReconciliationSummary,
        },
      ],
    },
    "financial-settlement": {
      status: "generic",
      inputs: [
        { path: "id", schema: purchaseShortcode },
        {
          path: "financialReconciliation",
          schema: financialReconciliationSummary,
        },
      ],
    },
    "order-link": {
      status: "generic",
      inputs: [
        { path: "orderId", schema: z.string() },
        { path: "orderUrl", schema: z.string() },
        { path: "vendorName", schema: z.string() },
      ],
    },
    "vendor-cell": {
      status: "generic",
      inputs: [
        { path: "vendorId", schema: vendorShortcode },
        { path: "vendorName", schema: z.string() },
        { path: "vendorLogo", schema: imageUrlSummary },
      ],
    },
    "run-throughput": {
      status: "generic",
      inputs: [
        { path: "workProgress", schema: runWorkProgress },
        { path: "status", schema: z.string() },
      ],
    },
    "task-progress": {
      status: "generic",
      inputs: [
        {
          path: "rollup",
          schema: projectRollup.pick({ taskCount: true, doneTaskCount: true }),
        },
      ],
    },
    "usda-food-link": {
      status: "generic",
      inputs: [{ path: "food", schema: foodSummary.nullable() }],
    },
    ...implemented(["spending-category-summary"]),
    // Drawn from the field's declared `display.labelPath`: the server-composed figure (a rule
    // computed once, not per client) or the display name of the record a cell links to. The rich
    // web cell (tooltip, pill, link, workbench) stays web-only; the fact it carries does not.
    ...generic(["tag-links", "purchase-links", "product-link", "run-activity"]),
    // The Image row IS the picture: native draws it as the row thumbnail.
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
    ...ownedElsewhere(["image-capture-location", "image-sightings"]),
  },
  /**
   * `implemented` verbs each have a plan in `nativeHeroActionPlans` that the one generic runner
   * (`HeroActionRunner`) executes; `edit` stays in the screen toolbar.
   */
  heroAction: {
    ...implemented([
      "addToInventory",
      "adjustAmount",
      "complete",
      "delete",
      "discard",
      "markPurchased",
      "fetchLogo",
      "moveTo",
      "recordSale",
      "setStatus",
    ]),
    // `edit` is the toolbar's editor. `bulkEdit` is a list/multi-select verb: on a task's detail
    // hero it is the same field editor over one row, which the toolbar `edit` already is, and a
    // selection-wide edit has no row to anchor to on a detail screen.
    // Native uses one Fetch or refresh logo operation for both states.
    ...ownedElsewhere(["edit", "bulkEdit", "refreshLogo"]),
  },
  /**
   * `implemented` slots are the generated `ImplementedDetailSlotID`, which `DetailSlotRegistry`
   * (`apps/apple/App/Shared/Entity/Detail/DetailSlots.swift`) switches over exhaustively.
   */
  detailSlot: {
    ...implemented([
      "meal.nutrition",
      "run.import-controls",
      "purchase.receiving",
      "product.ownership",
      "product.nutrition",
      "product.unit-mappings",
      "product.fits-with",
      "product.runs",
      // Scaling and cooking are Rust; the pantry's coverage, the totals gaps (with the unscaled
      // weight a weight target measures against) and the AI walkthrough are server reports
      // (`recipe.availability`, `recipe.costing-coverage`, `recipe.walkthrough`). The flow's
      // "map" layout is a graph drawing and stays web's.
      "recipe.workflow",
      "ingredient.nutrition-product",
      // A `records` report: a drifted line carries a confirmed Re-parse command.
      "ingredient.recipe-usages",
      // Contents plus the server-worded extraction report; import progress with Add and a
      // confirmed Reprocess as report commands.
      "cookbook.toc",
      "cookbook.import-progress",
      // One generic report view draws these from the server-composed
      // `entityReport.get` blocks (stats, chart, table, note).
      "project.budget",
      "project.contribution",
      "location.contents-valuation",
      "vendor.mail-search",
      // The server's recipes (scale, cost) and portions, edited with report commands that carry
      // the exact meal operation: add a recipe, change its scale, remove it (confirmed), set or
      // remove a portion, mark it eaten, record the yield. Non-recipe foods and moving a portion
      // to another meal (leftovers) stay on web.
      "meal.composition",
      // The same report view draws these as `records` blocks (rows with a thumbnail, badges and a
      // record to open); their verbs are `nativeCollectionActionPlans`, run by the hero-action
      // runner.
      "email.review",
      "product.labels",
      "product.cookbooks",
      "product.recipe-appearances",
      "image.associations",
      "imageJob.attempts",
      "shipment.tracking",
      "purchase.runs",
      "location.ai-description",
      // Read-only finance status: the same report view draws their `records` rows; a verb the
      // server offers there is classified under `sectionAction`.
      "purchase.project-allocation",
      "purchase.financial-settlement",
      // A run's progress, findings, transcript, log, usage and changes: the same report
      // view draws the server's `records` rows, polls (one batched read) while the run is live,
      // and runs the commands the server offers (apply, dismiss, retry) only
      // after the confirmation each declares. Web keeps its corrections review (targets) and
      // audit diffs (changes) as richer fills of the same slots.
      "run.ai-usage",
      "run.suggestions",
      "run.decisions",
      "run.diagnostics",
      "run.changes",
      "run.import-debug-log",
      "run.import-findings",
      // Approve-and-import: the server's prepared lines are `records` rows with a `choice`
      // each (ranked Product candidates, the existing-Product picker, new, or unresolved with a
      // reason), the block's trade choice and one confirmed approve command.
      "run.import-prepared-orders",
      "run.import-progress-live",
      "run.import-progress-stopped",
      "run.import-purchases",
      "run.import-stats",
      "run.import-targets",
      "run.import-timeline",
      "run.live-progress",
      "run.steps",
      "run.results",
    ]),
    // The agent conversation is web-only on purpose: it streams from the import-run agent route (SSE
    // plus prompt and abort over its own protocol), not a Cubby operation, and CubbyKit has no
    // client, reconnect or transcript model for it.
    "project.schedule": handoff(
      { section: "schedule", label: "Open schedule on web" },
      "Project schedules are reviewed on web.",
    ),
    "project.analytics": handoff(
      { section: "analytics", label: "Open analytics on web" },
      "Project analytics are explored on web; budget summaries stay native.",
    ),
    "run.import-agent-live": handoff(
      { section: "import-agent-live", label: "Open live agent on web" },
      "The live agent conversation streams from the import-run agent route, which native has no client for. Prompt and stop the agent on web.",
    ),
    "run.import-agent-stopped": handoff(
      { section: "import-agent-stopped", label: "Open agent history on web" },
      "The agent conversation streams from the import-run agent route, which native has no client for. Review the agent's history on web.",
    ),
    // The Run console keeps a photo Run's upload, processing, recovery and attention; deciding
    // its proposed groups (candidates, Product edits, ownership, approve and discard) is web's.
    "run.photo-batch": handoff(
      { section: "photo-batch", label: "Review photo groups on web" },
      "Comparing candidates, editing proposed Products and ownership, and approving or discarding photo groups are reviewed on web.",
    ),
    // Reconciliation is web's: attaching expenses and products, splitting, and the totals they
    // change are reviewed beside the line evidence web draws.
    "purchase.reconciliation": handoff(
      { section: "reconciliation", label: "Review reconciliation on web" },
      "Attaching expenses and products to an order, and the totals that change with them, are reviewed on web.",
    ),
    "expense.settlement": handoff(
      { section: "settlement", label: "Review settlement on web" },
      "Splitting an expense and reviewing its settlement are web's. Receive into Inventory stays on the expense.",
    ),
    "vendor.spending-classification": handoff(
      { section: "spending-classification", label: "Classify spending on web" },
      "A vendor's spending defaults change only after a historical-impact review, which web draws.",
    ),
    "productCategory.spending-classification": handoff(
      { section: "spending-classification", label: "Classify spending on web" },
      "A category's spending mapping changes only after a historical-impact review, which web draws.",
    ),
  },
  /**
   * Finance verbs a report's `records` block offers. `RecordsBlockView.verbButton` switches over
   * every verb: an `implemented` one runs the same operation web's handler calls, only when the
   * report says it is available; a `handoff` one draws its web row in the block. `section` is
   * the detail section web offers the verb in.
   */
  sectionAction: {
    ...implemented(["receiveExpense"]),
    matchStatement: handoff(
      {
        section: "financial-settlement",
        label: "Match statement activity on web",
      },
      "Allocating a statement charge across orders is reviewed on web.",
    ),
    splitExpense: handoff(
      { section: "settlement", label: "Split expense on web" },
      "Splitting an expense replaces it with its parts; web reviews the split.",
    ),
    linkExpenses: handoff(
      { section: "reconciliation", label: "Attach expenses on web" },
      "Attaching expenses moves them onto the order; web reviews the change to its total.",
    ),
    linkProducts: handoff(
      { section: "reconciliation", label: "Attach products on web" },
      "Attaching products to an order is reviewed on web.",
    ),
  },
  /**
   * `implemented` slots are the generated `ImplementedListSlotID`, which `ListSlotRegistry`
   * (`apps/apple/App/Shared/Entity/List/SpecialistListViews.swift`) switches over; `ownedElsewhere` ones are
   * covered by the generic list's own affordances and never selectable as a slot.
   */
  /**
   * `structured-field` is a shared renderer id, so each field is classified here as
   * `<entity>.<field>`: `implemented` ones are drawn from a `valueSchema` by the generic
   * structured-value editor on both clients (each needs a read-to-input vector in
   * `structured-roundtrip.json`); a `handoff` one is edited on web.
   * Every field with that renderer must appear (asserted by the unit test).
   */
  structuredField: {
    // Every field is drawn by the one generic editor on both clients, each with a read-to-input
    // vector from a real server read. `meal.recipes` has only a create input (an existing meal's
    // recipes change through the meal composition workflow), so it draws on create alone.
    ...implemented([
      "expense.sourceClaims",
      "financialAccount.cardNumbers",
      "financialAccount.authorizedUsers",
      "financialAccount.fundingPeriods",
      "financialAccount.identity",
      "financialTransaction.allocations",
      "ledgerTransfer.sourceClaims",
      "meal.recipes",
      "recipe.meta",
      "recipe.sections",
      "recipe.yield",
      "vendor.agentHints",
    ]),
  },
  listSlot: {
    "project.analytics": handoff(
      { query: { view: "analytics" }, label: "Open project analytics on web" },
      "Portfolio analytics are explored on web.",
    ),
    "expense.analytics": handoff(
      { query: { view: "analytics" }, label: "Open expense analytics on web" },
      "Expense analytics are explored on web.",
    ),
    ...implemented(["location.gallery", "meal.calendar"]),
    ...ownedElsewhere([
      "location.visualizations",
      "meal.nutrition",
      "productCategory.hierarchy",
      "project.overview",
      "project.schedule",
      "planting.schedule",
      "task.agenda",
      "task.calendar",
      "project.calendar",
      "expense.calendar",
      "planting.calendar",
    ]),
  },
} as const satisfies {
  control: Record<ControlRendererId, NativeCoverageEntry>;
  list: Record<ListId, NativeCoverageEntry>;
  detail: Record<DetailId, NativeCoverageEntry>;
  heroAction: Record<HeroActionId, NativeCoverageEntry>;
  detailSlot: Record<DetailSlotKey, NativeCoverageEntry>;
  listSlot: Record<ListSlotKey, NativeCoverageEntry>;
  structuredField: Record<string, NativeCoverageEntry>;
  sectionAction: Record<SectionActionId, NativeCoverageEntry>;
};

/**
 * A literal body value. Only a string starting `$row.` (the record's `id`), `$item.` (the
 * `id` of the collection row a row action was tapped on) or `$field.` (a form field's key) is a
 * slot the runner fills; any other string, `$` or not, is literal.
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
      /**
       * The record must carry a value at this path (`readPath` grammar) before the action is
       * offered; `reason` is shown in its place.
       */
      readonly requires?: { readonly path: string; readonly reason: string };
      /** What the screen does with the result instead of a plain "done" notice. */
      readonly continueWith?: {
        /** Opens the record's editor seeded with a value the operation derives for `field`. */
        readonly kind: "editRecord";
        readonly field: string;
      };
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
      /** Writes this option on one tap instead of asking (a task's Done). */
      readonly value?: string;
    }
  | {
      /** Edits one update field's current value in the single-field form, then updates the row. */
      readonly kind: "editField";
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
  fetchLogo: {
    label: "Fetch or refresh logo",
    symbol: "photo",
    kind: "operation",
    operation: "vendor.fetchLogo",
    entities: ["vendor"],
    confirmation: "none",
    requires: {
      path: "website",
      reason: "Add a website in Edit to fetch a logo.",
    },
    fields: [],
    body: { id: "$row.id" },
  },
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
  complete: {
    label: "Done",
    symbol: "checkmark.circle",
    kind: "setField",
    entities: ["task"],
    field: "status",
    value: "done",
  },
  moveTo: {
    label: "Move to",
    symbol: "arrow.left.arrow.right",
    kind: "operation",
    operation: "inventory.moveEntries",
    entities: ["inventory"],
    // The whole entry moves and can move back; a partial move stays on web's Move dialog.
    confirmation: "none",
    fields: [{ key: "location", label: "Location", kind: "location" }],
    body: {
      items: [
        { inventoryEntryId: "$row.id", targetLocationId: "$field.location" },
      ],
    },
  },
  adjustAmount: {
    label: "Adjust amount",
    symbol: "plusminus",
    kind: "editField",
    entities: ["inventory"],
    field: "amount",
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
 * Plans for the verbs a `collection` detail section offers (`COLLECTION_ACTION_SCOPES`), run by
 * the same `HeroActionRunner` as the hero verbs. A `section` action acts on the record (`$row.id`);
 * a `row` action also reads the tapped row's id (`$item.id`). The keys are exactly the action ids
 * (asserted by the unit test); `pnpm generate` checks each plan against the contract.
 */
export const nativeCollectionActionPlans = {
  analyzeLocation: {
    label: "Analyze photos",
    symbol: "eye",
    kind: "operation",
    operation: "ai.describeLocation",
    entities: ["location"],
    // Web runs it on one tap too: the description is a proposal row, not a destructive write.
    confirmation: "none",
    requires: {
      path: "images",
      reason: "Add a photo to this location to analyze it.",
    },
    fields: [],
    body: { locationId: "$row.id" },
  },
  attachImage: {
    label: "Attach to record",
    symbol: "link.badge.plus",
    kind: "operation",
    operation: "image.attachExisting",
    entities: ["image"],
    confirmation: "none",
    fields: [
      { key: "targetId", label: "Record shortcode", kind: "text" },
      {
        key: "role",
        label: "Attachment role",
        kind: "choice",
        default: "attachment",
        options: [
          { value: "attachment", label: "Gallery attachment" },
          { value: "cover", label: "Replace Cookbook cover" },
          { value: "logo", label: "Replace Vendor logo" },
        ],
      },
      // Sent only for a Product target; the server rejects a purpose on any other record.
      {
        key: "purpose",
        label: "Product image use",
        kind: "choice",
        default: "item",
        options: [
          { value: "item", label: "Item photo" },
          { value: "label", label: "Label or tag" },
        ],
      },
    ],
    body: {
      imageId: "$row.id",
      targetId: "$field.targetId",
      role: "$field.role",
      purpose: "$field.purpose",
    },
  },
  reviewLabelNutrition: {
    label: "Review detected nutrition",
    symbol: "text.magnifyingglass",
    kind: "operation",
    operation: "imageProcessing.status",
    entities: ["product"],
    // The product editor that opens is the confirmation: nothing saves until it does.
    confirmation: "none",
    fields: [],
    body: { id: "$item.id" },
    continueWith: { kind: "editRecord", field: "labelNutrition" },
  },
} as const satisfies Record<
  CollectionActionId,
  Extract<NativeHeroActionPlan, { kind: "operation" }>
>;

/** Named whole-row renderers declare the projection they consume beside their platform disposition. */
export function rendererReadInputs(surface: "list" | "detail", id: string) {
  const entries: Readonly<Record<string, NativeCoverageEntry>> =
    nativeCoverage[surface];
  return entries[id]?.inputs ?? null;
}

/** Shared compilation resolves every renderer disposition before any platform emits it. */
export function requireNativeCoverage(
  kind: NativeCoverageKind,
  id: string,
): NativeCoverageEntry {
  const entries: Readonly<Record<string, NativeCoverageEntry>> =
    nativeCoverage[kind];
  const entry = entries[id];
  if (entry === undefined)
    throw new Error(
      `packages/schemas/src/native-coverage.ts does not classify ${kind} ${JSON.stringify(id)}.`,
    );
  return entry;
}
