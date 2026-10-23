import { readListEnrichmentGroup } from "~/ui/hooks/list-enrichment";
import type { ListQueryOptionsFn } from "~/ui/hooks/use-paginated-table-core";

/** Resolve action data only on demand, after lightweight identity selection. */
export async function loadSelectionRecords<
  TFilters extends object,
  TRow extends { id: string },
>({
  ids,
  filters,
  queryOptions,
  signal,
}: {
  ids: string[];
  filters: TFilters;
  queryOptions: ListQueryOptionsFn<TFilters, TRow>;
  signal: AbortSignal;
}): Promise<TRow[]> {
  const records: TRow[] = [];
  for (let offset = 0; offset < ids.length; offset += 100) {
    signal.throwIfAborted();
    const batch = ids.slice(offset, offset + 100);
    const plan = queryOptions({
      filters: { ...filters, ids: batch },
      pagination: { pageIndex: 0, pageSize: 100 },
    });
    const page = await plan.execute(signal);
    const byId = new Map(page.items.map((row) => [row.id, row]));
    if (byId.size !== batch.length || batch.some((id) => !byId.has(id))) {
      throw new Error(
        "The selected records no longer match the list. Select them again before running this action.",
      );
    }
    const patches = new Map<string, object>();
    const deferred = page.deferredGroups ?? [];
    if (deferred.length) {
      if (!plan.progressive)
        throw new Error(
          "Selected records require enrichment, but the list has no enrichment reader.",
        );
      const enrichment = await plan.progressive.enrich(
        batch,
        deferred.flatMap((group) => group.fields),
        signal,
      );
      if (enrichment.missingIds.length)
        throw new Error(
          "Selected records disappeared while checking the action. Select them again.",
        );
      for (const requested of deferred) {
        const group = enrichment.groups.find(
          (entry) => entry.id === requested.id,
        );
        if (!group) throw new Error(`No ${requested.id} enrichment returned`);
        if (group.state === "error")
          throw new Error(JSON.stringify(group.error));
        for (const patch of readListEnrichmentGroup({
          ids: batch,
          requested,
          result: group,
          missingIds: [],
        }).values())
          patches.set(patch.id, { ...patches.get(patch.id), ...patch });
      }
    }
    for (const id of batch) {
      const row = byId.get(id);
      if (!row) throw new Error(`Selected record ${id} was not returned`);
      records.push(Object.assign({}, row, patches.get(id)));
    }
  }
  signal.throwIfAborted();
  return records;
}
