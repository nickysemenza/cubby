import type { Amount } from "@cubby/schemas/codec";
import type {
  InventoryShortcode,
  LocationShortcode,
} from "@cubby/schemas/identifiers";

/**
 * The shape `MoveInventoryDialog` and `DeleteInventoryDialog` actually read.
 *
 * Structural on purpose, the same way `ProductDiscardDialog` is: the dialogs
 * are the shared removal/relocation UI for every surface that lists inventory,
 * and those surfaces don't all fetch the same row. `inventory.list` rows carry
 * a full product summary; the product detail page's rows already know their
 * product from the page, so requiring `inventoryListItemOut` there would mean
 * refetching (or casting) a row it has in hand.
 */
export interface InventoryDialogItem {
  id: InventoryShortcode;
  amount: Amount;
  /** `name` renders the `current → target` projection, not just the row. */
  location: { id: LocationShortcode; name: string };
  /** Names the row in the delete confirmation. */
  product: { name: string };
}
