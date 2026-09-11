import type { RowData } from "@tanstack/react-table";
import type { ComponentProps, ReactElement } from "react";

import { Button } from "~/components/ui/button";
import { DropdownMenuItem } from "~/components/ui/dropdown-menu";
import { Spinner } from "~/components/ui/spinner";

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
 * Shelf Ink (`text-muted-foreground`) plus a not-allowed cursor carries
 * "unavailable" instead — a whole disabled item drops one tier from the Ink
 * that enabled items sit at. Not an opacity-derived tone: DESIGN.md allows
 * exactly three prose tiers and rules out inventing a fourth with opacity.
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
  const menuItemProps: ComponentProps<typeof DropdownMenuItem> = {};
  if (disabledReason != null) {
    menuItemProps["aria-label"] = `${label}, ${disabledReason}`;
    menuItemProps.className =
      "data-disabled:cursor-not-allowed data-disabled:text-muted-foreground data-disabled:opacity-100";
  }
  if (render && !isDisabled) menuItemProps.render = render;
  return (
    <DropdownMenuItem
      variant={tone === "destructive" ? "destructive" : "default"}
      disabled={isDisabled}
      {...menuItemProps}
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
          <span>{disabledReason}</span>
        </span>
      )}
    </DropdownMenuItem>
  );
}

/** Default bulk-action id for a verb: `moveToProject` → `move-to-project`. */
export const verbActionId = (verb: ActionVerbId) =>
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
  const action: BulkAction<TData> = {
    id: id ?? verbActionId(verb),
    label,
    icon: <Icon />,
    ...rest,
  };
  if (tone) action.tone = tone;
  return action;
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
 *
 * ## `object`, `phoneIconOnly` and `pending`
 *
 * The AI verbs added three shapes that every AI surface had been hand-rolling,
 * each slightly differently: an object noun for the one multi-object verb
 * (`suggest`), an icon-only phone rendering, and a spinner swapped in for the
 * icon while the request is in flight. Collapsing them here is what makes the
 * treatment uniform — six surfaces previously disagreed on whether the label
 * survived below `sm`, and two kept the icon while the request ran.
 *
 * The accessible name always carries the full "verb object" text, so hiding
 * the label below `sm` never costs a screen-reader user the object.
 *
 * `disabledReason` reaches the accessible name and the native `title`. Native
 * titles do open on a disabled button (unlike the JS `Tooltip` this replaced,
 * which never received the hover at all) — but only on a pointer device. A
 * surface whose primary device is a phone must ALSO render the reason as
 * visible text; every AI trigger in this codebase does.
 */
export function VerbButton({
  verb,
  object,
  render,
  onClick,
  variant = "outline",
  size = "sm",
  disabled,
  disabledReason,
  pending,
  phoneIconOnly,
  className,
}: {
  verb: ActionVerbId;
  /**
   * Names what this invocation acts on, for a verb whose registry label is the
   * bare verb: `suggest` + "category" reads "Suggest category".
   */
  object?: string;
  render?: ReactElement;
  onClick?: () => void;
  variant?: ComponentProps<typeof Button>["variant"];
  size?: ComponentProps<typeof Button>["size"];
  disabled?: boolean;
  disabledReason?: string;
  /** In flight: a spinner replaces the icon and the button stops accepting clicks. */
  pending?: boolean;
  /** Below `sm`, render the icon alone — the label stays in the accessible name. */
  phoneIconOnly?: boolean;
  className?: string;
}) {
  const { label, icon: Icon, tone } = verbDef(verb);
  const text = object ? `${label} ${object}` : label;
  const isDisabled =
    disabled === true || pending === true || disabledReason != null;
  const accessibleName = disabledReason
    ? `${text}, ${disabledReason}`
    : phoneIconOnly
      ? text
      : undefined;
  return (
    <Button
      variant={tone === "destructive" ? "destructive" : variant}
      size={size}
      disabled={isDisabled}
      title={disabledReason}
      aria-label={accessibleName}
      aria-busy={pending ? true : undefined}
      className={className}
      onClick={onClick}
      render={render && !isDisabled ? render : undefined}
      nativeButton={render && !isDisabled ? false : undefined}
    >
      {pending ? <Spinner /> : <Icon />}
      <span className={phoneIconOnly ? "hidden sm:inline" : undefined}>
        {text}
      </span>
    </Button>
  );
}
