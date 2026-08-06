import type {
  InventoryShortcode,
  ProductShortcode,
} from "@cubby/schemas/identifiers";
import { useQuery } from "@tanstack/react-query";
import type { FC } from "react";
import { ProductDiscardDialog } from "~/app/_components/products/product-discard-dialog";
import { useTRPC } from "~/integrations/trpc/react";

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
 * Takes no `open` prop — mount it only while a row is targeted, so the fetch
 * never runs at rest, and unmounting is what closes it.
 */
export const InventoryDiscardDialog: FC<InventoryDiscardDialogProps> = ({
  onOpenChange,
  target,
}) => {
  const api = useTRPC();
  const query = useQuery(
    api.product.getByID.queryOptions({ id: target.productId }),
  );

  if (!query.data) return null;

  return (
    <ProductDiscardDialog
      open
      onOpenChange={onOpenChange}
      product={query.data}
      defaultInventoryEntryId={target.entryId}
    />
  );
};
