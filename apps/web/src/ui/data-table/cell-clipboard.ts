/**
 * Notion-style single-cell copy/paste for individual focused cells.
 *
 * This is the per-ELEMENT registry: a focused CellEditTrigger button (an
 * in-table editable cell, or an out-of-table cell such as a detail page)
 * registers a spec and intercepts the document's `copy`/`paste` events. Copy
 * writes `text/plain` (usable outside the app) plus a typed JSON payload;
 * paste prefers the typed payload when the kind matches and saves immediately
 * through the cell's own onSave path. In-table cells build their spec from the
 * column's `meta.cellData` via `specFromCellData` (columnHelpers.tsx).
 *
 * Range selection (spreadsheet-style drag/shift-select of many cells) is a
 * SEPARATE system: `useCellSelection.ts` owns in-table range copy/paste by
 * reading `meta.cellData` off the TanStack row model directly (so it reaches
 * virtualized off-screen rows). This element registry stays for cells outside
 * that grid — one focused cell at a time.
 *
 * Uses ClipboardEvent.clipboardData (synchronous, no permissions) rather than
 * navigator.clipboard. Known limitation: Firefox doesn't dispatch copy/paste
 * to a focused non-editable element without a selection — Chrome/Safari work;
 * a keydown + navigator.clipboard fallback is a contained follow-up if ever
 * needed.
 *
 * Kind scoping: kinds are BASE types ("text" | "number" | "currency" | "date"
 * | "select" | "amount" | "entity:<name>"). Paste is allowed between any two
 * cells sharing a base kind — e.g. one text column into another, or a location
 * copied on the Locations page into any location cell across tables.
 */

import { toast } from "sonner";
import { z } from "zod";

import { getErrorMessage } from "~/lib/error-utils";

const cellJsonValueSchema = z.json();
const cellClipboardEnvelopeSchema = z.object({
  kind: z.string(),
  value: cellJsonValueSchema,
});

export type CellJsonValue = z.output<typeof cellJsonValueSchema>;

export interface CellCopyPayload {
  /** Human-readable value for the system clipboard. */
  text: string;
  /** Typed value for in-app paste (must round-trip through JSON). */
  json: CellJsonValue;
}

export interface CellPastePayload {
  json?: CellJsonValue;
  text?: string;
}

export interface CellClipboardSpec<TSaved = CellJsonValue | null | void> {
  kindKey: string;
  /** Omit (or return null) to disable copy for this cell. */
  getCopyPayload?: () => CellCopyPayload | null;
  /**
   * Omit to disable paste. Resolve with the saved value (the hosting cell
   * uses it for its optimistic display); reject to surface a toast — both
   * validation failures ("not a number") and save errors.
   */
  onPasteValue?: (payload: CellPastePayload) => Promise<TSaved>;
  /** Paste is ignored while the cell is mid-edit. */
  isEditing?: () => boolean;
  /** Optional presentation port for hosts that own paste-error reporting. */
  onError?: (message: string) => void;
}

export const CELL_CLIPBOARD_MIME = "application/x-cubby-cell";

/** How long the copied/pasted ring pulse stays on the trigger. */
const FLASH_MS = 600;

/**
 * Set a `data-clipboard-flash` pulse on an element for {@link FLASH_MS}, then
 * clear it — but only if it's still our own flash (a re-flash within the window
 * wins). Shared by the single-cell clipboard (below) and the range-selection
 * engine (`useCellSelection.ts`) so the pulse behaves identically on a focused
 * trigger and a selected `<td>`.
 */
export function flashElement(el: HTMLElement, kind: "copied" | "pasted") {
  el.setAttribute("data-clipboard-flash", kind);
  window.setTimeout(() => {
    if (el.getAttribute("data-clipboard-flash") === kind) {
      el.removeAttribute("data-clipboard-flash");
    }
  }, FLASH_MS);
}

type RegisteredCellClipboardSpec = Omit<CellClipboardSpec, "onPasteValue"> & {
  onPasteValue?: (payload: CellPastePayload) => Promise<void>;
};

const registry = new Map<HTMLElement, RegisteredCellClipboardSpec>();
let listenersInstalled = false;

function specForActiveElement(): {
  el: HTMLElement;
  spec: RegisteredCellClipboardSpec;
} | null {
  const el = document.activeElement;
  if (!(el instanceof HTMLElement)) return null;
  const spec = registry.get(el);
  return spec ? { el, spec } : null;
}

function handleCopy(event: ClipboardEvent) {
  // Range copy/paste (useCellSelection) preventDefaults first when it owns the
  // event; bail so a focused trigger doesn't also handle it (coexistence guard).
  if (event.defaultPrevented) return;
  const active = specForActiveElement();
  const payload = active?.spec.getCopyPayload?.();
  if (!active || !payload || !event.clipboardData) return; // native copy
  event.preventDefault();
  event.clipboardData.setData("text/plain", payload.text);
  event.clipboardData.setData(
    CELL_CLIPBOARD_MIME,
    JSON.stringify({ kind: active.spec.kindKey, value: payload.json }),
  );
  flashElement(active.el, "copied");
}

function safeParsePayload(
  raw: string | undefined,
): z.output<typeof cellClipboardEnvelopeSchema> | null {
  if (!raw) return null;
  try {
    const parsed = cellClipboardEnvelopeSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  }
  // SILENT: raw isn't our typed JSON payload (e.g. clipboard text copied
  // from outside the app) — handlePaste falls through to plain text paste.
  catch {}
  return null;
}

function handlePaste(event: ClipboardEvent) {
  // See handleCopy: the range engine preventDefaults when it handles the paste.
  if (event.defaultPrevented) return;
  const active = specForActiveElement();
  const onPasteValue = active?.spec.onPasteValue;
  if (!active || !onPasteValue || active.spec.isEditing?.()) return;
  const { el, spec } = active;

  const runPaste = (payload: CellPastePayload) => {
    onPasteValue(payload).then(
      () => flashElement(el, "pasted"),
      (err) => (spec.onError ?? toast.error)(getErrorMessage(err)),
    );
  };

  const typed = safeParsePayload(
    event.clipboardData?.getData(CELL_CLIPBOARD_MIME),
  );
  if (typed && typed.kind === spec.kindKey) {
    event.preventDefault();
    runPaste({ json: typed.value });
    return;
  }

  const text = event.clipboardData?.getData("text/plain");
  if (!text) return;
  event.preventDefault();
  // Primitive kinds parse the text; entity kinds reject ("paste a … cell").
  runPaste({ text });
}

/**
 * Register a cell trigger element. Document listeners are installed on the
 * first registration and removed at zero, so pages without editable cells
 * (and jsdom tests) pay nothing.
 */
export function registerCellClipboard<TSaved>(
  el: HTMLElement,
  spec: CellClipboardSpec<TSaved>,
): () => void {
  const registered: RegisteredCellClipboardSpec = {
    ...spec,
    onPasteValue: spec.onPasteValue
      ? async (payload) => {
          await spec.onPasteValue?.(payload);
        }
      : undefined,
  };
  registry.set(el, registered);
  if (!listenersInstalled) {
    document.addEventListener("copy", handleCopy);
    document.addEventListener("paste", handlePaste);
    listenersInstalled = true;
  }
  return () => {
    registry.delete(el);
    if (registry.size === 0 && listenersInstalled) {
      document.removeEventListener("copy", handleCopy);
      document.removeEventListener("paste", handlePaste);
      listenersInstalled = false;
    }
  };
}
