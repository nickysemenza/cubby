import type { Entity } from "@cubby/schemas/entity";
import { Link } from "@tanstack/react-router";
import { ChevronRight, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Row, Stack } from "~/components/layout";
import { Checkbox } from "~/components/ui/checkbox";
import { Description } from "~/components/ui/description";
import { entities } from "~/entities/entities";
import { useLongPress } from "~/hooks/useLongPress";
import { cn } from "~/lib/utils";

interface MobileCardProps {
  /** Optional selection state - omit for non-selectable cards */
  selectable?: {
    isSelected: boolean;
    onSelectionChange: (checked: boolean) => void;
  };
  /** Optional actions element (typically a dropdown menu) */
  actions?: ReactNode;
  /** Main content of the card */
  children?: ReactNode;
  /** Additional className for the card container */
  className?: string;
  /** Optional link to details page - renders a visible view button */
  detailsHref?: string;
  /** Optional title - renders structured header when provided */
  title?: string;
  /** Optional icon for title */
  titleIcon?: LucideIcon;
  /** Optional subtitle below title */
  subtitle?: ReactNode;
  /** Optional image/thumbnail to render left of the title */
  imageSlot?: ReactNode;
  /** Optional entity type for colored accent border */
  entity?: Entity;
  /** Optional click handler for the entire card */
  onClick?: () => void;
  /** Optional touchstart handler (e.g., for route preloading) */
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
  /** Right-aligned values for compact row variant (max 2 lines) */
  rightValues?: ReactNode[];
  /**
   * Parallel array to `rightValues` — `rightValueInteractive[i] === true`
   * skips the truncating `text-2xs` wrapper for `rightValues[i]` so an
   * interactive control inside it (e.g. an edit-trigger pencil) isn't
   * clipped/cramped below a usable tap target. Omit for plain text values.
   */
  rightValueInteractive?: boolean[];
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
  onLongPress,
}: MobileCardProps) {
  const longPress = useLongPress(onLongPress);
  const borderColor = entity
    ? entities[entity].color.border
    : "border-l-primary";

  const isRow = variant === "row";
  const hasSecondLine =
    isRow && (subtitle || (rightValues && rightValues.length > 0));

  if (isRow) {
    // Compact row layout using CSS grid:
    //   Col: [checkbox?] [image?] [content: 1fr] [actions?]
    //   Row 1: title
    //   Row 2: subtitle ... rightValues
    return (
      // biome-ignore lint/a11y/noStaticElementInteractions: role, tabIndex, and onKeyDown are conditionally set based on onClick
      <div
        className={cn(
          "grid w-full max-w-full items-center gap-x-2 overflow-hidden border-border/60 border-b px-2 py-2",
          // Dynamic grid columns based on which slots are present
          selectable && imageSlot
            ? "grid-cols-[auto_auto_1fr_auto]"
            : selectable || imageSlot
              ? "grid-cols-[auto_1fr_auto]"
              : "grid-cols-[1fr_auto]",
          // Touch devices have no :hover — give a pressed state so taps register.
          onClick && "cursor-pointer transition-colors active:bg-muted/50",
          className,
        )}
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
      >
        {/* Checkbox */}
        {selectable && (
          <div
            className={cn(
              "flex min-h-[44px] min-w-[44px] items-center justify-center self-center",
              hasSecondLine && "row-span-2",
            )}
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
        )}

        {/* Image */}
        {imageSlot && (
          <div
            className={cn(
              "size-11 self-center overflow-hidden rounded",
              hasSecondLine && "row-span-2",
            )}
          >
            {imageSlot}
          </div>
        )}

        {/* Title (content column, row 1) */}
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

        {/* Actions */}
        <div className={cn("self-center", hasSecondLine && "row-span-2")}>
          {actions}
        </div>

        {/* Second line (content column, row 2) */}
        {hasSecondLine && (
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
              {rightValues?.[0] !== undefined && (
                <RightValueSlot
                  node={rightValues[0]}
                  interactive={rightValueInteractive?.[0]}
                />
              )}
              {rightValues?.[1] !== undefined && (
                <RightValueSlot
                  node={rightValues[1]}
                  interactive={rightValueInteractive?.[1]}
                />
              )}
            </Row>
          </Row>
        )}

        {/* Extra children (debug, etc.) */}
        {children}
      </div>
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
