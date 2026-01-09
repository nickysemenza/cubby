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

interface DeleteEntityDialogProps<T extends { id: string; name: string }> {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: T[];
  entityType: string;
  onDelete: () => Promise<void>;
  isPending: boolean;
  /** Optional render function for additional item details */
  renderItem?: (item: T) => ReactNode;
}

const pluralize = (count: number, singular: string) =>
  count === 1 ? singular : `${singular}s`;

export function DeleteEntityDialog<T extends { id: string; name: string }>({
  open,
  onOpenChange,
  items,
  entityType,
  onDelete,
  isPending,
  renderItem,
}: DeleteEntityDialogProps<T>) {
  const count = items.length;
  const entityWord = pluralize(count, entityType);

  const handleDelete = async () => {
    await onDelete();
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            Delete {count} {entityWord}?
          </DialogTitle>
          <DialogDescription>
            The {entityWord.toLowerCase()} will be marked as deleted. This is a
            soft delete - the data is retained in the database but hidden from
            normal views.
          </DialogDescription>
        </DialogHeader>

        {count > 0 && (
          <div className="space-y-2">
            <ul className="max-h-32 space-y-1 overflow-y-auto text-muted-foreground text-sm">
              {items.map((item) => (
                <li key={item.id}>
                  {renderItem ? renderItem(item) : item.name}
                </li>
              ))}
            </ul>
          </div>
        )}

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isPending}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={handleDelete}
            disabled={isPending}
          >
            {isPending ? "Deleting..." : "Delete"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
