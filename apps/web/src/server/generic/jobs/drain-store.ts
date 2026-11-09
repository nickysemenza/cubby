import type { JobBackoff } from "@cubby/schemas/job";

import type { Database } from "~/server/db/database";

/** One owed record a drain page works on; its ticket says which intent a page may settle. */
export type DrainItem = {
  target: string;
  ref: string;
  ticket: number;
  priority: number;
  attempts: number;
};

/**
 * Where a drain's owed items live: the domain's own rows are the debt
 * (`generic/background/drains.ts`). `lock` returns the same item objects it was given,
 * narrowed to those still current.
 */
export type DrainStore = {
  claim(db: Database, limit: number): Promise<DrainItem[]>;
  lock(tx: Database, items: readonly DrainItem[]): Promise<DrainItem[]>;
  clear(tx: Database, items: readonly DrainItem[]): Promise<void>;
  defer(
    tx: Database,
    items: readonly DrainItem[],
    error: string,
    backoff: JobBackoff,
  ): Promise<void>;
};
