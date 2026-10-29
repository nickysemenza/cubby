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
import type { JobClaim } from "~/server/generic/jobs/repo/queue";
import {
  claimWork,
  clearWork,
  deferWork,
  nextWorkReadyAt,
} from "~/server/generic/jobs/repo/work-claims";
import { lockWork, type WorkItem } from "~/server/generic/jobs/repo/work-items";

import type { JobContext, JobHandler } from "../types";

/** What a drain adapter may know of its claim: identity for attempt tokens, never the lease itself. */
export type DrainContext = JobContext & {
  claim: Pick<JobClaim, "key" | "generation" | "leaseToken">;
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
  /** Items whose `readyAt` was moved forward with `postponeWork`. */
  retain?: readonly WorkItem[];
  /** Bounded extra ready marks whose identical effect this publication already applied. */
  covered?: readonly WorkItem[];
};

export type DrainSpec<P> = {
  /** Items claimed per page. */
  limit: number;
  /** Admission against the current work frontier, before limiting the page. */
  eligible?: (target: SQL) => SQL;
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
  /**
   * A schedule re-arms this drain (`repeatJob`), so a page with nothing ready
   * completes even while items back off; the next run retries them.
   */
  repeats?: true;
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

export function defineDrain<P>(spec: DrainSpec<P>): JobHandler {
  return {
    async prepare(db, claim, context) {
      const { backoff } = jobKindPolicy(claim.kind);
      const items = await withJobPhase("drain.claim", () =>
        claimWork(db, claim.key, spec.limit, spec.eligible),
      );
      if (!items.length) {
        const next = spec.repeats ? null : await nextWorkReadyAt(db, claim.key);
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
      const settleFailed = async (
        tx: Database,
        entries: readonly (readonly [WorkItem, unknown])[],
      ) => {
        for (const [item, error] of entries) {
          const narrowed = (await spec.lock?.(tx, [item], prepared)) ?? [item];
          const held = await lockWork(tx, narrowed);
          if (!held.length) continue;
          failed++;
          if (
            spec.exhaust &&
            spec.maxAttempts !== undefined &&
            item.attempts + 1 >= spec.maxAttempts
          ) {
            await spec.exhaust(tx, held, message(error));
            await clearWork(tx, held);
          } else await deferWork(tx, held, message(error), backoff);
        }
      };
      const { prepared, failed: preparationFailures = new Map() } =
        await withJobPhase("drain.prepare", () =>
          spec.prepare(db, items, { ...context, claim }),
        );
      for (const error of preparationFailures.values())
        if (stopsDrainPage(error)) throw error;
      if (preparationFailures.size)
        await context.fenced((tx) =>
          settleFailed(tx, [...preparationFailures]),
        );
      // A rolled-back chunk splits; committed siblings never replay.
      const publish = async (chunk: readonly WorkItem[]): Promise<void> => {
        try {
          await withJobPhase("drain.publish", () =>
            context.fenced(
              async (tx) => {
                const narrowed =
                  (await spec.lock?.(tx, chunk, prepared)) ?? chunk;
                const held = await lockWork(tx, narrowed);
                if (!held.length) return;
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
                const covered = await lockWork(
                  tx,
                  (publication?.covered ?? []).filter(
                    ({ target, ref }) => !claimedRefs.has(`${target}\0${ref}`),
                  ),
                  { drain: claim.key },
                );
                await clearWork(tx, [...completed, ...covered]);
                published += completed.length;
                coalesced += covered.length;
              },
              { isolationLevel: spec.isolationLevel },
            ),
          );
        } catch (error) {
          if (
            classifyJobFailure(error, { publication: true }).kind !== "isolated"
          )
            throw error;
          if (chunk.length === 1)
            return context.fenced((tx) =>
              settleFailed(tx, [[chunk[0]!, error]]),
            );
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
