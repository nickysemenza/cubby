import type { SQL } from "drizzle-orm";

/**
 * A drain Job pages through its work items (docs/jobs.md#coarse-jobs-and-work-items): claim
 * ready items, prepare them outside any transaction, then publish fenced
 * chunks. Each item fails, backs off or exhausts alone; pause, defer and lease
 * loss stop the whole page. A domain supplies only prepare and publish.
 */
import { describeErrorCauses } from "~/lib/error-diagnostics";
import type { UnparsedError } from "~/lib/error-utils";
import type { Database } from "~/server/db";
import { withJobPhase } from "~/server/generic/jobs/context";
import { classifyJobFailure, stopsPage } from "~/server/generic/jobs/failure";
import { jobKindPolicy } from "~/server/generic/jobs/kind-policy";
import type { JobBackoff } from "~/server/generic/jobs/kind-policy";
import type { JobClaim } from "~/server/generic/jobs/repo/queue";
import {
  claimWork,
  clearWork,
  deferWork,
  nextWorkReadyAt,
} from "~/server/generic/jobs/repo/work-claims";
import { lockWork, type WorkItem } from "~/server/generic/jobs/repo/work-items";

import type { JobContext, PreparedJobPage } from "../types";

/** What a drain adapter may know of its claim: identity for attempt tokens, never the lease itself. */
export type DrainContext = JobContext & {
  claim: DrainClaim;
};

/** The identity a page reads: a drain Job's claim, or a domain row drain's page. */
export type DrainClaim = Pick<JobClaim, "key" | "generation" | "leaseToken"> & {
  kind?: string;
};

/** Pause, defer and lease loss stop the page; an adapter must rethrow them rather than settle an item. */
export const stopsDrainPage = (error: UnparsedError) =>
  stopsPage(classifyJobFailure(error));

/** Items per publication transaction; an adapter may weight heavy items. */
const DRAIN_PUBLISH_CHUNK = 25;

type DrainPreparation<P> = {
  prepared: P;
  /** Items whose preparation failed, with their errors; the rest publish. */
  failed?: ReadonlyMap<WorkItem, unknown>;
};

type DrainPublication = {
  /** Items held with `postponeWork` or `waitForWork`; their tickets stay owed. */
  retain?: readonly WorkItem[];
  /** Bounded extra ready marks whose identical effect this publication already applied. */
  covered?: readonly WorkItem[];
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

const workItemStore = (drain: string): DrainStore => ({
  claim: (db, limit, eligible) => claimWork(db, drain, limit, eligible),
  lock: (tx, items, options) => lockWork(tx, items, options),
  clear: (tx, items) => clearWork(tx, items),
  defer: (tx, items, error, backoff) => deferWork(tx, items, error, backoff),
  nextReadyAt: (db) => nextWorkReadyAt(db, drain),
});

export type DrainSpec<P> = {
  /** Owed items in a domain's own rows; omitted, they are `WorkItem`s of the claim's key. */
  store?: DrainStore;
  /** Failure backoff when the claim's kind declares none. */
  backoff?: JobBackoff;
  /** Items claimed per page. */
  limit: number;
  /** Admission against the current work frontier, before limiting the page. */
  eligible?: (target: SQL) => SQL;
  /** Keep an ordered preparation prefix; omitted items stay owed unless covered by an identical applied effect. */
  admit?: (items: readonly WorkItem[]) => readonly WorkItem[];
  /** Publication weight of an item (default 1); a chunk holds at most `chunk`. */
  weight?: (item: WorkItem, prepared: P) => number;
  /** Weight one publication transaction holds (default 25). */
  chunk?: number;
  isolationLevel?: "serializable";
  /** Consecutive failures before `exhaust` settles an item; omitted retries forever. */
  maxAttempts?: number;
  prepare(
    db: Database,
    items: readonly WorkItem[],
    context: DrainContext,
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
    items: readonly WorkItem[],
    prepared: P,
  ): Promise<void | readonly WorkItem[]>;
  /** Database writes for items still current and locked; never network work. */
  publish(
    tx: Database,
    items: readonly WorkItem[],
    prepared: P,
  ): Promise<void | DrainPublication>;
  /** Fenced writes when a page finds nothing ready (derived clock expiry). */
  idle?(tx: Database): Promise<void>;
  /** Record the terminal outcome of items that ran out of attempts. */
  exhaust?(
    tx: Database,
    items: readonly WorkItem[],
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
  items: readonly WorkItem[],
  prepared: P,
  weight: DrainSpec<P>["weight"],
  size: number,
) => {
  const chunks: WorkItem[][] = [];
  let current: WorkItem[] = [];
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

/** A drain's page: a `JobHandler` for a drain Job, or run directly by a row drain. */
export type DrainHandler = {
  prepare(
    db: Database,
    claim: DrainClaim,
    context: JobContext,
  ): Promise<PreparedJobPage>;
};

export function defineDrain<P>(spec: DrainSpec<P>): DrainHandler {
  return {
    async prepare(db, claim, context) {
      const backoff =
        spec.backoff ?? jobKindPolicy(claim.kind ?? claim.key).backoff;
      const store = spec.store ?? workItemStore(claim.key);
      const observed = await withJobPhase("drain.claim", () =>
        store.claim(db, spec.limit, spec.eligible),
      );
      const items = spec.admit?.(observed) ?? observed;
      if (!items.length) {
        const next = await store.nextReadyAt(db);
        return {
          page: next ? { done: false, availableAt: next } : { done: true },
          ...(spec.idle ? { publish: (tx) => spec.idle!(tx) } : {}),
        };
      }
      let published = 0;
      let failed = 0;
      let coalesced = 0;
      const claimedRefs = new Set(
        items.map(({ target, ref }) => `${target}\0${ref}`),
      );
      // Fenced callbacks roll back and may replay on 40001, so each one returns
      // its own counts and the page adds them only after that fence commits.
      const settleFailed = async (
        tx: Database,
        entries: readonly (readonly [WorkItem, unknown])[],
      ) => {
        let settled = 0;
        for (const [item, error] of entries) {
          const narrowed = (await spec.lock?.(tx, [item], prepared)) ?? [item];
          const held = await store.lock(tx, narrowed);
          if (!held.length) continue;
          settled++;
          if (
            spec.exhaust &&
            spec.maxAttempts !== undefined &&
            item.attempts + 1 >= spec.maxAttempts
          ) {
            await spec.exhaust(tx, held, message(error));
            await store.clear(tx, held);
          } else await store.defer(tx, held, message(error), backoff);
        }
        return settled;
      };
      const { prepared, failed: preparationFailures = new Map() } =
        await withJobPhase("drain.prepare", () =>
          spec.prepare(db, items, { ...context, claim }),
        );
      for (const error of preparationFailures.values())
        if (stopsDrainPage(error)) throw error;
      if (preparationFailures.size)
        failed += await context.fenced((tx) =>
          settleFailed(tx, [...preparationFailures]),
        );
      // A rolled-back chunk splits; committed siblings never replay.
      const publish = async (chunk: readonly WorkItem[]): Promise<void> => {
        try {
          const committed = await withJobPhase("drain.publish", () =>
            context.fenced(
              async (tx) => {
                const narrowed =
                  (await spec.lock?.(tx, chunk, prepared)) ?? chunk;
                const held = await store.lock(tx, narrowed);
                if (!held.length) return { published: 0, covered: 0 };
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
                // Coverage cannot consume retained work or claims belonging to
                // a later chunk. Producers may have re-marked any extra item.
                const covered = await store.lock(
                  tx,
                  (publication?.covered ?? []).filter(
                    ({ target, ref }) => !claimedRefs.has(`${target}\0${ref}`),
                  ),
                  { drain: claim.key },
                );
                await store.clear(tx, [...completed, ...covered]);
                return { published: completed.length, covered: covered.length };
              },
              { isolationLevel: spec.isolationLevel },
            ),
          );
          published += committed.published;
          coalesced += committed.covered;
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
        spec.chunk ?? DRAIN_PUBLISH_CHUNK,
      ))
        await publish(chunk);
      return {
        page: {
          done: false,
          result: {
            processed: items.length,
            published,
            failed,
            covered: coalesced,
          },
        },
      };
    },
  };
}
