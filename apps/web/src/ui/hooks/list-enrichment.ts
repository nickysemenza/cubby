import type {
  DeferredListGroup,
  ListEnrichmentResponse,
} from "~/entity/hooks/progressive-list";
import type { ListReadRow } from "~/entity/model/list-read-fields";

/** Complete-page consumers require every requested field and every surviving row. */
export function readListEnrichmentGroup({
  ids,
  requested,
  result,
  missingIds,
}: {
  ids: readonly string[];
  requested: DeferredListGroup;
  result: Extract<ListEnrichmentResponse["groups"][number], { state: "ready" }>;
  missingIds: readonly string[];
}): Map<string, ListReadRow> {
  const fields = new Set(requested.fields);
  if (
    result.id !== requested.id ||
    result.fields.length !== fields.size ||
    new Set(result.fields).size !== fields.size ||
    result.fields.some((field) => !fields.has(field))
  )
    throw new Error(`Unexpected ${requested.id} enrichment acknowledgement`);
  const allowed = new Set(ids);
  const missing = new Set(missingIds);
  if (missingIds.some((id) => !allowed.has(id)))
    throw new Error("Unexpected missing enrichment row");
  const patches = new Map<string, ListReadRow>();
  for (const row of result.data) {
    if (!allowed.has(row.id) || missing.has(row.id) || patches.has(row.id))
      throw new Error(`Unexpected ${requested.id} enrichment row`);
    const patch: ListReadRow = { id: row.id };
    for (const [field, value] of Object.entries(row))
      if (fields.has(field)) patch[field] = value;
    patches.set(row.id, patch);
  }
  if (ids.some((id) => !missing.has(id) && !patches.has(id)))
    throw new Error(`Missing ${requested.id} enrichment row`);
  return patches;
}
