import type { LucideIcon } from "lucide-react";
import {
  ArrowRightLeft,
  Camera,
  CheckCircle2,
  ClipboardCopy,
  Copy,
  FolderInput,
  HandCoins,
  Images,
  ListChecks,
  Merge,
  NotebookPen,
  Package,
  PackageCheck,
  PackageMinus,
  PackagePlus,
  PanelRight,
  Pencil,
  Printer,
  Scale,
  ScanBarcode,
  Sparkles,
  Split,
  SquarePen,
  Trash,
  Wrench,
  X,
} from "lucide-react";

/**
 * The canonical presentation of a user-visible action verb: one label, one
 * icon, one tone, wherever it is offered.
 *
 * ## Why presentation only
 *
 * These declare how an action *reads*, not what it does. Behavior stays at the
 * call site because most of it cannot be data: "Discard…" opens a component's
 * own dialog, "Move to project…" sets local state a mutation later reads. An
 * earlier sketch modelled the whole action as a record with a `run` union, and
 * every non-navigation entry degenerated into a handler id the call site had to
 * resolve anyway — indirection with no single source of truth gained. The
 * drift was never in the behavior; it was in the words and the glyphs.
 *
 * ## The drift this closes
 *
 * Print Label shipped as "Print Label", "Print Labels" and "Print labels"
 * across seven sites — `labels.tsx` disagreed with *itself*, titling the route
 * one way and its `<Page>` the other. Move appeared as "Move", "Move to...",
 * "Move to project..." and "Move under...", and the same operation was spelled
 * differently in a row menu and the bulk bar of the *same file*
 * (`product-stocked-at`, `location-inventory-table`). Discard carried two
 * different icons — `PackageX` on products, `PackageMinus` on the inventory
 * tables; `PackageMinus` wins, since a discard removes *some* of a holding
 * rather than voiding the record.
 *
 * ## Conventions
 *
 * - **Sentence case.** "Print label", not "Print Label". The majority of
 *   existing labels already read this way; the Title Case ones were the
 *   outliers.
 * - **A trailing `...` means the action needs more input** — it opens a dialog
 *   or a picker rather than acting immediately. ASCII, not `…`, matching every
 *   existing label rather than churning them for typography.
 * - **No icon sizing here.** `DropdownMenuItem` and `BulkActionBar` already
 *   size their icon slot; a per-site `size-4` was an unintended override.
 */
export interface ActionVerb {
  label: string;
  icon: LucideIcon;
  /** Renders destructive. Only for actions that remove or unlink a record. */
  tone?: "destructive";
}

export const actionVerbs = {
  // — navigation ————————————————————————————————————————————————————
  recount: { label: "Recount", icon: ScanBarcode },
  photoPass: { label: "Photo pass", icon: Camera },
  printLabel: { label: "Print label", icon: Printer },
  printLabels: { label: "Print labels", icon: Printer },
  addToInventory: { label: "Add to inventory", icon: Package },
  compare: { label: "Compare", icon: Scale },
  inspect: { label: "Inspect", icon: PanelRight },

  // — opens a dialog or picker (trailing `...`) —————————————————————
  editLocations: { label: "Edit locations", icon: Pencil },
  discard: { label: "Discard...", icon: PackageMinus },
  moveTo: { label: "Move to...", icon: ArrowRightLeft },
  moveUnder: { label: "Move under...", icon: FolderInput },
  setStatus: { label: "Set status...", icon: ListChecks },
  bulkEdit: { label: "Bulk edit...", icon: SquarePen },
  setStockTracking: { label: "Set stock tracking...", icon: PackageCheck },
  setUsuallyOnHand: { label: "Set usually on hand...", icon: PackageCheck },
  createProjectFrom: {
    label: "Create project from selected...",
    icon: Sparkles,
  },
  recordSale: { label: "Record sale...", icon: HandCoins },
  split: { label: "Split...", icon: Split },
  receive: { label: "Receive into inventory...", icon: PackagePlus },
  logEntry: { label: "Log entry...", icon: NotebookPen },
  importPhotos: { label: "Import photos...", icon: Images },
  setProjectUses: { label: "Set project uses...", icon: Wrench },
  setTradeCost: { label: "Set trade cost...", icon: HandCoins },

  // — AI ——————————————————————————————————————————————————————————————
  //
  // Every AI trigger is `Sparkles`. Before this the AI surfaces used seven
  // trigger verbs and a non-Sparkles glyph — inventory detection wore
  // `PackagePlus`, so it did not read as AI at all.
  // The icon is the recognition; the label says what it will produce.
  //
  // `suggest` is the only AI verb with more than one object (product category,
  // location type, put-away location, USDA food), so it carries the bare verb
  // and each surface names its own object through `VerbButton`'s `object` prop
  // — which is also what keeps its accessible name specific on a phone, where
  // the text is hidden. The single-object verbs bake the object into the label.
  suggest: { label: "Suggest", icon: Sparkles },
  analyze: { label: "Analyze photos", icon: Sparkles },
  identify: { label: "Identify product", icon: Sparkles },
  enrichProducts: { label: "Enrich products...", icon: Sparkles },
  detect: { label: "Detect items", icon: Sparkles },
  regenerate: { label: "Regenerate flow", icon: Sparkles },

  // — immediate ——————————————————————————————————————————————————————
  markPurchased: { label: "Mark purchased", icon: CheckCircle2 },
  markInstalled: { label: "Mark installed", icon: Wrench },
  markAsStock: { label: "Mark as stock", icon: Wrench },
  merge: { label: "Merge", icon: Merge },
  copyCodes: { label: "Copy codes", icon: ClipboardCopy },
  copyIdentifiers: { label: "Copy identifiers", icon: ClipboardCopy },
  duplicate: { label: "Duplicate", icon: Copy },

  // — removal ————————————————————————————————————————————————————————
  delete: { label: "Delete", icon: Trash, tone: "destructive" },
  removeComponent: { label: "Remove component", icon: X },
  removeFromKit: { label: "Remove from kit", icon: X },
  removeFromPurchase: { label: "Remove from purchase", icon: X },
  removeFromProject: { label: "Remove from project", icon: X },
} as const satisfies Record<string, ActionVerb>;

export type ActionVerbId = keyof typeof actionVerbs;

export const actionVerbLabels: string[] = Object.values(actionVerbs).map(
  (verb) => verb.label,
);

/**
 * Widen a verb to {@link ActionVerb}. The registry is `as const` so ids stay
 * literal, which also narrows each entry to exactly the keys it declares —
 * making `tone` unreadable on the ones that omit it.
 */
export const verbDef = (id: ActionVerbId): ActionVerb => actionVerbs[id];
