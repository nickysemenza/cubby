import type { JobBackoff } from "@cubby/schemas/job";
import type { SQL } from "drizzle-orm";

import type { Database } from "~/server/db/database";

import type { WorkItem } from "./repo/work-items";

/** The identity a page reads: a drain Job's claim, or a domain row drain's page. */
export type DrainClaim = {
  key: string;
  kind?: string;
  generation: number;
  leaseToken: string;
};

/**
 * Where a drain's owed items live. `WorkItem` by default; a domain whose own rows
 * are the debt supplies its own (`generic/background/drains.ts`). `lock` returns
 * the same item objects it was given, narrowed to those still current.
 */
export type DrainStore = {
  claim(
    db: Database,
    limit: number,
    eligible?: (target: SQL) => SQL,
  ): Promise<WorkItem[]>;
  lock(
    tx: Database,
    items: readonly WorkItem[],
    options?: { drain?: string },
  ): Promise<WorkItem[]>;
  clear(tx: Database, items: readonly WorkItem[]): Promise<void>;
  defer(
    tx: Database,
    items: readonly WorkItem[],
    error: string,
    backoff: JobBackoff,
  ): Promise<void>;
  nextReadyAt(db: Database): Promise<Date | null>;
};
