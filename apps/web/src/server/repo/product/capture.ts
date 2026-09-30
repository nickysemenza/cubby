import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { mutationSideEffectsWithWarnings } from "@cubby/schemas/mutation-side-effects";
import {
  type ProductCreateWithInventoryInput,
  type ProductCreateWithInventoryOut,
  productCreateWithInventoryOut,
} from "@cubby/schemas/product-capture";

import { executeEntity } from "~/server/entity-kernel";
import type { EntityKernelContext } from "~/server/entity-kernel/adapter";
import { withTransactionDatabase } from "~/server/repo/database-helpers";

/** A failed placement preserves staging; normal kernel effects wait for the outer commit. */
export const createProductWithInventory = async (
  context: EntityKernelContext,
  input: ProductCreateWithInventoryInput,
): Promise<ProductCreateWithInventoryOut> =>
  withTransactionDatabase(context.db, async (transactionDb) => {
    const transactionContext = { ...context, db: transactionDb };
    const product = await executeEntity(transactionContext, {
      action: "create",
      entity: "product",
      data: input.product,
    });
    if (product.action !== "create") throw new Error("Expected Product create");
    const productId = parseShortcodeFor("product", product.item.id);
    const inventory = await executeEntity(transactionContext, {
      action: "create",
      entity: "inventory",
      data: { ...input.inventory, productId },
    });
    if (inventory.action !== "create")
      throw new Error("Expected Inventory create");
    const inventoryId = parseShortcodeFor("inventory", inventory.item.id);
    // Read after both writes so returned relations include the committed stock.
    const [productDetail, inventoryDetail] = await Promise.all([
      executeEntity(transactionContext, {
        action: "get",
        entity: "product",
        id: productId,
        missing: "error",
      }),
      executeEntity(transactionContext, {
        action: "get",
        entity: "inventory",
        id: inventoryId,
        missing: "error",
      }),
    ]);
    if (productDetail.action !== "get" || inventoryDetail.action !== "get")
      throw new Error("Expected capture detail reads");
    return productCreateWithInventoryOut.parse({
      product: productDetail.item,
      inventory: inventoryDetail.item,
      sideEffects: mutationSideEffectsWithWarnings([
        ...(product.sideEffects.warnings ?? []),
        ...(inventory.sideEffects.warnings ?? []),
      ]),
    });
  });
