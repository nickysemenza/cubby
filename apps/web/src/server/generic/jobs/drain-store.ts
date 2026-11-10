import type { JobBackoff } from "@cubby/schemas/job";
import { sql, type AnyColumn } from "drizzle-orm";

import type { Database } from "~/server/db/database";

/** One owed record a drain page works on; its ticket says which intent a page may settle. */
export type DrainItem = {
  target: string;
  ref: string;
  ticket: number;
  priority: number;
  attempts: number;
  /** First failure of the item's current streak, if it is failing. */
  failingSince?: Date | null;
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
  /**
   * Back off failed items and start their failure streak if none is running.
   * A `transient` failure (capacity, dropped connection) spends no attempt;
   * its delay grows with the streak's age instead.
   */
  defer(
    tx: Database,
    items: readonly DrainItem[],
    error: string,
    backoff: JobBackoff,
    transient: boolean,
  ): Promise<void>;
  /**
   * Hold items for an external wait (funding or provider capacity) until
   * `until`: no attempt is spent and no failure streak starts. Without it, a
   * wait stops the page and the items stay owed as they were.
   */
  wait?(
    tx: Database,
    items: readonly DrainItem[],
    error: string,
    until: Date,
  ): Promise<void>;
};

/** A transient failure's retry time: it grows with the streak's age, within the backoff bounds. */
export const transientRetryAt = (
  failingSince: AnyColumn,
  backoff: JobBackoff,
) =>
  sql`now() + least(${backoff.maxMs}::bigint, greatest(${backoff.baseMs}::bigint,
    (extract(epoch FROM now() - coalesce(${failingSince}, now())) * 1000)::bigint))
    * interval '1 millisecond'`;
