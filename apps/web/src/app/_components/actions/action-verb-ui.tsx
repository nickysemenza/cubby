import type { RowData } from "@tanstack/react-table";
import type { ComponentProps, ReactElement } from "react";
import { Button } from "~/components/ui/button";
import { DropdownMenuItem } from "~/components/ui/dropdown-menu";
import type { BulkAction } from "../data-table/bulk-actions.types";
import { type ActionVerbId, verbDef } from "./action-verbs";

/**
 * A row-menu entry for a registered verb.
 *
 * Two modes, matching the two things a row action does. Pass `render` a typed
 * `<Link>` to navigate, or `onSelect` to run a handler. Handing the element
 * over rather than accepting `to`/`search` props keeps TanStack's typed-route
 * checking intact — a helper that re-declared them would erase it.
 *
 * The label, icon and tone come from the registry, and no size is applied:
 * `DropdownMenuItem` already sizes its icon slot.
 *
 * ## Why `disabledReason` renders inline rather than in a tooltip
 *
 * A row menu whose items appear and disappear per row is unreadable — an action
 * missing because it does not apply looks identical to one that was never
 * built. So an inapplicable verb stays listed and explains itself.
 *
 * The explanation is text on the row, NOT a tooltip: `DropdownMenuItem` carries
 * `data-disabled:pointer-events-none`, so a disabled item never receives the
 * hover that would open one. Two "why is it disabled" tooltips in this codebase
 * are already dead for exactly that reason (`ai-suggest`,
 * `with-usda-food-search`). Inline text also survives the mobile card
 * projection, where there is no hover at all. This mirrors `disabledReason` on
 * picker rows (`combobox-types.ts`), down to folding the reason into
 * `aria-label` so it is not sighted-only.
 *
 * The stock `data-disabled:opacity-50` is overridden when a reason is present:
 * at 50% the explanation is too faint to read, which would defeat the point.
 * Muted foreground plus a not-allowed cursor carries "unavailable" instead.
 *
 * A disabled item also drops its `render`: the anchor would otherwise stay
 * focusable and followable by keyboard even though pointer events are
 * suppressed.
 */
export function VerbMenuItem({
  verb,
  render,
  onSelect,
  disabled,
  disabledReason,
}: {
  verb: ActionVerbId;
  /** A typed `<Link>`, for a verb that navigates. */
  render?: ReactElement;
  /** Handler, for a verb that acts on the current page. */
  onSelect?: (event: React.MouseEvent<HTMLDivElement>) => void;
  disabled?: boolean;
  /**
   * Why this verb does not apply to this row. Presence implies `disabled` —
   * there is no state where a reason shows on an actionable item.
   */
  disabledReason?: string;
}) {
  const { label, icon: Icon, tone } = verbDef(verb);
  const isDisabled = disabled === true || disabledReason != null;
  return (
    <DropdownMenuItem
      variant={tone === "destructive" ? "destructive" : "default"}
      disabled={isDisabled}
      {...(disabledReason != null
        ? {
            "aria-label": `${label}, ${disabledReason}`,
            className:
              "data-disabled:cursor-not-allowed data-disabled:text-foreground/70 data-disabled:opacity-100",
          }
        : {})}
      {...(render && !isDisabled ? { render } : {})}
      onClick={isDisabled ? undefined : onSelect}
    >
      <Icon />
      {disabledReason == null ? (
        label
      ) : (
        // Stacked, not pushed right: the menu popup is only as wide as its
        // widest label, so a reason on the same line gets clipped at the
        // viewport edge rather than read.
        <span className="flex flex-col items-start">
          <span>{label}</span>
          <span className="text-muted-foreground">{disabledReason}</span>
        </span>
      )}
    </DropdownMenuItem>
  );
}

/** Default bulk-action id for a verb: `moveToProject` → `move-to-project`. */
const verbActionId = (verb: ActionVerbId) =>
  verb.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

/**
 * A {@link BulkAction} for a registered verb, so the selection bar and the row
 * menu can't spell the same operation differently — which they did, in the
 * same file: `product-stocked-at` offered "Move to..." on a row and "Move" on
 * the bar for the one operation.
 */
export function verbBulkAction<TData extends RowData>(
  verb: ActionVerbId,
  options: Omit<BulkAction<TData>, "id" | "label" | "icon" | "tone"> & {
    /** Override only where an existing id is load-bearing. */
    id?: string;
  },
): BulkAction<TData> {
  const { label, icon: Icon, tone } = verbDef(verb);
  const { id, ...rest } = options;
  return {
    id: id ?? verbActionId(verb),
    label,
    icon: <Icon />,
    ...(tone ? { tone } : {}),
    ...rest,
  };
}

/**
 * A button for a registered verb — the toolbar and section-header counterpart
 * to {@link VerbMenuItem}.
 *
 * Navigation verbs were previously built three different ways across the app
 * (`DropdownMenuItem render={<Link/>}`, `Button render={<Link/>}
 * nativeButton={false}`, and a raw `<Link className={buttonVariants(...)}>`),
 * which is how the same destination ended up with three spellings and two icon
 * sizes. Pass `render` a typed `<Link>` and this handles the rest.
 */
export function VerbButton({
  verb,
  render,
  onClick,
  variant = "outline",
  size = "sm",
  disabled,
  className,
}: {
  verb: ActionVerbId;
  render?: ReactElement;
  onClick?: () => void;
  variant?: ComponentProps<typeof Button>["variant"];
  size?: ComponentProps<typeof Button>["size"];
  disabled?: boolean;
  className?: string;
}) {
  const { label, icon: Icon, tone } = verbDef(verb);
  return (
    <Button
      variant={tone === "destructive" ? "destructive" : variant}
      size={size}
      disabled={disabled}
      className={className}
      onClick={onClick}
      {...(render ? { render, nativeButton: false } : {})}
    >
      <Icon />
      {label}
    </Button>
  );
}
