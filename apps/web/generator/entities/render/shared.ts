import { servesKernelGet } from "../list-capabilities.ts";
import type { CompiledEntity } from "../declarations.ts";

/**
 * Entities the kernel can execute directly: a bound repository port, plus
 * `image` (which the kernel always handles even without one). Shared by
 * every kernel-facing artifact — the roster, capability/action metadata, and
 * the runtime binding module — so they stay correlated on one filter instead
 * of each recomputing (and risking drift on) their own entity subset.
 */
export const kernelEntitiesFor = (
  entities: readonly CompiledEntity[],
): readonly CompiledEntity[] => entities.filter(servesKernelGet);

/**
 * The list search an entity's browser surfaces use: the declared
 * `list.primarySearch`, else `searchQuery` for a searchable entity with a
 * contract. One derivation for the summary, the inspector, and the search-param
 * codecs, so the fallback cannot drift between them.
 */
export const resolvedPrimarySearch = ({
  contract,
  descriptor,
  inspector,
}: CompiledEntity): { key: string; placeholder: string } | null =>
  inspector.list.primarySearch ??
  (contract !== null && descriptor.searchable === true
    ? {
        key: "searchQuery",
        placeholder: `Search ${(inspector.plural ?? inspector.singular).toLowerCase()} or shortcode`,
      }
    : null);

/**
 * The fields one bulk edit may set, or null without a `bulkUpdate` capability.
 * Not `entityFieldModels.bulk`: a bulk update can name fields (Expense `date`)
 * that the field model does not mark bulk-editable.
 */
export const bulkUpdateFor = ({
  bulkUpdateFields,
}: CompiledEntity): { fields: readonly string[] } | null =>
  bulkUpdateFields === null ? null : { fields: bulkUpdateFields };
