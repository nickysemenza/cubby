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
 */
export function VerbMenuItem({
  verb,
  render,
  onSelect,
  disabled,
}: {
  verb: ActionVerbId;
  /** A typed `<Link>`, for a verb that navigates. */
  render?: ReactElement;
  /** Handler, for a verb that acts on the current page. */
  onSelect?: (event: React.MouseEvent<HTMLDivElement>) => void;
  disabled?: boolean;
}) {
  const { label, icon: Icon, tone } = verbDef(verb);
  return (
    <DropdownMenuItem
      variant={tone === "destructive" ? "destructive" : "default"}
      disabled={disabled}
      {...(render ? { render } : {})}
      onClick={onSelect}
    >
      <Icon />
      {label}
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
export function verbBulkAction<TData>(
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
