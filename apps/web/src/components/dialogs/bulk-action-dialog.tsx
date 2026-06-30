import pluralize from "pluralize";
import type { ReactNode } from "react";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";

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
  onSubmit: () => Promise<void>;
  isPending: boolean;
  variant?: "default" | "destructive";
  children?: ReactNode;
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
  onSubmit,
  isPending,
  variant = "default",
  children,
}: BulkActionDialogProps<T>) {
  const count = items.length;
  const itemWord = pluralize(itemNoun, count);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {action} {count} {itemWord}?
          </DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <ul className="max-h-32 space-y-1 overflow-y-auto text-muted-foreground text-sm">
            {items.map((item) => (
              <li key={item.id}>{renderItem(item)}</li>
            ))}
          </ul>
        </div>

        {children}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant={variant} onClick={onSubmit} disabled={isPending}>
            {isPending
              ? (pendingLabel ?? `${action}ing...`)
              : (actionLabel ?? action)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
