import {
  inventoryShortcode,
  locationShortcode,
  productShortcode,
} from "@cubby/schemas/identifiers";
import { z } from "zod";

/**
 * The shape `MoveInventoryDialog` and `DeleteInventoryDialog` actually read.
 *
 * Structural on purpose, the same way `ProductDiscardDialog` is: the dialogs
 * are the shared removal/relocation UI for every surface that lists inventory,
 * and those surfaces don't all fetch the same row. `inventory.list` rows carry
 * a full product summary; the product detail page's rows already know their
 * product from the page, so requiring `inventoryListItemOut` there would mean
 * refetching (or casting) a row it has in hand. Deliberately NOT the canonical
 * `amount` codec from `packages/schemas/src/codec.ts` — that type carries
 * extra fields/refinements this shape has no use for.
 */
export const inventoryDialogItemSchema = z.object({
  id: inventoryShortcode,
  amount: z.object({ value: z.number(), unit: z.string() }),
  /** `name` renders the `current → target` projection, not just the row. */
  location: z.object({ id: locationShortcode, name: z.string() }),
  /** Names the row in the delete confirmation; `id` (bulk discard only) picks
   * the trade-suggestion basis when a staged selection shares one product. */
  product: z.object({ id: productShortcode, name: z.string() }),
});
export type InventoryDialogItem = z.infer<typeof inventoryDialogItemSchema>;
