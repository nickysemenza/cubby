import type {
  InventoryShortcode,
  ProductShortcode,
} from "@cubby/schemas/identifiers";
import { useQuery } from "@tanstack/react-query";
import { type FC, useEffect } from "react";
import { toast } from "sonner";
import { ProductDiscardDialog } from "~/app/_components/products/product-discard-dialog";
import { SimpleLoading } from "~/components/feedback/loading-skeletons";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { entityDetailFor } from "~/entities/entity-detail.functions";

interface InventoryDiscardDialogProps {
  onOpenChange: (open: boolean) => void;
  /** The row being discarded from — its product and the shelf to decrement. */
  target: { productId: ProductShortcode; entryId: InventoryShortcode };
}

/**
 * `ProductDiscardDialog` for a surface that lists inventory rather than
 * products — a location's shelf, say.
 *
 * The product is fetched rather than assembled from the row on purpose. The
 * discard dialog branches on how many shelves the product sits on, and a row
 * from one location only knows about its own: handing it a single-entry
 * product would quietly tell the operator this is the whole stock.
 *
 * That fetch is usually cold here (a location lists many products, so this
 * one need not be cached), which is why both pending and failed states are
 * rendered rather than falling through to `null` — otherwise the menu click
 * is a silent no-op while it loads, and permanently if it errors.
 *
 * Takes no `open` prop — mount it only while a row is targeted, so the fetch
 * never runs at rest, and unmounting is what closes it.
 */
export const InventoryDiscardDialog: FC<InventoryDiscardDialogProps> = ({
  onOpenChange,
  target,
}) => {
  const query = useQuery(
    entityDetailFor("product").queryOptions(target.productId),
  );

  const failed = query.isError;
  useEffect(() => {
    if (!failed) return;
    toast.error("Could not load this product's shelves. Try again.");
    onOpenChange(false);
  }, [failed, onOpenChange]);

  if (failed) return null;

  if (!query.data) {
    return (
      <Dialog open onOpenChange={onOpenChange}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Discard</DialogTitle>
            <DialogDescription>
              Loading every shelf this product sits on, so the count comes off
              the right one.
            </DialogDescription>
          </DialogHeader>
          <SimpleLoading />
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <ProductDiscardDialog
      key={target.entryId}
      open
      onOpenChange={onOpenChange}
      product={query.data}
      defaultInventoryEntryId={target.entryId}
    />
  );
};
