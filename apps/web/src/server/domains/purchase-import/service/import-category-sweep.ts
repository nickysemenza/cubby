import { entityRefKey } from "@cubby/schemas/entity";
import { parseEntityRef, type ProductId } from "@cubby/schemas/identifiers";

import { readAiRefreshActivation } from "~/server/ai/repo/ai-refresh";
import {
  startSuggestionSweep,
  type SuggestionSweepPorts,
} from "~/server/domains/run/service/suggestion-sweep";
import type { EntityKernelContext } from "~/server/entity-kernel/adapter";
import { lookupShortcodes } from "~/server/generic/shortcode/repo/shortcode-resolver";

/**
 * Suggest categories for the Products an import commit just created, as a
 * `scheduled` suggestion sweep Run of its own: import Runs grant no entity
 * writes, and nobody started this sweep. Additions at the auto-apply
 * threshold apply; an applied category settles the Purchase's arrival prompt
 * (`suggestion-sweep.ts`). Off unless AI refresh is activated.
 */
export async function sweepImportedProductCategories(
  context: EntityKernelContext,
  productIds: readonly ProductId[],
  ports: Omit<SuggestionSweepPorts, "context"> = {},
): Promise<void> {
  if (productIds.length === 0) return;
  if (!(await readAiRefreshActivation(context.db))?.enabled) return;
  const codes = await lookupShortcodes(
    context.db,
    productIds.map((id) => parseEntityRef("product", id)),
  );
  const ids = productIds.flatMap((id) => {
    const code = codes.get(entityRefKey("product", id));
    return code ? [code] : [];
  });
  if (ids.length === 0) return;
  await startSuggestionSweep(
    context.db,
    {
      entity: "product",
      fields: ["categoryId"],
      filters: { ids },
      trigger: "scheduled",
    },
    { ...ports, context },
  );
}
