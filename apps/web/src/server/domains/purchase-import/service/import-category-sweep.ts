import { entityRefKey } from "@cubby/schemas/entity";
import { parseEntityRef, type ProductId } from "@cubby/schemas/identifiers";

import { readAiRefreshActivation } from "~/server/ai/repo/ai-refresh";
import { startSweep } from "~/server/domains/run/service/sweep";
import type { EntityKernelContext } from "~/server/entity-kernel/adapter";
import { lookupShortcodes } from "~/server/generic/shortcode/repo/shortcode-resolver";

/**
 * Suggest categories for the Products an import commit just created, as a
 * `scheduled` field Sweep Run of its own nested under the import Run: import
 * Runs grant no entity writes, and nobody started this sweep. Additions at the auto-apply
 * threshold apply; an applied category settles the Purchase's arrival prompt
 * (`suggestion-sweep.ts`). Off unless AI refresh is activated.
 */
export async function sweepImportedProductCategories(
  context: EntityKernelContext,
  productIds: readonly ProductId[],
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
  await startSweep(
    context.db,
    { ...context.actorContext, runId: null },
    {
      trigger: "scheduled",
      cause: "import_completed",
      ...(context.actorContext.runId
        ? { parentRunId: context.actorContext.runId }
        : {}),
      families: [
        {
          family: "field",
          scope: {
            targets: [
              { entity: "product", fields: ["categoryId"], filters: { ids } },
            ],
          },
        },
      ],
    },
  );
}
