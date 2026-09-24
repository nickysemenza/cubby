import { ArrowsLeftRightIcon } from "@phosphor-icons/react/dist/csr/ArrowsLeftRight";
import { ArrowsMergeIcon } from "@phosphor-icons/react/dist/csr/ArrowsMerge";
import { ArrowsSplitIcon } from "@phosphor-icons/react/dist/csr/ArrowsSplit";
import { BarcodeIcon } from "@phosphor-icons/react/dist/csr/Barcode";
import { CameraIcon } from "@phosphor-icons/react/dist/csr/Camera";
import { CheckCircleIcon } from "@phosphor-icons/react/dist/csr/CheckCircle";
import { ClipboardIcon } from "@phosphor-icons/react/dist/csr/Clipboard";
import { CopyIcon } from "@phosphor-icons/react/dist/csr/Copy";
import { FolderSimplePlusIcon } from "@phosphor-icons/react/dist/csr/FolderSimplePlus";
import { HandCoinsIcon } from "@phosphor-icons/react/dist/csr/HandCoins";
import { ImagesIcon } from "@phosphor-icons/react/dist/csr/Images";
import { ListChecksIcon } from "@phosphor-icons/react/dist/csr/ListChecks";
import { NotePencilIcon } from "@phosphor-icons/react/dist/csr/NotePencil";
import { PackageIcon } from "@phosphor-icons/react/dist/csr/Package";
import { PencilIcon } from "@phosphor-icons/react/dist/csr/Pencil";
import { PrinterIcon } from "@phosphor-icons/react/dist/csr/Printer";
import { ScalesIcon } from "@phosphor-icons/react/dist/csr/Scales";
import { SealCheckIcon } from "@phosphor-icons/react/dist/csr/SealCheck";
import { SidebarSimpleIcon } from "@phosphor-icons/react/dist/csr/SidebarSimple";
import { SparkleIcon } from "@phosphor-icons/react/dist/csr/Sparkle";
import { StackMinusIcon } from "@phosphor-icons/react/dist/csr/StackMinus";
import { StackPlusIcon } from "@phosphor-icons/react/dist/csr/StackPlus";
import { TrashIcon } from "@phosphor-icons/react/dist/csr/Trash";
import { WrenchIcon } from "@phosphor-icons/react/dist/csr/Wrench";
import { XIcon } from "@phosphor-icons/react/dist/csr/X";
import type { Icon } from "@phosphor-icons/react/lib";

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
  icon: Icon;
  /** Renders destructive. Only for actions that remove or unlink a record. */
  tone?: "destructive";
}

export const actionVerbs = {
  // — navigation ————————————————————————————————————————————————————
  recount: { label: "Recount", icon: BarcodeIcon },
  photoPass: { label: "Photo pass", icon: CameraIcon },
  printLabel: { label: "Print label", icon: PrinterIcon },
  printLabels: { label: "Print labels", icon: PrinterIcon },
  addToInventory: { label: "Add to inventory", icon: PackageIcon },
  compare: { label: "Compare", icon: ScalesIcon },
  inspect: { label: "Inspect", icon: SidebarSimpleIcon },

  // — opens a dialog or picker (trailing `...`) —————————————————————
  editLocations: { label: "Edit locations", icon: PencilIcon },
  discard: { label: "Discard...", icon: StackMinusIcon },
  moveTo: { label: "Move to...", icon: ArrowsLeftRightIcon },
  moveUnder: { label: "Move under...", icon: FolderSimplePlusIcon },
  setStatus: { label: "Set status...", icon: ListChecksIcon },
  bulkEdit: { label: "Bulk edit...", icon: NotePencilIcon },
  setStockTracking: { label: "Set stock tracking...", icon: SealCheckIcon },
  setUsuallyOnHand: { label: "Set usually on hand...", icon: SealCheckIcon },
  createProjectFrom: {
    label: "Create project from selected...",
    icon: SparkleIcon,
  },
  recordSale: { label: "Record sale...", icon: HandCoinsIcon },
  split: { label: "Split...", icon: ArrowsSplitIcon },
  receive: { label: "Receive into inventory...", icon: StackPlusIcon },
  logEntry: { label: "Log entry...", icon: NotePencilIcon },
  importPhotos: { label: "Import photos...", icon: ImagesIcon },
  setProjectUses: { label: "Set project uses...", icon: WrenchIcon },
  setTradeCost: { label: "Set trade cost...", icon: HandCoinsIcon },

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
  suggest: { label: "Suggest", icon: SparkleIcon },
  analyze: { label: "Analyze photos", icon: SparkleIcon },
  identify: { label: "Identify product", icon: SparkleIcon },
  enrichProducts: { label: "Enrich products...", icon: SparkleIcon },
  detect: { label: "Detect items", icon: SparkleIcon },
  regenerate: { label: "Regenerate flow", icon: SparkleIcon },

  // — immediate ——————————————————————————————————————————————————————
  markPurchased: { label: "Mark purchased", icon: CheckCircleIcon },
  markInstalled: { label: "Mark installed", icon: WrenchIcon },
  markAsStock: { label: "Mark as stock", icon: WrenchIcon },
  merge: { label: "Merge", icon: ArrowsMergeIcon },
  copyCodes: { label: "Copy codes", icon: ClipboardIcon },
  copyIdentifiers: { label: "Copy identifiers", icon: ClipboardIcon },
  duplicate: { label: "Duplicate", icon: CopyIcon },

  // — removal ————————————————————————————————————————————————————————
  delete: { label: "Delete", icon: TrashIcon, tone: "destructive" },
  removeComponent: { label: "Remove component", icon: XIcon },
  removeFromKit: { label: "Remove from kit", icon: XIcon },
  removeFromPurchase: { label: "Remove from purchase", icon: XIcon },
  removeFromProject: { label: "Remove from project", icon: XIcon },
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
