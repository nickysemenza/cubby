import type { Entity } from "@cubby/schemas/entity";
import { Link } from "@tanstack/react-router";
import { ChevronRight, type LucideIcon } from "lucide-react";
import { Fragment, type HTMLAttributes, type ReactNode } from "react";
import type { MobileMetaValue } from "~/app/_components/data-table/useMobileListModel";
import { Row, Stack } from "~/components/layout";
import { Checkbox } from "~/components/ui/checkbox";
import { Description } from "~/components/ui/description";
import { Eyebrow } from "~/components/ui/eyebrow";
import { entities } from "~/entities/entities";
import { useLongPress } from "~/hooks/useLongPress";
import { cn } from "~/lib/utils";

interface MobileCardProps {
  selectable?: {
    isSelected: boolean;
    onSelectionChange: (checked: boolean) => void;
  };
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
  detailsHref?: string;
  title?: string;
  titleIcon?: LucideIcon;
  subtitle?: ReactNode;
  imageSlot?: ReactNode;
  entity?: Entity;
  onClick?: () => void;
  onTouchStart?: () => void;
  /**
   * Press-and-hold handler — the row variant's way into selection mode, so a
   * checkbox gutter isn't spent on every row for an action most taps never
   * take. Suppresses the subsequent click so holding doesn't also navigate.
   */
  onLongPress?: () => void;
  /**
   * Display variant:
   * - "card" (default): bordered card with shadow, used by LocationCardGrid, ProblemSection
   * - "row": compact row with bottom divider, used by MobileCardView for dense lists
   */
  variant?: "card" | "row";
  rightValues?: ReactNode[];
  /**
   * Parallel array to `rightValues` — `rightValueInteractive[i] === true`
   * skips the truncating `text-2xs` wrapper for `rightValues[i]` so an
   * interactive control inside it (e.g. an edit-trigger pencil) isn't
   * clipped/cramped below a usable tap target. Omit for plain text values.
   */
  rightValueInteractive?: boolean[];
  /**
   * Labeled values rendered as a spec grid below the identity line. Unlabeled
   * at six values these read as noise, so each carries its column's header.
   */
  metaValues?: MobileMetaValue[];
}

/**
 * A single right-aligned value in the compact row variant's second line.
 * Plain values get the dense, truncating mono-2xs treatment; `interactive`
 * values (an editable cell's edit-trigger, a quick-edit pencil, …) render
 * without truncation/overflow-hidden so their tap targets stay intact.
 */
function RightValueSlot({
  node,
  interactive,
}: {
  node: ReactNode;
  interactive?: boolean;
}) {
  if (interactive) {
    // Bounded (overflow-hidden + max-w) so this slot can't bleed into its
    // sibling, but no forced `[&_*]:truncate`/`whitespace-nowrap` — those
    // clipped the trailing edit-trigger pencil below a usable tap target.
    // The cell's own markup already nests a `min-w-0 truncate` text span next
    // to a `shrink-0` pencil, so bounding just the outer box lets flexbox
    // shrink the text and keep the pencil at full size.
    return (
      <span className="flex min-w-0 max-w-32 items-center overflow-hidden text-2xs text-muted-foreground">
        {node}
      </span>
    );
  }
  return (
    <span className="flex min-w-0 max-w-28 items-center overflow-hidden whitespace-nowrap font-mono text-2xs text-muted-foreground tabular-nums [&_*]:truncate">
      {node}
    </span>
  );
}

/**
 * The row variant's chrome — grid, divider, padding, and column derivation —
 * shared by `MobileCard` and the loading skeleton so the two can't drift
 * (they had already diverged on the divider: `border-border/30` vs `/60`).
 *
 * The outer grid stays two rows no matter how tall the content gets: the
 * identity line and the spec block are ONE grid item that stacks internally,
 * so `row-span-2` on the side cells stays correct and nothing has to count
 * lines.
 */
export function MobileRowShell({
  leading = [],
  title,
  content,
  actions,
  footer,
  tall,
  className,
  ...divProps
}: {
  /** Checkbox / image cells, in order. Determines the column template. */
  leading?: ReactNode[];
  title: ReactNode;
  content?: ReactNode;
  actions?: ReactNode;
  footer?: ReactNode;
  /** Content is taller than the side cells — align them to the top instead. */
  tall?: boolean;
  className?: string;
  // `title` and `content` above are nodes; both are also HTML attribute names
  // (tooltip, microdata) that `HTMLAttributes` types as strings, so omit them
  // from the spread rather than letting the two meanings collide.
} & Omit<HTMLAttributes<HTMLDivElement>, "title" | "content">) {
  const span = content != null ? "row-span-2" : undefined;
  const align = tall ? "self-start" : "self-center";
  return (
    <div
      className={cn(
        "grid w-full max-w-full gap-x-2 overflow-hidden border-border/60 border-b px-2 py-2",
        leading.length === 2
          ? "grid-cols-[auto_auto_1fr_auto]"
          : leading.length === 1
            ? "grid-cols-[auto_1fr_auto]"
            : "grid-cols-[1fr_auto]",
        tall ? "items-start" : "items-center",
        className,
      )}
      {...divProps}
    >
      {leading.map((node, index) => (
        <div
          // Callers key their own nodes ("select"/"image"); the index is the
          // fallback for the fixed-order slots.
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed-order slots
          key={index}
          className={cn(span, align)}
        >
          {node}
        </div>
      ))}
      {title}
      <div className={cn(span, align)}>{actions}</div>
      {content}
      {/* Explicit placement — auto-placed children landed in the checkbox
          column's 44px gutter. */}
      {footer && <div className="col-span-full">{footer}</div>}
    </div>
  );
}

/**
 * The spec grid: a mono label gutter + value column. Exported so the skeleton
 * reproduces the exact geometry.
 */
export const MOBILE_SPEC_GRID_CLASS =
  "grid grid-cols-[4.5rem_minmax(0,1fr)] items-center gap-x-2 gap-y-1";

/**
 * A mobile-friendly card component with optional selection checkbox.
 * Provides consistent layout: [Checkbox] | Content | [Actions]
 *
 * Supports two modes:
 * - Structured: Pass title/subtitle props for automatic header rendering
 * - Flexible: Pass children for full control over content
 *
 * Used by:
 * - MobileCardView for entity lists (with optional selection)
 * - LocationInventoryTable for inventory items with inline editing
 * - ProblemSection and LocationCardGrid for entity previews
 */
export function MobileCard({
  selectable,
  actions,
  children,
  className,
  detailsHref,
  title,
  titleIcon: TitleIcon,
  subtitle,
  imageSlot,
  entity,
  onClick,
  onTouchStart,
  variant = "card",
  rightValues,
  rightValueInteractive,
  metaValues,
  onLongPress,
}: MobileCardProps) {
  const longPress = useLongPress(onLongPress);
  const borderColor = entity
    ? entities[entity].color.border
    : "border-l-primary";

  const isRow = variant === "row";
  const specValues = metaValues ?? [];
  const hasIdentityLine = Boolean(subtitle || rightValues?.length);
  const hasSpec = specValues.length > 0;

  if (isRow) {
    const content =
      hasIdentityLine || hasSpec ? (
        <Stack gap="tight" className="min-w-0">
          {hasIdentityLine && (
            <Row align="center" gap="sm" className="min-w-0">
              {subtitle && (
                <Description
                  as="span"
                  size="xs"
                  className="block min-w-0 flex-1 truncate"
                >
                  {subtitle}
                </Description>
              )}
              <Row
                align="center"
                justify="end"
                gap="sm"
                className="ml-auto shrink-0"
              >
                {rightValues?.map((node, index) => (
                  <RightValueSlot
                    // biome-ignore lint/suspicious/noArrayIndexKey: positional slots
                    key={index}
                    node={node}
                    interactive={rightValueInteractive?.[index]}
                  />
                ))}
              </Row>
            </Row>
          )}
          {hasSpec && (
            <dl className={MOBILE_SPEC_GRID_CLASS}>
              {specValues.map((item) => (
                <Fragment key={item.id}>
                  <Eyebrow as="dt" className="truncate">
                    {item.label}
                  </Eyebrow>
                  <dd
                    className={cn(
                      "min-w-0 text-xs",
                      item.interactive
                        ? // Stretch the cell WRAPPER, not the edit trigger.
                          // Widening the trigger itself made it take the
                          // wrapper's whole width, starving the sibling
                          // `min-w-0 truncate` value span to 0px — the value
                          // was in the DOM and invisible on screen.
                          "flex min-h-8 items-center [&>*]:w-full"
                        : // Room to wrap now, and hiding data is the bug being
                          // fixed — so clamp rather than truncate.
                          "line-clamp-2 text-muted-foreground",
                    )}
                  >
                    {item.value}
                  </dd>
                </Fragment>
              ))}
            </dl>
          )}
        </Stack>
      ) : undefined;

    return (
      <MobileRowShell
        className={cn(
          // Touch devices have no :hover — give a pressed state so taps register.
          onClick && "cursor-pointer transition-colors active:bg-muted/50",
          // A row involved in long-press selection must opt out of iOS's own
          // long-press: Safari otherwise starts a text selection and raises the
          // Copy/Look Up callout on top of the selection we just made.
          //
          // `selectable` matters as much as `onLongPress` here — once selection
          // mode is on, rows stop taking a long press (they toggle on tap), so
          // gating on `onLongPress` alone would drop the opt-out for the rest
          // of the session and let the callout reappear the moment a thumb
          // lingers while adding another row.
          (onLongPress || selectable) &&
            "select-none [-webkit-touch-callout:none]",
          className,
        )}
        // The side cells centre against a short row, but a tall spec block
        // would leave them floating mid-row — pin them to the title line.
        tall={hasSpec}
        leading={[
          selectable ? (
            <div
              key="select"
              className="flex min-h-[44px] min-w-[44px] items-center justify-center"
              onClickCapture={(e) => e.stopPropagation()}
            >
              <Checkbox
                checked={selectable.isSelected}
                onCheckedChange={(checked) =>
                  selectable.onSelectionChange(!!checked)
                }
                className="shrink-0"
                aria-label="Select item"
              />
            </div>
          ) : null,
          imageSlot ? (
            <div key="image" className="size-11 overflow-hidden rounded">
              {imageSlot}
            </div>
          ) : null,
        ].filter(Boolean)}
        title={
          <Row align="baseline" gap="sm" className="min-w-0">
            {TitleIcon && (
              <TitleIcon
                className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" /* tight */
              />
            )}
            <span
              className="block min-w-0 flex-1 truncate font-medium text-sm leading-snug"
              title={title}
            >
              {title}
            </span>
          </Row>
        }
        content={content}
        actions={actions}
        footer={children}
        onClick={(e) => {
          if (longPress.consumeClick()) {
            e.preventDefault();
            return;
          }
          onClick?.();
        }}
        onTouchStart={() => {
          onTouchStart?.();
          longPress.start();
        }}
        onTouchEnd={longPress.cancel}
        onTouchMove={longPress.cancel}
        onContextMenu={onLongPress ? (e) => e.preventDefault() : undefined}
        onKeyDown={onClick ? (e) => e.key === "Enter" && onClick() : undefined}
        role={onClick ? "button" : undefined}
        tabIndex={onClick ? 0 : undefined}
      />
    );
  }

  // Card layout: original bordered card style
  return (
    <Row
      align="start"
      gap="sm"
      className={cn(
        // No mount fade-in: the mobile list is virtualized, so a per-card
        // fade-in replays every time a card scrolls back into view (flicker).
        "rounded-lg border border-[var(--border)] border-l-4 bg-card p-2",
        borderColor,
        // Touch devices have no :hover — give a pressed state so taps register.
        onClick && "cursor-pointer active:bg-muted/40",
        className,
      )}
      onClick={onClick}
      onTouchStart={onTouchStart}
      onKeyDown={onClick ? (e) => e.key === "Enter" && onClick() : undefined}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
    >
      {selectable && (
        <div
          className="flex min-h-[44px] min-w-[44px] items-center justify-center"
          onClickCapture={(e) => e.stopPropagation()}
        >
          <Checkbox
            checked={selectable.isSelected}
            onCheckedChange={(checked) =>
              selectable.onSelectionChange(!!checked)
            }
            aria-label="Select item"
          />
        </div>
      )}
      <Stack gap="sm" className="min-w-0 flex-1">
        {(title || detailsHref || actions) && (
          <Row align="start" gap="sm">
            {imageSlot}
            {title && (
              <div className="min-w-0 flex-1">
                <Row
                  as="h5"
                  align="start"
                  gap="sm"
                  className="min-w-0 font-medium"
                >
                  {TitleIcon && (
                    <TitleIcon
                      className="mt-0.5 size-4 shrink-0 text-muted-foreground" /* tight */
                    />
                  )}
                  <span className="line-clamp-2" title={title}>
                    {title}
                  </span>
                </Row>
                {subtitle && (
                  <Description className="truncate">{subtitle}</Description>
                )}
              </div>
            )}
            {(detailsHref || actions) && (
              <Row align="center" gap="xs" className="shrink-0">
                {detailsHref && (
                  <Link
                    to={detailsHref}
                    className="flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    aria-label="View details"
                  >
                    <ChevronRight className="size-4" />
                  </Link>
                )}
                {actions}
              </Row>
            )}
          </Row>
        )}
        {children}
      </Stack>
    </Row>
  );
}
