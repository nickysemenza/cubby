import { uniq } from "es-toolkit";
import pluralize from "pluralize";
import type { ReactNode } from "react";
import { z } from "zod";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { cn } from "~/lib/utils";

/**
 * What the pending write would do to one row, as opposed to which row it is.
 *
 * A list of names answers "what did I pick"; it never answers "what is about to
 * happen" — so a bulk field set would happily report five rows without
 * mentioning that three already carry the value being written.
 */
interface BulkActionEffect {
  /** The value the row carries now. Omit where there is nothing to replace. */
  from?: ReactNode;
  /** The value it would carry afterwards. */
  to: ReactNode;
  /** Already in the target state, so the write is a no-op for this row. */
  unchanged?: boolean;
  /**
   * Why this row cannot proceed at all. Any blocked row disables confirmation:
   * this is the "positively identified blocker" case — the mutation would be
   * refused anyway, so the explanation belongs up front rather than in an error
   * toast afterwards. NOT for "unchanged", which is a legal no-op.
   */
  blocked?: string;
}

interface BulkActionDialogProps<T extends { id: string }> {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: T[];
  action: string;
  actionLabel?: string;
  pendingLabel?: string;
  description: string;
  /** Noun for the title count, e.g. "Product" → "Delete 3 Products?". Defaults to "Item". */
  itemNoun?: string;
  renderItem: (item: T) => ReactNode;
  /**
   * Per-row projection of the pending write, rendered as `current → next` beside
   * the row's name. Return `undefined` for a row with nothing to project yet —
   * typically before the dialog's own picker holds a value.
   */
  effect?: (item: T) => BulkActionEffect | undefined;
  /** Tail of the footer's "2 of 5 …" no-op count. */
  unchangedLabel?: string;
  onSubmit: () => Promise<void>;
  isPending: boolean;
  /** Caller-owned submission gate for incomplete but otherwise valid forms. */
  submissionDisabled?: boolean;
  variant?: "default" | "destructive";
  children?: ReactNode;
  /**
   * Why the last attempt was refused. Rendered above the footer and left to the
   * caller to clear, so a server refusal keeps the dialog open with its reasons
   * on screen instead of closing over an error the user never saw.
   */
  error?: ReactNode;
}

export function BulkActionDialog<T extends { id: string }>({
  open,
  onOpenChange,
  items,
  action,
  actionLabel,
  pendingLabel,
  description,
  itemNoun = "Item",
  renderItem,
  effect,
  unchangedLabel = "already set",
  onSubmit,
  isPending,
  submissionDisabled = false,
  variant = "default",
  children,
  error,
}: BulkActionDialogProps<T>) {
  const count = items.length;
  const itemWord = pluralize(itemNoun, count);

  const rows = items.map((item) => ({
    item,
    rendered: renderItem(item),
    effect: effect?.(item),
  }));
  const unchangedCount = rows.filter((row) => row.effect?.unchanged).length;
  const blockedReasons = uniq(
    rows.flatMap((row) => (row.effect?.blocked ? [row.effect.blocked] : [])),
  );
  const blockedCount = rows.filter((row) => row.effect?.blocked).length;
  const footerNote =
    unchangedCount > 0
      ? `${unchangedCount} of ${count} ${unchangedLabel}`
      : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* `md` only where a projection is shown: a `current → next` line beside a
          long product name does not fit the 384px confirmation width. */}
      <DialogContent size={effect ? "md" : "sm"}>
        <DialogHeader>
          <DialogTitle>
            {action} {count} {itemWord}?
          </DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        {/* `min-w-0` here and on every wrapper below is load-bearing, not
            tidying. DialogContent is a `grid` whose items default to
            `min-width: auto`, so one long name sets a min-content width that
            spills past the dialog's `max-w` — and the popup only scrolls on Y,
            so the overflow is simply unreachable. Break the chain anywhere and
            `truncate` stops working. */}
        <div className="min-w-0 space-y-2">
          <ul
            className={cn(
              "min-w-0 space-y-1 overflow-y-auto text-sm text-muted-foreground",
              effect ? "max-h-48" : "max-h-32",
            )}
          >
            {rows.map(({ item, rendered, effect: itemEffect }) => (
              <li
                key={item.id}
                className={cn("min-w-0", itemEffect?.unchanged && "opacity-60")}
              >
                {itemEffect ? (
                  <div className="flex min-w-0 flex-col gap-x-3 sm:flex-row sm:items-baseline sm:justify-between">
                    {/* The full name stays reachable on hover — a truncated
                        name is often not enough to tell two rows apart. */}
                    <span
                      className="min-w-0 flex-1 truncate"
                      title={
                        z.string().safeParse(rendered).success
                          ? z.string().parse(rendered)
                          : undefined
                      }
                    >
                      {rendered}
                    </span>
                    {itemEffect.blocked ? (
                      <span
                        className="min-w-0 truncate text-destructive sm:max-w-[55%]"
                        title={itemEffect.blocked}
                      >
                        {itemEffect.blocked}
                      </span>
                    ) : (
                      <span className="flex min-w-0 items-baseline gap-1 sm:max-w-[55%]">
                        {itemEffect.from !== undefined && (
                          <>
                            <span className="min-w-0 truncate">
                              {itemEffect.from}
                            </span>
                            <span aria-hidden="true" className="shrink-0">
                              →
                            </span>
                            <span className="sr-only">changes to</span>
                          </>
                        )}
                        <span className="min-w-0 truncate font-medium text-foreground">
                          {itemEffect.to}
                        </span>
                      </span>
                    )}
                  </div>
                ) : (
                  rendered
                )}
              </li>
            ))}
          </ul>
        </div>

        {children}

        {blockedReasons.length > 0 ? (
          <div
            role="alert"
            className="border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive"
          >
            {blockedCount} of {count}{" "}
            {pluralize(itemNoun.toLowerCase(), blockedCount)} cannot proceed:{" "}
            {blockedReasons.join("; ")}
          </div>
        ) : null}

        {error ? (
          <div
            role="alert"
            className="border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive"
          >
            {error}
          </div>
        ) : null}

        <DialogFooter
          className={cn(footerNote && "sm:items-center sm:justify-between")}
        >
          {footerNote ? (
            <p className="text-xs text-muted-foreground">{footerNote}</p>
          ) : null}
          <div className="flex flex-col-reverse gap-2 sm:flex-row">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              variant={variant}
              onClick={onSubmit}
              disabled={isPending || submissionDisabled || blockedCount > 0}
            >
              {isPending
                ? (pendingLabel ?? `${action}ing...`)
                : (actionLabel ?? action)}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
