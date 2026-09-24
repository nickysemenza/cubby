import type { Entity } from "@cubby/schemas/entity";
import { BugIcon } from "@phosphor-icons/react/dist/csr/Bug";
import { CaretRightIcon } from "@phosphor-icons/react/dist/csr/CaretRight";
import { Link } from "@tanstack/react-router";
import type { RowData } from "@tanstack/react-table";
import { useWindowVirtualizer } from "@tanstack/react-virtual";
import {
  type CSSProperties,
  Fragment,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  RecordRowSuggestions,
  RecordSuggestionBoundary,
} from "~/app/_components/ai/record-suggestions";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Spinner } from "~/components/ui/spinner";
import { entities, isBrowserRoutedEntity } from "~/entities/entities";
import { useDebug } from "~/hooks/useDebug";
import { type LongPressHandlers, useLongPress } from "~/hooks/useLongPress";
import { cn } from "~/lib/utils";

import { useInfiniteScrollSentinel } from "../hooks/useInfiniteScrollSentinel";
import type { InfiniteScrollControls } from "../hooks/useInfiniteTableList";
import { DebugDialog } from "./DebugDialog";
import {
  EntityEmptyState,
  FilteredEmptyState,
  isNarrowed,
} from "./entity-empty-states";
import { SectionHeader } from "./SectionHeader";
import type { CubbyRow as Row, CubbyTable as ITable } from "./table-features";
import type { GroupConfig } from "./useGroupedList";
import { useGroupedList } from "./useGroupedList";
import {
  estimateMobileRowHeight,
  type MobileListRowModel,
  useMobileListModel,
} from "./useMobileListModel";

// Absolutely-positioned virtualizer row wrapper — virtualizer mechanics
// (measureElement ref + data-index + translateY), shared by all 3 render sites.
type WindowVirtualizer = ReturnType<typeof useWindowVirtualizer>;
type VirtualItem = ReturnType<WindowVirtualizer["getVirtualItems"]>[number];

function VirtualRow({
  vi,
  virtualizer,
  children,
  role,
}: {
  vi: VirtualItem;
  virtualizer: WindowVirtualizer;
  children: ReactNode;
  role?: "listitem" | "presentation";
}) {
  return (
    <li
      ref={virtualizer.measureElement}
      data-index={vi.index}
      role={role}
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        width: "100%",
        transform: `translateY(${vi.start - virtualizer.options.scrollMargin}px)`,
      }}
    >
      {children}
    </li>
  );
}

// Keeps an inline edit trigger at the 44px phone floor without growing the
// compact desktop control's own box — same convention the row shell used.
const TOUCH_TRIGGER_CLASS = cn(
  "[&_[data-cell-edit-trigger]]:min-h-11",
  "[&_[data-cell-edit-trigger]:has(>svg:only-child)]:min-w-11",
  "[&_[data-cell-edit-trigger]:has(>svg:only-child)]:justify-center",
);

/** Whether a click landed on a nested interactive control rather than open row space. */
function isInteractiveTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest("a,button,input,select,textarea") !== null
  );
}

interface SubtitlePart {
  id: string;
  value: ReactNode;
  interactive?: boolean;
}

/**
 * Subtitle-slot value first, then every meta-slot value in priority order —
 * the canvas has one truncated identity line, not a stacked spec grid.
 */
/**
 * The trailing column holds one mono value (plus any Badge-shaped extras a
 * column renders); further trailing-slot values would stack the row taller
 * than its 64px, so they join the subtitle line after the meta parts.
 */
const TRAILING_STACK_LIMIT = 2;

function buildSubtitleParts<TItem extends RowData>(
  model: MobileListRowModel<TItem>,
): SubtitlePart[] {
  return [
    ...(model.subtitle !== undefined
      ? [{ id: "subtitle", value: model.subtitle }]
      : []),
    ...model.metaValues.map(({ id, value, interactive }) => ({
      id,
      value,
      interactive,
    })),
    ...model.rightValues.slice(TRAILING_STACK_LIMIT).map((value, index) => ({
      id: `trailing-overflow-${index}`,
      value,
      interactive:
        model.rightValueInteractive[index + TRAILING_STACK_LIMIT] ?? false,
    })),
  ];
}

interface TrailingValueEntry {
  key: string;
  value: ReactNode;
  interactive: boolean;
  isPrimary: boolean;
}

/**
 * Pairs each trailing value with a row-scoped key instead of its array index,
 * since `rightValues`/`rightValueInteractive` carry no column id of their own.
 * Precomputing the key here (rather than inline in the render map) keeps the
 * render map's own callback free of an `index` parameter for the key to
 * reference.
 */
function trailingValueEntries<TItem extends RowData>(
  model: MobileListRowModel<TItem>,
): TrailingValueEntry[] {
  return model.rightValues
    .slice(0, TRAILING_STACK_LIMIT)
    .map((value, index) => ({
      key: `${model.row.id}:trailing:${index}`,
      value,
      interactive: model.rightValueInteractive[index] ?? false,
      isPrimary: index === 0,
    }));
}

function buildGridTemplateColumns({
  selectionMode,
  showThumb,
  hasRowActions,
}: {
  selectionMode: boolean;
  showThumb: boolean;
  hasRowActions: boolean;
}): string {
  return [
    selectionMode || showThumb ? "2.75rem" : null,
    "minmax(0,1fr)",
    "auto",
    hasRowActions ? "auto" : null,
  ]
    .filter(Boolean)
    .join(" ");
}

function buildRowClassName({
  depth,
  isLink,
  activeClick,
  isSelectable,
  selectionMode,
}: {
  depth: number;
  isLink: boolean;
  activeClick: (() => void) | undefined;
  isSelectable: boolean;
  selectionMode: boolean;
}): string {
  return cn(
    "grid min-h-16 items-center gap-3 border-b border-border px-3 py-2 text-foreground",
    depth > 0 && "bg-muted/20 pl-4",
    (isLink || activeClick) &&
      "cursor-pointer transition-colors duration-150 active:bg-muted/50",
    (isSelectable || selectionMode) &&
      "select-none [-webkit-touch-callout:none]",
  );
}

/** Selection checkbox (selection mode) or a real thumbnail. */
function RowLeading<TItem extends RowData>({
  selectionMode,
  showThumb,
  thumb,
  row,
}: {
  selectionMode: boolean;
  showThumb: boolean;
  thumb: ReactNode;
  row: Row<TItem>;
}) {
  if (selectionMode) {
    return (
      <span
        className="flex size-11 shrink-0 items-center justify-center"
        onClickCapture={(event) => event.stopPropagation()}
      >
        <Checkbox
          checked={row.getIsSelected()}
          onCheckedChange={(checked) => row.toggleSelected(!!checked)}
          aria-label="Select item"
        />
      </span>
    );
  }
  if (showThumb) {
    return (
      <span className="flex size-11 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted">
        {thumb}
      </span>
    );
  }
  return null;
}

/** The subtitle-slot + meta-slot values, joined into one ` · `-separated line. */
function RowSubtitle({ parts }: { parts: SubtitlePart[] }) {
  if (parts.length === 0) return null;
  return (
    // One line that truncates as a whole: the leading parts keep their full
    // text and only the tail is clipped — truncating each part separately
    // turns "supplies · Example Tools" into "supp · Exa".
    <span className="block truncate text-xs/4 text-muted-foreground">
      {parts.map((part, index) => (
        <Fragment key={part.id}>
          {index > 0 && <span aria-hidden="true">{" · "}</span>}
          <span
            className={cn(
              part.interactive &&
                cn(
                  "relative z-[1] -my-1 inline-flex min-h-11 items-center align-middle",
                  TOUCH_TRIGGER_CLASS,
                ),
            )}
          >
            {part.value}
          </span>
        </Fragment>
      ))}
    </span>
  );
}

/** The mono trailing value, with any extra values stacked below it. */
function RowTrailingValues({ entries }: { entries: TrailingValueEntry[] }) {
  if (entries.length === 0) return null;
  return (
    <span className="flex max-w-36 shrink-0 flex-col items-end gap-1 overflow-hidden text-right">
      {entries.map(({ key, value, interactive, isPrimary }) => (
        <span
          key={key}
          className={cn(
            isPrimary
              ? "text-sm text-foreground tabular-nums"
              : "text-xs text-muted-foreground",
            interactive &&
              cn(
                "relative z-[1] -my-1 flex min-h-11 min-w-0 items-center justify-end",
                TOUCH_TRIGGER_CLASS,
              ),
          )}
        >
          {value}
        </span>
      ))}
    </span>
  );
}

function RowContent<TItem extends RowData>({
  selectionMode,
  showThumb,
  thumb,
  row,
  title,
  href,
  longPress,
  subtitleParts,
  trailingEntries,
  rowActions,
  children,
}: {
  selectionMode: boolean;
  showThumb: boolean;
  thumb: ReactNode;
  row: Row<TItem>;
  title: string;
  /** The canonical route: the title becomes a link stretched over the row. */
  href?: string;
  longPress: LongPressHandlers;
  subtitleParts: SubtitlePart[];
  trailingEntries: TrailingValueEntry[];
  rowActions?: ReactNode;
  children?: ReactNode;
}) {
  // Two lines, not one: a 375px row keeps a price cell and the `…` menu at the
  // trailing edge, so a single truncated line clips most names at ~14 chars.
  const titleClass = "line-clamp-2 text-sm/5 break-words";
  return (
    <>
      <RowLeading
        selectionMode={selectionMode}
        showThumb={showThumb}
        thumb={thumb}
        row={row}
      />
      <span className="min-w-0">
        {href ? (
          // Stretched link: the `<a>` is the title alone (so its accessible
          // name is the record's name) and its ::after covers the row, which
          // keeps the whole 64px row tappable without nesting the row's own
          // buttons and pickers inside an <a>. Those sit above it at z-[1].
          <Link
            to={href}
            className={cn(
              titleClass,
              "text-foreground after:absolute after:inset-0 after:content-['']",
            )}
            onClick={(event) => {
              if (longPress.consumeClick()) event.preventDefault();
            }}
          >
            {title}
          </Link>
        ) : (
          <span className={titleClass}>{title}</span>
        )}
        <RowSubtitle parts={subtitleParts} />
      </span>
      <RowTrailingValues entries={trailingEntries} />
      {rowActions && (
        <span className="relative z-[1] -my-1 flex min-h-11 min-w-11 items-center justify-center [&_[data-slot=button]]:size-11 [&_button]:size-11">
          {rowActions}
        </span>
      )}
      {children && (
        <span className="relative z-[1] col-span-full">{children}</span>
      )}
    </>
  );
}

interface RowShellProps {
  className: string;
  style: CSSProperties;
  longPress: LongPressHandlers;
  canEnterSelection: boolean;
  children: ReactNode;
}

/**
 * The row shell for a canonical route: a positioned `<div>` the title's
 * stretched link covers (see `RowContent`). Long-press still arms selection
 * from anywhere on the row.
 */
function RowLink({
  className,
  style,
  longPress,
  canEnterSelection,
  children,
}: RowShellProps) {
  return (
    <div
      className={cn(className, "relative")}
      style={style}
      onTouchStart={() => longPress.start()}
      onTouchEnd={longPress.cancel}
      onTouchMove={longPress.cancel}
      onContextMenu={
        canEnterSelection ? (event) => event.preventDefault() : undefined
      }
    >
      {children}
    </div>
  );
}

/**
 * The `<div>` variant of the row shell — selection mode, or no canonical
 * route. `activeClick` (toggle-select, or the row-click fallback) is also
 * what makes the row keyboard-operable: without it the row has no click
 * behavior to guard, so it stays a plain, non-interactive `<div>`.
 */
function RowInteractiveDiv({
  activeClick,
  className,
  style,
  longPress,
  canEnterSelection,
  children,
}: RowShellProps & { activeClick: (() => void) | undefined }) {
  return (
    // A real <button> can't hold this: selection mode nests a Checkbox, and
    // the row can carry its own `…` actions button plus a debug trigger —
    // interactive content can't nest inside a <button>. role/tabIndex/onClick/
    // onKeyDown all key off the same `activeClick` guard, so the element is
    // only ever interactive when a role is present; oxlint's static check
    // can't see through that conditional.
    // oxlint-disable-next-line jsx-a11y/no-static-element-interactions
    <div
      className={className}
      style={style}
      role={activeClick ? "button" : undefined}
      tabIndex={activeClick ? 0 : undefined}
      onTouchStart={() => longPress.start()}
      onTouchEnd={longPress.cancel}
      onTouchMove={longPress.cancel}
      onContextMenu={
        canEnterSelection ? (event) => event.preventDefault() : undefined
      }
      onClick={
        activeClick
          ? (event) => {
              if (longPress.consumeClick()) return;
              if (isInteractiveTarget(event.target)) return;
              activeClick();
            }
          : undefined
      }
      onKeyDown={
        activeClick
          ? (event) => {
              if (event.key !== "Enter" && event.key !== " ") return;
              // A nested control (edit trigger, checkbox, debug button)
              // handles its own activation; don't double-fire the row's.
              if (isInteractiveTarget(event.target)) return;
              event.preventDefault();
              activeClick();
            }
          : undefined
      }
    >
      {children}
    </div>
  );
}

/**
 * One phone-list row: `<a>` (or a `<div>` in selection mode / when the caller
 * has no canonical route), 64px min-height, `44px minmax(0,1fr) auto` grid.
 * Subtitle collapses the subtitle-slot and every meta-slot value into a
 * single ` · `-joined truncated line — no more stacked label/value spec rows.
 */
function PhoneListRow<TItem extends RowData>({
  model,
  isSelectable,
  selectionMode,
  onEnterSelection,
  onRowClick,
  rowActions,
  children,
}: {
  model: MobileListRowModel<TItem>;
  isSelectable: boolean;
  selectionMode: boolean;
  onEnterSelection: () => void;
  onRowClick?: (row: Row<TItem>) => void;
  rowActions?: ReactNode;
  children?: ReactNode;
}) {
  const row = model.row;
  const canEnterSelection = isSelectable && !selectionMode;
  const longPress = useLongPress(
    canEnterSelection ? onEnterSelection : undefined,
  );

  const thumb = model.imageSlot;
  const showThumb = Boolean(thumb);
  const subtitleParts = buildSubtitleParts(model);
  const trailingEntries = trailingValueEntries(model);

  const toggleSelected = () => row.toggleSelected(!row.getIsSelected());
  const fallbackClick =
    !selectionMode && !model.detailsHref && onRowClick
      ? () => onRowClick(row)
      : undefined;
  const activeClick = selectionMode ? toggleSelected : fallbackClick;
  const isLink = !selectionMode && Boolean(model.detailsHref);

  const className = buildRowClassName({
    depth: row.depth,
    isLink,
    activeClick,
    isSelectable,
    selectionMode,
  });
  const style: CSSProperties = {
    gridTemplateColumns: buildGridTemplateColumns({
      selectionMode,
      showThumb,
      hasRowActions: Boolean(rowActions),
    }),
  };

  const content = (
    <RecordSuggestionBoundary record={row.original}>
      <RowContent
        selectionMode={selectionMode}
        showThumb={showThumb}
        thumb={thumb}
        row={row}
        title={model.title}
        href={isLink ? model.detailsHref : undefined}
        longPress={longPress}
        subtitleParts={subtitleParts}
        trailingEntries={trailingEntries}
        rowActions={rowActions}
      >
        {children}
        <RecordRowSuggestions record={row.original} />
      </RowContent>
    </RecordSuggestionBoundary>
  );

  if (isLink && model.detailsHref) {
    return (
      <RowLink
        className={className}
        style={style}
        longPress={longPress}
        canEnterSelection={canEnterSelection}
      >
        {content}
      </RowLink>
    );
  }

  return (
    <RowInteractiveDiv
      activeClick={activeClick}
      className={className}
      style={style}
      longPress={longPress}
      canEnterSelection={canEnterSelection}
    >
      {content}
    </RowInteractiveDiv>
  );
}

/** The row's `…` actions slot: the expand/collapse tree toggle plus any caller actions. */
function resolveRowActions<TItem extends RowData>(
  row: Row<TItem>,
  model: MobileListRowModel<TItem>,
): ReactNode {
  const treeToggle = row.getCanExpand() ? (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-expanded={row.getIsExpanded()}
      aria-label={row.getIsExpanded() ? "Collapse" : "Expand"}
      onClick={(event) => {
        event.stopPropagation();
        row.getToggleExpandedHandler()();
      }}
    >
      <CaretRightIcon
        className={cn(
          "size-4 transition-transform",
          row.getIsExpanded() && "rotate-90",
        )}
      />
    </Button>
  ) : null;
  if (!treeToggle && !model.actionsContent) return undefined;
  return (
    <div className="flex items-center gap-1">
      {treeToggle}
      {model.actionsContent}
    </div>
  );
}

/** Debug footer rendered into the row's children slot only in debug mode. */
function resolveDebugContent<TItem extends RowData>(
  isDebugEnabled: boolean,
  row: Row<TItem>,
): ReactNode {
  if (!isDebugEnabled) return undefined;
  return (
    <div className="flex items-center gap-1">
      <DebugDialog
        data={row.original}
        title={`Debug Data - Row ${row.id}`}
        trigger={
          <Button variant="ghost" size="icon-sm" className="size-11">
            <BugIcon className="size-3" />
            <span className="sr-only">Debug row data</span>
          </Button>
        }
      />
    </div>
  );
}

function resolveListAriaLabel(entity: Entity | undefined): string {
  if (entity && isBrowserRoutedEntity(entity)) {
    return `${entities[entity].pluralLabel} list`;
  }
  return "Records list";
}

/** The infinite-scroll sentinel still prefetches; the button is the explicit trigger. */
function InfiniteScrollFooter({
  infiniteScroll,
  sentinelRef,
}: {
  infiniteScroll: InfiniteScrollControls;
  sentinelRef: ReturnType<typeof useInfiniteScrollSentinel>;
}) {
  const isFetchingNextPage = infiniteScroll.isFetchingNextPage ?? false;
  return (
    <>
      <div ref={sentinelRef} className="h-1" />
      {infiniteScroll.hasNextPage && (
        <div className="m-3">
          <Button
            type="button"
            variant="outline"
            className="h-11 w-full"
            disabled={isFetchingNextPage}
            onClick={() => infiniteScroll.fetchNextPage()}
          >
            {isFetchingNextPage ? (
              <Spinner size="sm" className="text-muted-foreground" />
            ) : (
              "Show 50 more"
            )}
          </Button>
        </div>
      )}
    </>
  );
}

function MobileCardEmptyState<TItem extends RowData>({
  emptyState,
  entity,
  table,
}: {
  emptyState?: ReactNode;
  entity?: Entity;
  table: ITable<TItem>;
}) {
  if (emptyState) {
    return (
      <div className="px-2 py-6 text-center text-sm text-muted-foreground">
        {emptyState}
      </div>
    );
  }
  if (entity && isBrowserRoutedEntity(entity)) {
    return <EntityEmptyState entity={entity} isFiltered={isNarrowed(table)} />;
  }
  return <FilteredEmptyState isFiltered={isNarrowed(table)} />;
}

interface MobileCardViewProps<TItem extends RowData> {
  table: ITable<TItem>;
  onRowClick?: (row: Row<TItem>) => void;
  /** Entity type for navigation - when provided, cards show a view button */
  entity?: Entity;
  getDetailsHref?: (item: TItem) => string | undefined;
  disableDetailsHref?: boolean;
  renderRowFooter?: (item: TItem) => ReactNode;
  /** Infinite scroll controls — when provided, auto-loads more at bottom */
  infiniteScroll?: InfiniteScrollControls;
  /** Group configuration for section headers */
  groupConfig?: GroupConfig<TItem>;
  /** Whether grouping is currently active */
  grouped?: boolean;
  isTransitioning?: boolean;
  /** External cell-render state snapshot; see useTableConfig. */
  rowContentVersion?: unknown;
  emptyState?: ReactNode;
}

export function MobileCardView<TItem extends RowData>({
  table,
  onRowClick,
  entity,
  getDetailsHref,
  disableDetailsHref,
  renderRowFooter,
  infiniteScroll,
  groupConfig,
  grouped = false,
  isTransitioning = false,
  rowContentVersion,
  emptyState,
}: MobileCardViewProps<TItem>) {
  const { isDebugEnabled } = useDebug();
  const mobileRows = useMobileListModel({
    table,
    entity,
    getDetailsHref,
    disableDetailsHref,
    rowContentVersion,
  });

  // Group the live mobile models themselves. `useTable` keeps its table
  // instance stable while replacing the row model as infinite pages arrive,
  // so deriving from `table` would leave grouped mobile lists on stale data.
  // Keeping each model as the grouped item also prevents a sorted section from
  // being resolved back through an index belonging to the pre-grouped order.
  const mobileGroupConfig = useMemo(
    () =>
      groupConfig
        ? {
            field: groupConfig.field,
            keyFn: (model: (typeof mobileRows)[number]) =>
              groupConfig.keyFn(model.row.original),
            colorFn: groupConfig.colorFn,
            groups: groupConfig.groups,
          }
        : undefined,
    [groupConfig],
  );
  const groupedItems = useGroupedList(mobileRows, mobileGroupConfig, grouped);

  // Determine virtualizer item count and estimate sizes
  const itemCount = groupedItems ? groupedItems.length : mobileRows.length;
  // Estimated per row, not as one constant: rows now range from ~55px (no spec
  // values) to ~152px (a fully-populated expense), and a flat guess that far
  // off makes getTotalSize() lurch as measurements land during a fast scroll.
  const estimateSize = useCallback(
    (index: number) => {
      if (groupedItems) {
        const item = groupedItems[index];
        if (!item) return 56;
        if (item.kind === "header") return 36;
        return estimateMobileRowHeight(item.item) + (renderRowFooter ? 52 : 0);
      }
      return (
        estimateMobileRowHeight(mobileRows[index]) + (renderRowFooter ? 52 : 0)
      );
    },
    [groupedItems, mobileRows, renderRowFooter],
  );

  // Ref for scrollMargin offset calculation
  const listRef = useRef<HTMLDivElement>(null);

  const getItemKey = useCallback(
    (index: number) => {
      if (groupedItems) {
        const item = groupedItems[index];
        if (!item) return `missing:${index}`;
        return item.kind === "header"
          ? `group:${item.key ?? item.title}`
          : `row:${item.item.row.id}`;
      }
      return `row:${mobileRows[index]?.row.id ?? index}`;
    },
    [groupedItems, mobileRows],
  );

  // Window virtualizer — scrolls against the window, not a container
  const virtualizer = useWindowVirtualizer({
    count: itemCount,
    getItemKey,
    estimateSize,
    // A count, not a pixel budget — and rows got ~2.5x taller, each carrying
    // several edit-triggers. 8 would now hold far more (and heavier) DOM than
    // it did; 4 still covers ~600px on the dense lists.
    overscan: 4,
    scrollMargin: listRef.current?.offsetTop ?? 0,
  });

  const sentinelRef = useInfiniteScrollSentinel(infiniteScroll, "200px");

  const hasRowSelection = table.options.enableRowSelection !== false;
  const hasSelectColumn = table
    .getAllColumns()
    .some((col) => col.id === "select");
  const isSelectable = hasRowSelection && hasSelectColumn;

  // Checkboxes are a 44px gutter on EVERY row for an action most taps never
  // take, so selection is a mode: long-press a row to enter it (the iOS
  // convention), and it ends when the last row is deselected.
  const [selectionArmed, setSelectionArmed] = useState(false);
  const anySelected = table.getSelectedRowModel().rows.length > 0;
  const selectionMode = isSelectable && (selectionArmed || anySelected);
  useEffect(() => {
    if (!anySelected) setSelectionArmed(false);
  }, [anySelected]);

  const virtualItems = virtualizer.getVirtualItems();

  const renderVirtualItem = (vi: (typeof virtualItems)[number]) => {
    if (groupedItems) {
      const gItem = groupedItems[vi.index];
      if (!gItem) return null;

      if (gItem.kind === "header") {
        return (
          <VirtualRow
            key={`header-${gItem.key ?? gItem.title}`}
            vi={vi}
            virtualizer={virtualizer}
            role="presentation"
          >
            <SectionHeader
              title={gItem.title}
              count={gItem.count}
              color={gItem.color}
            />
          </VirtualRow>
        );
      }

      return renderRowItem(vi, gItem.item);
    }

    const model = mobileRows[vi.index];
    if (!model) return null;
    return renderRowItem(vi, model);
  };

  const renderRowItem = (
    vi: (typeof virtualItems)[number],
    model: (typeof mobileRows)[number],
  ) => {
    const row = model.row;
    const card = (
      <PhoneListRow
        model={model}
        isSelectable={isSelectable}
        selectionMode={selectionMode}
        onEnterSelection={() => {
          setSelectionArmed(true);
          row.toggleSelected(true);
        }}
        onRowClick={onRowClick}
        rowActions={resolveRowActions(row, model)}
      >
        {renderRowFooter?.(row.original)}
        {resolveDebugContent(isDebugEnabled, row)}
      </PhoneListRow>
    );

    return (
      <VirtualRow key={row.id} vi={vi} virtualizer={virtualizer}>
        {card}
      </VirtualRow>
    );
  };

  return (
    <ul
      className="block overflow-x-hidden lg:hidden"
      aria-label={resolveListAriaLabel(entity)}
      aria-busy={isTransitioning}
      inert={isTransitioning ? true : undefined}
    >
      {itemCount > 0 ? (
        <div ref={listRef}>
          <div
            style={{
              height: `${virtualizer.getTotalSize()}px`,
              width: "100%",
              position: "relative",
            }}
          >
            {virtualItems.map(renderVirtualItem)}
          </div>

          {infiniteScroll && (
            <InfiniteScrollFooter
              infiniteScroll={infiniteScroll}
              sentinelRef={sentinelRef}
            />
          )}
        </div>
      ) : (
        <MobileCardEmptyState
          emptyState={emptyState}
          entity={entity}
          table={table}
        />
      )}
    </ul>
  );
}
