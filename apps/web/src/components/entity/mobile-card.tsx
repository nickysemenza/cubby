import { CaretRightIcon as ChevronRight } from "@phosphor-icons/react/dist/csr/CaretRight";
import type { Icon } from "@phosphor-icons/react/lib";
import { Link } from "@tanstack/react-router";
import {
  Children,
  Fragment,
  type HTMLAttributes,
  type MouseEvent,
  type ReactNode,
} from "react";

import type { MobileMetaValue } from "~/app/_components/data-table/useMobileListModel";
import { Row, Stack } from "~/components/layout";
import { Checkbox } from "~/components/ui/checkbox";
import { Description } from "~/components/ui/description";
import { Eyebrow } from "~/components/ui/eyebrow";
import { type LongPressHandlers, useLongPress } from "~/hooks/useLongPress";
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
  titleIcon?: Icon;
  subtitle?: ReactNode;
  imageSlot?: ReactNode;
  reserveImageSlot?: boolean;
  onClick?: () => void;
  onTouchStart?: () => void;
  /**
   * Press-and-hold handler — the row variant's way into selection mode, so a
   * checkbox gutter isn't spent on every row for an action most taps never
   * take. Suppresses the subsequent click so holding doesn't also navigate.
   */
  onLongPress?: () => void;
  variant?: "card" | "row";
  rightValues?: ReactNode[];
  /**
   * Parallel array to `rightValues` — `rightValueInteractive[i] === true`
   * skips the truncating `text-2xs` wrapper for `rightValues[i]` so an
   * interactive control inside it (e.g. an edit-trigger pencil) isn't
   * clipped/cramped below a usable tap target. Omit for plain text values.
   */
  rightValueInteractive?: boolean[];
  metaValues?: MobileMetaValue[];
}

function PrimaryTitle({
  title,
  detailsHref,
  onClick,
  titleIcon: TitleIcon,
  iconClassName = "size-3.5",
}: {
  title: string | undefined;
  detailsHref?: string;
  onClick?: () => void;
  titleIcon?: Icon;
  iconClassName?: string;
}) {
  const content = (
    <span className="flex min-w-0 items-baseline gap-2 text-left">
      {TitleIcon && (
        <TitleIcon
          className={cn("mt-0.5 shrink-0 text-muted-foreground", iconClassName)}
        />
      )}
      <span
        className="line-clamp-2 min-w-0 flex-1 text-sm leading-snug font-medium break-words"
        title={title}
      >
        {title}
      </span>
    </span>
  );

  if (detailsHref) {
    return (
      <Link
        to={detailsHref}
        className="flex min-h-11 w-full min-w-0 items-center text-left"
      >
        {content}
      </Link>
    );
  }
  if (onClick) {
    return (
      <button
        type="button"
        className="flex min-h-11 w-full min-w-0 items-center text-left"
        onClick={onClick}
      >
        {content}
      </button>
    );
  }
  return content;
}

function handleBodyClick(event: MouseEvent<HTMLElement>, onClick?: () => void) {
  if (!onClick) return;
  const target = event.target;
  if (
    target instanceof Element &&
    target.closest("a,button,input,select,textarea")
  ) {
    return;
  }
  onClick();
}

// Keep the desktop trigger compact; cards supply the 44px touch target.
const TOUCH_TRIGGER_CLASS = cn(
  "[&_[data-cell-edit-trigger]]:min-h-11",
  "[&_[data-cell-edit-trigger]:has(>svg:only-child)]:min-w-11",
  "[&_[data-cell-edit-trigger]:has(>svg:only-child)]:justify-center",
);

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
    //
    // Height is the tap target, and this one WRITES: a 24px trigger on the
    // identity line is the control that edits production data, so the slot
    // carries a 44px box and the trigger stretches to fill it. `-my-1` spends
    // the row's own padding rather than growing the card by the full 20px.
    return (
      <span
        className={cn(
          "-my-1 flex min-h-11 max-w-32 min-w-0 items-center overflow-hidden text-2xs text-muted-foreground",
          TOUCH_TRIGGER_CLASS,
        )}
      >
        {node}
      </span>
    );
  }
  return (
    <span className="flex max-w-28 min-w-0 items-center overflow-hidden font-mono text-2xs whitespace-nowrap text-muted-foreground tabular-nums [&_*]:truncate">
      {node}
    </span>
  );
}

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
  leading?: ReactNode[];
  title: ReactNode;
  content?: ReactNode;
  actions?: ReactNode;
  footer?: ReactNode;
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
        "grid min-h-11 w-full max-w-full gap-x-2 overflow-hidden border-b border-border/60 px-2 py-2",
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
      {Children.map(leading, (node) => (
        <div className={cn(span, align)}>{node}</div>
      ))}
      {title}
      <div
        className={cn(
          span,
          align,
          // The overflow menu ships as a 24px desktop trigger; the phone needs
          // 44. `-my-1` spends the row's existing vertical padding so the taller
          // target doesn't push the row down with it.
          actions != null &&
            "-my-1 flex min-h-11 min-w-11 items-center justify-center [&_[data-slot=button]]:size-11 [&_button]:size-11",
        )}
      >
        {actions}
      </div>
      {content}
      {/* Explicit placement — auto-placed children landed in the checkbox
          column's 44px gutter. */}
      {footer && <div className="col-span-full">{footer}</div>}
    </div>
  );
}

export const MOBILE_SPEC_GRID_CLASS =
  "grid grid-cols-[6.5rem_minmax(0,1fr)] items-center gap-x-2 gap-y-1";

type MobileRowProps = Omit<MobileCardProps, "variant"> & {
  longPress: LongPressHandlers;
};

function CompactMobileRow({
  selectable,
  actions,
  children,
  className,
  detailsHref,
  title,
  titleIcon,
  subtitle,
  imageSlot,
  reserveImageSlot = false,
  onClick,
  onTouchStart,
  rightValues,
  rightValueInteractive,
  metaValues,
  onLongPress,
  longPress,
}: MobileRowProps) {
  const specValues = metaValues ?? [];
  const hasIdentityLine = Boolean(subtitle || rightValues?.length);
  const hasSpec = specValues.length > 0;
  const content =
    hasIdentityLine || hasSpec ? (
      <Stack gap="tight" className="min-w-0">
        {hasIdentityLine && (
          <Row align="center" gap="sm" className="min-w-0">
            {subtitle && (
              <Description
                as="span"
                size="xs"
                className={cn(
                  "block min-w-0 flex-1 truncate",
                  TOUCH_TRIGGER_CLASS,
                )}
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
              {Children.map(rightValues, (node, index) => (
                <RightValueSlot
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
                <Eyebrow
                  as="dt"
                  className="font-sans text-xs tracking-normal break-words normal-case"
                >
                  {item.label}
                </Eyebrow>
                <dd
                  className={cn(
                    "min-w-0 text-xs",
                    item.interactive
                      ? cn(
                          "-my-1 flex min-h-11 items-center [&>*]:w-full",
                          TOUCH_TRIGGER_CLASS,
                        )
                      : "line-clamp-2 text-muted-foreground",
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
        onClick && "cursor-pointer transition-colors active:bg-muted/50",
        (onLongPress || selectable) &&
          "select-none [-webkit-touch-callout:none]",
        className,
      )}
      tall={hasSpec}
      leading={[
        selectable ? (
          <div
            key="select"
            className="flex min-h-[44px] min-w-[44px] items-center justify-center"
            onClickCapture={(event) => event.stopPropagation()}
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
        imageSlot || reserveImageSlot ? (
          <div key="image" className="size-11 overflow-hidden">
            {imageSlot}
          </div>
        ) : null,
      ].filter(Boolean)}
      title={
        <PrimaryTitle
          title={title}
          detailsHref={detailsHref}
          onClick={onClick}
          titleIcon={titleIcon}
        />
      }
      content={content}
      actions={actions}
      footer={children}
      onClick={(event) => {
        if (longPress.consumeClick()) {
          event.preventDefault();
          return;
        }
        handleBodyClick(event, onClick);
      }}
      onTouchStart={() => {
        onTouchStart?.();
        longPress.start();
      }}
      onTouchEnd={longPress.cancel}
      onTouchMove={longPress.cancel}
      onContextMenu={
        onLongPress ? (event) => event.preventDefault() : undefined
      }
      role={onClick || detailsHref ? "group" : undefined}
    />
  );
}

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
  reserveImageSlot = false,
  onClick,
  onTouchStart,
  variant = "card",
  rightValues,
  rightValueInteractive,
  metaValues,
  onLongPress,
}: MobileCardProps) {
  const longPress = useLongPress(onLongPress);
  if (variant === "row") {
    return (
      <CompactMobileRow
        selectable={selectable}
        actions={actions}
        className={className}
        detailsHref={detailsHref}
        title={title}
        titleIcon={TitleIcon}
        subtitle={subtitle}
        imageSlot={imageSlot}
        reserveImageSlot={reserveImageSlot}
        onClick={onClick}
        onTouchStart={onTouchStart}
        rightValues={rightValues}
        rightValueInteractive={rightValueInteractive}
        metaValues={metaValues}
        onLongPress={onLongPress}
        longPress={longPress}
      >
        {children}
      </CompactMobileRow>
    );
  }

  return (
    <Row
      align="start"
      gap="sm"
      className={cn(
        // No mount fade-in: the mobile list is virtualized, so a per-card
        // fade-in replays every time a card scrolls back into view (flicker).
        "border border-[var(--border)] bg-card p-2",
        // Touch devices have no :hover — give a pressed state so taps register.
        onClick && "cursor-pointer active:bg-muted/40",
        className,
      )}
      onClick={(event) => handleBodyClick(event, onClick)}
      onTouchStart={onTouchStart}
      role={onClick || detailsHref ? "group" : undefined}
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
                  <PrimaryTitle
                    title={title}
                    detailsHref={detailsHref}
                    onClick={onClick}
                    titleIcon={TitleIcon}
                    iconClassName="size-4"
                  />
                </Row>
                {subtitle && (
                  <Description className="truncate">{subtitle}</Description>
                )}
              </div>
            )}
            {(detailsHref || actions) && (
              // Same phone touch floor the compact variant's actions cell
              // gets: the overflow menu ships as a 24px desktop trigger, which
              // is roughly half a fingertip on the control that opens a row's
              // destructive actions.
              <Row
                align="center"
                gap="xs"
                className="shrink-0 [&_[data-slot=button]]:size-11 [&_button]:size-11"
              >
                {detailsHref && (
                  <Link
                    to={detailsHref}
                    className="flex size-11 items-center justify-center text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
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
