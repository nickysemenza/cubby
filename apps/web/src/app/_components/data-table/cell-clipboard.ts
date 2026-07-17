/**
 * Notion-style cell copy/paste for editable table cells.
 *
 * Registered cells (the focused CellEditTrigger button) intercept the
 * document's `copy`/`paste` events: copy writes `text/plain` (usable outside
 * the app) plus a typed JSON payload; paste prefers the typed payload when
 * the kind matches and saves immediately through the cell's own onSave path.
 *
 * Uses ClipboardEvent.clipboardData (synchronous, no permissions) rather than
 * navigator.clipboard. Known limitation: Firefox doesn't dispatch copy/paste
 * to a focused non-editable element without a selection — Chrome/Safari work;
 * a keydown + navigator.clipboard fallback is a contained follow-up if ever
 * needed.
 *
 * Kind scoping: primitive cells use `"<columnId>:<configType>"` (paste stays
 * within the same column); entity-picker cells use `"entity:<name>"` so a
 * copied location pastes into any location cell across tables.
 */

import { toast } from "sonner";
import { getErrorMessage } from "~/lib/error-utils";

interface CellCopyPayload {
  /** Human-readable value for the system clipboard. */
  text: string;
  /** Typed value for in-app paste (must round-trip through JSON). */
  json: unknown;
}

export interface CellClipboardSpec {
  kindKey: string;
  /** Omit (or return null) to disable copy for this cell. */
  getCopyPayload?: () => CellCopyPayload | null;
  /**
   * Omit to disable paste. Resolve with the saved value (the hosting cell
   * uses it for its optimistic display); reject to surface a toast — both
   * validation failures ("not a number") and save errors.
   */
  onPasteValue?: (payload: {
    json?: unknown;
    text?: string;
  }) => Promise<unknown>;
  /** Paste is ignored while the cell is mid-edit. */
  isEditing?: () => boolean;
}

export const CELL_CLIPBOARD_MIME = "application/x-cubby-cell";

/** How long the copied/pasted ring pulse stays on the trigger. */
const FLASH_MS = 600;

const registry = new Map<HTMLElement, CellClipboardSpec>();
let listenersInstalled = false;

function specForActiveElement(): {
  el: HTMLElement;
  spec: CellClipboardSpec;
} | null {
  const el = document.activeElement;
  if (!(el instanceof HTMLElement)) return null;
  const spec = registry.get(el);
  return spec ? { el, spec } : null;
}

function flash(el: HTMLElement, kind: "copied" | "pasted") {
  el.setAttribute("data-clipboard-flash", kind);
  window.setTimeout(() => {
    // Only clear our own flash (a re-flash within the window wins).
    if (el.getAttribute("data-clipboard-flash") === kind) {
      el.removeAttribute("data-clipboard-flash");
    }
  }, FLASH_MS);
}

function handleCopy(event: ClipboardEvent) {
  const active = specForActiveElement();
  const payload = active?.spec.getCopyPayload?.();
  if (!active || !payload || !event.clipboardData) return; // native copy
  event.preventDefault();
  event.clipboardData.setData("text/plain", payload.text);
  event.clipboardData.setData(
    CELL_CLIPBOARD_MIME,
    JSON.stringify({ kind: active.spec.kindKey, value: payload.json }),
  );
  flash(active.el, "copied");
}

function safeParsePayload(
  raw: string | undefined,
): { kind: string; value: unknown } | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as { kind?: unknown }).kind === "string"
    ) {
      return parsed as { kind: string; value: unknown };
    }
  } catch {
    // fall through to text paste
  }
  return null;
}

function handlePaste(event: ClipboardEvent) {
  const active = specForActiveElement();
  const onPasteValue = active?.spec.onPasteValue;
  if (!active || !onPasteValue || active.spec.isEditing?.()) return;
  const { el, spec } = active;

  const runPaste = (payload: { json?: unknown; text?: string }) => {
    onPasteValue(payload).then(
      () => flash(el, "pasted"),
      (err: unknown) => toast.error(getErrorMessage(err)),
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
export function registerCellClipboard(
  el: HTMLElement,
  spec: CellClipboardSpec,
): () => void {
  registry.set(el, spec);
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
