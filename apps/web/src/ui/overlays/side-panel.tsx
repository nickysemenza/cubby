import { XIcon } from "@phosphor-icons/react/dist/csr/X";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
  createContext,
  useContext,
  useEffect,
  useRef,
  useSyncExternalStore,
} from "react";

import { cn } from "~/lib/utils";
import { CopyableShortcode } from "~/ui/common/copyable-shortcode";
import {
  DisclosureBody,
  DisclosureRoot,
  DisclosureTrigger,
} from "~/ui/layout/disclosure";
import { Button } from "~/ui/primitives/button";
import { Sheet, SheetContent, SheetTitle } from "~/ui/primitives/sheet";

/**
 * The docked panel's width, as one CSS custom property on the document root.
 * `styles.css` declares the 25rem default; every docked layout (table
 * reserve, list grids, the panel column) reads `var(--side-panel-width)`.
 */
export const SIDE_PANEL_WIDTH_VAR = "--side-panel-width";
/** One width for every docked panel in the tab's session. */
export const SIDE_PANEL_WIDTH_KEY = "cubby.side-panel-width";
const MIN_WIDTH_PX = 320;
const MAX_WIDTH_PX = 720;
/** Room the record list keeps beside the panel. */
const MAX_VIEWPORT_SHARE = 0.6;
const KEYBOARD_STEP_PX = 16;

const listeners = new Set<() => void>();
let currentWidth: number | null = null;
let restored = false;

function clampWidth(width: number) {
  const viewport = globalThis.window?.innerWidth ?? MAX_WIDTH_PX / 0.6;
  const max = Math.max(
    MIN_WIDTH_PX,
    Math.min(MAX_WIDTH_PX, viewport * MAX_VIEWPORT_SHARE),
  );
  return Math.round(Math.min(max, Math.max(MIN_WIDTH_PX, width)));
}

function writeWidth(width: number | null) {
  currentWidth = width === null ? null : clampWidth(width);
  const root = globalThis.document?.documentElement;
  if (root) {
    if (currentWidth === null) root.style.removeProperty(SIDE_PANEL_WIDTH_VAR);
    else root.style.setProperty(SIDE_PANEL_WIDTH_VAR, `${currentWidth}px`);
  }
  try {
    if (currentWidth === null) sessionStorage.removeItem(SIDE_PANEL_WIDTH_KEY);
    else sessionStorage.setItem(SIDE_PANEL_WIDTH_KEY, String(currentWidth));
  } catch {
    // SILENT: storage can be unavailable (private mode); the width still applies.
  }
  for (const listener of listeners) listener();
}

/** Re-applies the session's width once per page load. */
function restoreWidth() {
  if (restored || !globalThis.window) return;
  restored = true;
  let stored: string | null = null;
  try {
    stored = sessionStorage.getItem(SIDE_PANEL_WIDTH_KEY);
  } catch {
    // SILENT: unreadable storage means no saved width; the default applies.
    stored = null;
  }
  const parsed = stored === null ? Number.NaN : Number(stored);
  if (Number.isFinite(parsed)) writeWidth(parsed);
}

/** The rendered panel width in px, measured when no override is set. */
function measuredWidth() {
  if (currentWidth !== null) return currentWidth;
  const root = globalThis.document?.documentElement;
  if (!root) return 400;
  const probe = document.createElement("div");
  probe.style.width = `var(${SIDE_PANEL_WIDTH_VAR}, 25rem)`;
  probe.style.position = "absolute";
  probe.style.visibility = "hidden";
  document.body.append(probe);
  const width = probe.getBoundingClientRect().width;
  probe.remove();
  return width || 400;
}

/**
 * The session's docked side-panel width. `setWidth(null)` returns to the
 * stylesheet default. Layouts read the CSS variable, not this hook; it exists
 * for the resize handle and tests.
 */
function useSidePanelWidth() {
  const width = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => currentWidth,
    () => null,
  );
  useEffect(restoreWidth, []);
  return { width, setWidth: writeWidth };
}

/**
 * The left-edge grip of a docked panel: drag, or focus and use the arrow
 * keys; double-click restores the default width.
 */
function SidePanelResizeHandle() {
  const { width, setWidth } = useSidePanelWidth();
  const drag = useRef<{ x: number; width: number } | null>(null);
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, width: measuredWidth() };
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = drag.current;
    if (!start) return;
    setWidth(start.width + (start.x - event.clientX));
  };
  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step =
      event.key === "ArrowLeft"
        ? KEYBOARD_STEP_PX
        : event.key === "ArrowRight"
          ? -KEYBOARD_STEP_PX
          : 0;
    if (step === 0) return;
    event.preventDefault();
    setWidth(measuredWidth() + step);
  };
  return (
    <div
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- A focusable separator is the ARIA pattern for a keyboard-resizable splitter; <hr> cannot hold focus or pointer capture.
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize panel"
      aria-valuenow={width ?? undefined}
      aria-valuemin={MIN_WIDTH_PX}
      aria-valuemax={MAX_WIDTH_PX}
      tabIndex={0}
      title="Drag to resize · double-click to reset"
      data-side-panel-resize=""
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={() => setWidth(null)}
      onKeyDown={onKeyDown}
      className="absolute inset-y-0 -start-1 z-30 hidden w-2 cursor-col-resize touch-none outline-none after:absolute after:inset-y-0 after:start-1 after:w-px after:bg-transparent after:transition-colors hover:after:bg-ring focus-visible:after:bg-ring xl:block"
    />
  );
}

const isEditableTarget = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable ||
    target.closest(
      "input, textarea, select, [contenteditable=''], [contenteditable=true], [role=combobox], [role=listbox], [role=menu]",
    ) !== null);

/**
 * J/K step and Esc close while the panel is open, unless the key belongs to
 * a field, a menu, or a dialog opened on top of the panel.
 */
function usePanelKeys(
  panel: RefObject<HTMLElement | null>,
  keys: { onPrev?: () => void; onNext?: () => void; onClose?: () => void },
) {
  const latest = useRef(keys);
  latest.current = keys;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        isEditableTarget(event.target)
      )
        return;
      const dialog =
        event.target instanceof Element
          ? event.target.closest("[role=dialog], [role=alertdialog]")
          : null;
      // A dialog on top owns its keys; the panel's own sheet does not count.
      if (dialog && !dialog.contains(panel.current)) return;
      const { onPrev, onNext, onClose } = latest.current;
      const action =
        event.key === "Escape"
          ? onClose
          : event.key === "j" || event.key === "J"
            ? onNext
            : event.key === "k" || event.key === "K"
              ? onPrev
              : undefined;
      if (!action) return;
      event.preventDefault();
      action();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [panel]);
}

/**
 * The docked table's own row stepper: it walks the row model, so it still
 * works when the current row has scrolled out of the virtualized range.
 */
export const TableRowStepContext = createContext<
  ((direction: -1 | 1) => boolean) | null
>(null);

/** J/K for a panel docked beside a table: the table's stepper, else the DOM. */
export function useTableRowStep(): (direction: -1 | 1) => boolean {
  return useContext(TableRowStepContext) ?? stepCurrentTableRow;
}

/**
 * Steps the docked table's current row (`tr[data-current]`) to its previous
 * or next record row, as a click on that row would. The default J/K for
 * panels opened from an RTable; hosts that own the order pass callbacks.
 */
function stepCurrentTableRow(direction: -1 | 1): boolean {
  const current = document.querySelector<HTMLTableRowElement>(
    "tr.table-record-row[data-current='true']",
  );
  let row = current;
  do {
    const sibling: Element | null | undefined =
      direction === 1 ? row?.nextElementSibling : row?.previousElementSibling;
    row = sibling instanceof HTMLTableRowElement ? sibling : null;
  } while (row && !row.classList.contains("table-record-row"));
  if (!row) return false;
  row.scrollIntoView({ block: "nearest" });
  row.click();
  return true;
}

function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded-[4px] border border-border bg-background px-1 font-mono text-2xs leading-4 text-muted-foreground">
      {children}
    </kbd>
  );
}

/**
 * One chrome for every row detail: a sticky identity header (icon tile,
 * eyebrow, title, mono key, actions and close in the same row), a scrolling
 * body of hairline-divided sections, and a keyboard footer. Docked and modeless beside
 * a list at xl; hosts present it in a sheet below that. Forms stay in
 * `Overlay`.
 */
export function SidePanel({
  label,
  icon,
  eyebrow,
  title,
  code,
  actions,
  onClose,
  closeLabel = "Close panel",
  onPrev,
  onNext,
  resizable = true,
  className,
  children,
}: {
  /** Accessible name of the panel landmark ("Task inspector"). */
  label: string;
  /** The record's mark: an entity icon tile, a cover, a glyph. */
  icon?: ReactNode;
  eyebrow?: ReactNode;
  title: ReactNode;
  /** The record's key, shown in mono and copyable. */
  code?: string;
  /** Header actions before close, e.g. Open ↗. */
  actions?: ReactNode;
  onClose?: () => void;
  closeLabel?: string;
  onPrev?: () => void;
  onNext?: () => void;
  resizable?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLElement>(null);
  usePanelKeys(ref, { onPrev, onNext, onClose });
  const stepping = onPrev !== undefined || onNext !== undefined;
  return (
    <aside
      ref={ref}
      aria-label={label}
      data-side-panel=""
      className={cn(
        "relative flex h-full w-full max-w-full min-w-0 flex-col bg-background text-sm text-foreground",
        className,
      )}
    >
      {resizable ? <SidePanelResizeHandle /> : null}
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <header className="sticky top-0 z-20 border-b border-border bg-background px-4 py-3">
          <div className="flex items-start gap-2.5">
            {icon ? <div className="shrink-0">{icon}</div> : null}
            <div className="min-w-0 flex-1">
              {eyebrow ? (
                <div className="truncate text-xs text-muted-foreground">
                  {eyebrow}
                </div>
              ) : null}
              <h2 className="text-base leading-5 font-semibold tracking-[-0.01em] break-words text-foreground-strong">
                {title}
              </h2>
              {code ? (
                <p className="mt-0.5 truncate">
                  <CopyableShortcode
                    code={code}
                    className="font-mono text-xs text-muted-foreground"
                  />
                </p>
              ) : null}
            </div>
            <div className="flex shrink-0 items-center gap-0.5">
              {actions}
              {onClose ? (
                <Button
                  variant="ghost"
                  size="icon-xs"
                  mobileSize="compact"
                  aria-label={closeLabel}
                  onClick={onClose}
                >
                  <XIcon />
                </Button>
              ) : null}
            </div>
          </div>
        </header>
        {children}
      </div>
      {stepping || onClose ? (
        <footer
          aria-hidden
          className="hidden shrink-0 items-center gap-3 border-t border-border bg-sidebar px-4 py-1.5 text-xs text-muted-foreground md:flex"
        >
          {stepping ? (
            <span className="inline-flex items-center gap-1">
              <Kbd>J</Kbd>
              <Kbd>K</Kbd>
              prev/next
            </span>
          ) : null}
          {onClose ? (
            <span className="inline-flex items-center gap-1">
              <Kbd>Esc</Kbd>
              close
            </span>
          ) : null}
        </footer>
      ) : null}
    </aside>
  );
}

/** The 28px neutral tile a panel header leads with. */
export function SidePanelIconTile({ children }: { children: ReactNode }) {
  return (
    <span
      aria-hidden
      className="flex size-7 items-center justify-center rounded-lg bg-muted text-muted-foreground [&_svg]:size-3.5"
    >
      {children}
    </span>
  );
}

/**
 * A hairline-topped section of a panel body. `open`/`onOpenChange` make it a
 * disclosure. Callers gate the first mount; a rendered body then stays mounted
 * across closes so a visited view (and any draft in it) survives.
 */
export function SidePanelSection({
  id,
  title,
  action,
  open,
  onOpenChange,
  children,
}: {
  id?: string;
  title: ReactNode;
  action?: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children?: ReactNode;
}) {
  const heading =
    "flex min-h-9 items-center gap-2 border-t border-border px-4 py-2 text-sm font-semibold text-foreground-strong";
  if (open === undefined)
    return (
      <section id={id}>
        <h3 className={heading}>
          <span className="min-w-0 flex-1">{title}</span>
          {action}
        </h3>
        {children}
      </section>
    );
  return (
    <div id={id}>
      <DisclosureRoot state={{ open, onOpenChange }}>
        <h3 className={heading}>
          <DisclosureTrigger className="flex-1">{title}</DisclosureTrigger>
          {action}
        </h3>
        <DisclosureBody keepMounted>{children}</DisclosureBody>
      </DisclosureRoot>
    </div>
  );
}

const DOCK_QUERY = "(min-width: 1280px)";
const subscribeDock = (listener: () => void) => {
  const query = globalThis.matchMedia?.(DOCK_QUERY);
  query?.addEventListener("change", listener);
  return () => query?.removeEventListener("change", listener);
};

/** Whether panels dock beside their list (xl) or present as a sheet. */
function useSidePanelDocked(): boolean {
  return useSyncExternalStore(
    subscribeDock,
    () => globalThis.matchMedia?.(DOCK_QUERY).matches ?? false,
    () => false,
  );
}

/**
 * A list with its row-detail panel: docked as a sticky right column at xl,
 * a right sheet with a light scrim below. For pages that render their own
 * table; RTable hosts dock through `desktopInspector`.
 */
export function SidePanelLayout({
  panel,
  title,
  onClose,
  children,
}: {
  /** The open panel, or null when nothing is selected. */
  panel: ReactNode;
  /** Sheet title for assistive tech below xl. */
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const docked = useSidePanelDocked();
  if (docked)
    return (
      <div
        className={cn(
          "min-w-0",
          panel && "grid grid-cols-[minmax(0,1fr)_var(--side-panel-width)]",
        )}
      >
        <div className="min-w-0">{children}</div>
        {panel ? (
          <div className="sticky top-0 h-[min(100dvh,100%)] max-h-dvh min-w-0 self-start border-l border-border">
            {panel}
          </div>
        ) : null}
      </div>
    );
  return (
    <>
      {children}
      <Sheet open={panel != null} onOpenChange={(open) => !open && onClose()}>
        <SheetContent
          side="right"
          showCloseButton={false}
          className="!w-[25rem] !max-w-[calc(100vw-2rem)] p-0 max-md:!w-screen max-md:!max-w-none"
        >
          <SheetTitle className="sr-only">{title}</SheetTitle>
          {panel}
        </SheetContent>
      </Sheet>
    </>
  );
}
