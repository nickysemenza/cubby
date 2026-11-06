import type { JobBackoff } from "@cubby/schemas/job";
import type { SQL } from "drizzle-orm";

import type { Database } from "~/server/db/database";

/** One owed record a drain page works on; its ticket says which intent a page may settle. */
export type DrainItem = {
  target: string;
  ref: string;
  ticket: number;
  priority: number;
  attempts: number;
};

/** The identity a page reads: a drain Job's claim, or a domain row drain's page. */
export type DrainClaim = {
  key: string;
  kind?: string;
  generation: number;
  leaseToken: string;
};

/**
 * Where a drain's owed items live: the domain's own rows are the debt
 * (`generic/background/drains.ts`). `lock` returns the same item objects it was given,
 * narrowed to those still current.
 */
export type DrainStore = {
  claim(
    db: Database,
    limit: number,
    eligible?: (target: SQL) => SQL,
  ): Promise<DrainItem[]>;
  lock(
    tx: Database,
    items: readonly DrainItem[],
    options?: { drain?: string },
  ): Promise<DrainItem[]>;
  clear(tx: Database, items: readonly DrainItem[]): Promise<void>;
  defer(
    tx: Database,
    items: readonly DrainItem[],
    error: string,
    backoff: JobBackoff,
  ): Promise<void>;
  nextReadyAt(db: Database): Promise<Date | null>;
};
