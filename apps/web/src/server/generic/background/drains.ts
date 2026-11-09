import type { SQL } from "drizzle-orm";

import { describeErrorCauses } from "~/lib/error-diagnostics";
import type { UnparsedError } from "~/lib/error-utils";
import type { Database } from "~/server/db/database";
import { repositorySnapshotWriteDatabase } from "~/server/db/repository-access.boundary";
import { repositoryTransactionDatabase } from "~/server/db/repository-access.boundary";
import { withJobPhase } from "~/server/generic/jobs/context";
import type { DrainItem, DrainStore } from "~/server/generic/jobs/drain-store";
import { classifyJobFailure, stopsPage } from "~/server/generic/jobs/failure";
import type { JobBackoff } from "~/server/generic/jobs/kind-policy";
import type { JobContext } from "~/server/generic/jobs/types";

export type DrainPage = {
  /** Owed items this page claimed; zero means a sibling or nobody holds the work. */
  claimed: number;
  /** Committed settlements, recorded on the unit's execution record. */
  published?: number;
  failed?: number;
};

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
  /**
   * Rows `(unit text, demand boolean, since timestamp)` for units claimable
   * now; `demand` is member-visible Run work. Null when this drain cannot run
   * in the current environment.
   */
  due(): SQL | null;
  /** Scalar timestamp: when owed work next becomes claimable (may be past), or null. */
  next(): SQL | null;
  /** One page of `unit`; it claims, prepares and publishes, then returns. */
  page(db: Database, unit: string): Promise<DrainPage>;
};

/** Pause, defer and lease loss stop the page; an adapter must rethrow them rather than settle an item. */
export const stopsDrainPage = (error: UnparsedError) =>
  stopsPage(classifyJobFailure(error));

/** Items per publication transaction; an adapter may weight heavy items. */
const DRAIN_PUBLISH_CHUNK = 25;

type DrainPreparation<P> = {
  prepared: P;
  /** Items whose preparation failed, with their errors; the rest publish. */
  failed?: ReadonlyMap<DrainItem, unknown>;
};

type DrainPublication = {
  /** Items held with `postponeWork` or `waitForWork`; their tickets stay owed. */
  retain?: readonly DrainItem[];
};

type RowContext = Pick<JobContext, "signal" | "fenced">;
export type DrainContext = JobContext & { name: string; attemptToken: string };

type RowDrainSpec<P> = {
  /** Domain-owned transaction/check seam, used for evaluation lease checks. */
  transaction?: JobContext["fenced"];
  /** Owed items, in the domain's own rows. */
  store: DrainStore & { release?(db: Database): Promise<void> };
  /** Domain-owned failure backoff. */
  backoff: JobBackoff;
  /** Items claimed per page. */
  limit: number;
  /** Publication weight of an item (default 1); each chunk holds at most 25. */
  weight?: (item: DrainItem, prepared: P) => number;
  isolationLevel?: "serializable";
  /**
   * Consecutive non-transient failures before `exhaust` settles an item.
   * Every drain bounds its items (docs/jobs.md#retries).
   */
  maxAttempts: number;
  prepare(
    db: Database,
    items: readonly DrainItem[],
    context: RowContext,
  ): Promise<DrainPreparation<P>>;
  /**
   * Runs first in every publication transaction, before the items are
   * locked: producers lock domain rows before marking, so locking items
   * first would invert that order. Producer-order writes belong here too
   * (derived fanout expansion). Returning items narrows the chunk to them;
   * the rest stay owed without spending an attempt.
   */
  lock?(
    tx: Database,
    items: readonly DrainItem[],
    prepared: P,
  ): Promise<void | readonly DrainItem[]>;
  /** Database writes for items still current and locked; never network work. */
  publish(
    tx: Database,
    items: readonly DrainItem[],
    prepared: P,
  ): Promise<void | DrainPublication>;
  /**
   * Settle items that ran out of attempts: record their terminal outcome
   * visibly and stop owing them. It replaces `clear` for those items.
   */
  exhaust(
    tx: Database,
    items: readonly DrainItem[],
    error: string,
  ): Promise<void>;
};

/**
 * Each cause is capped so the innermost one (the database's own message)
 * survives the item's 2000-character `lastError`.
 */
const message = (error: unknown) => {
  const { causes, truncated } = describeErrorCauses(error);
  return JSON.stringify({
    causes: causes.map((cause) => ({
      ...cause,
      message: cause.message.slice(0, 300),
    })),
    truncated,
  });
};

const chunked = <P>(
  items: readonly DrainItem[],
  prepared: P,
  weight: RowDrainSpec<P>["weight"],
  size: number,
) => {
  const chunks: DrainItem[][] = [];
  let current: DrainItem[] = [];
  let load = 0;
  for (const item of items) {
    const cost = Math.max(1, weight?.(item, prepared) ?? 1);
    if (current.length && load + cost > size) {
      chunks.push(current);
      current = [];
      load = 0;
    }
    current.push(item);
    load += cost;
  }
  if (current.length) chunks.push(current);
  return chunks;
};

/** One claim → prepare → publish page over domain rows, with no Job identity. */
export function rowDrain<P>(
  spec: RowDrainSpec<P>,
): (db: Database) => Promise<DrainPage> {
  return async (db) => {
    const context: RowContext = {
      signal: new AbortController().signal,
      fenced:
        spec.transaction ??
        ((work, options) =>
          (options?.isolationLevel === "serializable"
            ? repositorySnapshotWriteDatabase
            : repositoryTransactionDatabase)(db, work)),
    };
    let released = false;
    try {
      const backoff = spec.backoff;
      const { store } = spec;
      const items = await withJobPhase("drain.claim", () =>
        store.claim(db, spec.limit),
      );
      if (!items.length) return { claimed: 0 };
      let published = 0;
      let failed = 0;
      // Fenced callbacks roll back and may replay on 40001, so each one returns
      // its own counts and the page adds them only after that fence commits.
      const settleFailed = async (
        tx: Database,
        entries: readonly (readonly [DrainItem, unknown])[],
      ) => {
        let settled = 0;
        for (const [item, error] of entries) {
          const narrowed = (await spec.lock?.(tx, [item], prepared)) ?? [item];
          const held = await store.lock(tx, narrowed);
          if (!held.length) continue;
          settled++;
          // Capacity failures (a pool-slot timeout) back off without exhausting.
          if (
            classifyJobFailure(error).kind !== "transient" &&
            item.attempts + 1 >= spec.maxAttempts
          )
            await spec.exhaust(tx, held, message(error));
          else await store.defer(tx, held, message(error), backoff);
        }
        return settled;
      };
      const { prepared, failed: preparationFailures = new Map() } =
        await withJobPhase("drain.prepare", () =>
          spec.prepare(db, items, context),
        );
      for (const error of preparationFailures.values())
        if (stopsDrainPage(error)) throw error;
      if (preparationFailures.size)
        failed += await context.fenced((tx) =>
          settleFailed(tx, [...preparationFailures]),
        );
      // A rolled-back chunk splits; committed siblings never replay.
      const publish = async (chunk: readonly DrainItem[]): Promise<void> => {
        try {
          const committed = await withJobPhase("drain.publish", () =>
            context.fenced(
              async (tx) => {
                const narrowed =
                  (await spec.lock?.(tx, chunk, prepared)) ?? chunk;
                const held = await store.lock(tx, narrowed);
                if (!held.length) return 0;
                const publication = await spec.publish(tx, held, prepared);
                const retained = new Set(
                  (publication?.retain ?? []).map(
                    ({ target, ref, ticket }) => `${target}\0${ref}\0${ticket}`,
                  ),
                );
                const completed = held.filter(
                  ({ target, ref, ticket }) =>
                    !retained.has(`${target}\0${ref}\0${ticket}`),
                );
                await store.clear(tx, completed);
                return completed.length;
              },
              { isolationLevel: spec.isolationLevel },
            ),
          );
          published += committed;
        } catch (error) {
          if (
            classifyJobFailure(error, { publication: true }).kind !== "isolated"
          )
            throw error;
          if (chunk.length === 1) {
            failed += await context.fenced((tx) =>
              settleFailed(tx, [[chunk[0]!, error]]),
            );
            return;
          }
          const middle = Math.ceil(chunk.length / 2);
          await publish(chunk.slice(0, middle));
          await publish(chunk.slice(middle));
        }
      };
      for (const chunk of chunked(
        items.filter((item) => !preparationFailures.has(item)),
        prepared,
        spec.weight,
        DRAIN_PUBLISH_CHUNK,
      ))
        await publish(chunk);
      released = true;
      await spec.store.release?.(db);
      return { claimed: items.length, published, failed };
    } finally {
      if (!released) await spec.store.release?.(db);
    }
  };
}
