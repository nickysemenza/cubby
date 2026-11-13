import type { SQL } from "drizzle-orm";

import type { Database } from "~/server/db/database";

export type DrainPage = {
  /** Owed items this page claimed; zero means a sibling or nobody holds the work. */
  claimed: number;
  /** The page's own outcome when it is not plain success (a funding or provider wait). */
  outcome?: "succeeded" | "skipped" | "deferred" | "superseded";
};

/**
 * Arm a delayed recovery for one claim this page holds under a lease nothing
 * renews, due when that lease expires; it reclaims exactly that attempt.
 */
export type ArmDrainRecovery = (claim: {
  id: string;
  attempt: string;
  leaseExpiresAt: Date;
  source: string;
}) => Promise<void>;

/**
 * A registered function over the rows a domain already owes. It has no queue row
 * of its own: the rows are the durable state, so a lost permit loses nothing and
 * the hourly cron finds them again. Fan-out over records belongs here, never in
 * a row per record. A permit runs one page of one unit; selection
 * (`generic/jobs/service/permits.ts`) composes every drain's `due` and `next`
 * into its one statement.
 */
export type BackgroundDrain = {
  name: string;
  /** Member-facing wording for units owned by this drain. */
  label?(unit: string): string | undefined;
  /** Bidirectional mapping between this drain's units and their item streams. */
  stream?: {
    forUnit(unit: string): string | undefined;
    forKind(kind: string): string | undefined;
  };
  /** An independently reported item already represents this unit. */
  covers?(unit: string, key: string): boolean;
  /**
   * Rows `(unit text, demand boolean, since timestamp)` for units claimable
   * now; `demand` is member-visible Run work. Null when this drain cannot run
   * in the current environment.
   */
  due(): SQL | null;
  /** Scalar timestamp: when owed work next becomes claimable (may be past), or null. */
  next(): SQL | null;
  /**
   * One page of `unit`; it claims, prepares and publishes, then returns.
   * Item counts and AI cost go to the permit's meter (`countDrainItems`,
   * `addJobAiCost`) as they commit, so a page that throws still reports them.
   */
  page(
    db: Database,
    unit: string,
    armRecovery?: ArmDrainRecovery,
  ): Promise<DrainPage>;
  /**
   * Atomically reclaim and run exactly this lapsed attempt; claims nothing
   * once the attempt was reclaimed or settled.
   */
  recover?(
    db: Database,
    claim: { id: string; attempt: string },
    armRecovery: ArmDrainRecovery,
  ): Promise<DrainPage>;
};
