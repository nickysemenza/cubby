import type { Database } from "~/server/db";
/** Tag propagation was retired in ADR 0025; retained until the Sweep roster cutover. */
export async function prepareTagSuggestions(_db: Database, _sourceId: string) {
  return [];
}
