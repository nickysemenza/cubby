import type { PurchaseId } from "@cubby/schemas/identifiers";
import { eq } from "drizzle-orm";

import type { DrizzleTransaction } from "~/server/db";
import { requested } from "~/server/db/helpers/requested";
import { importSourceOrder, importSourceProduct } from "~/server/db/schema";

export async function loadOriginalLineBindings(
  tx: DrizzleTransaction,
  purchaseId: PurchaseId,
) {
  const sources = await tx
    .select()
    .from(importSourceOrder)
    .where(eq(importSourceOrder.purchaseId, purchaseId));
  const ids = requested(
    sources.map((row) => ({ entity: "importSourceOrder", id: row.id })),
  );
  const bindings = ids.size
    ? await tx
        .select()
        .from(importSourceProduct)
        .where(
          ids.match({
            entity: "importSourceOrder",
            id: importSourceProduct.sourceOrderId,
          }),
        )
    : [];
  return { sources, bindings };
}
