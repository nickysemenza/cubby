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
    for (const id of batch) {
      const row = byId.get(id);
      if (!row) throw new Error(`Selected record ${id} was not returned`);
      records.push(row);
    }
  }
  signal.throwIfAborted();
  return records;
}
