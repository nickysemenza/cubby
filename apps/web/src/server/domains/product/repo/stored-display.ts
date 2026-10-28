import type { ProductId } from "@cubby/schemas/identifiers";
import { productReadFacts } from "@cubby/schemas/product-read-fields";
import type { z } from "zod";

import type { Database } from "~/server/db/database";
import { loadStoredDerived } from "~/server/generic/derived/repo/read";

/** Compact reads share the same publication as full Product pages. Missing
 * facts stay unavailable; neither pickers nor kit previews repair them. */
export async function loadStoredProductDisplay(
  db: Database,
  ids: readonly ProductId[],
): Promise<{
  stored: Awaited<ReturnType<typeof loadStoredDerived>>;
  facts: Map<
    ProductId,
    {
      readonly value: z.infer<typeof productReadFacts> | null;
      readonly stale: boolean;
    }
  >;
}> {
  const stored = await loadStoredDerived(
    db,
    "product",
    [...ids],
    ["price", "readFacts"],
  );
  const facts = new Map(
    ids.map((id) => {
      const read = stored.get(id)?.get("readFacts");
      return [
        id,
        {
          value: read?.resultExists ? productReadFacts.parse(read.value) : null,
          stale: read?.stale ?? false,
        },
      ] as const;
    }),
  );
  return { stored, facts };
}
