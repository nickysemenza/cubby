/**
 * A drain Job pages through its work items (docs/jobs.md#coarse-jobs-and-work-items): claim
 * ready items, prepare them outside any transaction, then publish fenced
 * chunks. Each item fails, backs off or exhausts alone; pause, defer and lease
 * loss stop the whole page. A domain supplies only prepare and publish.
 */
import { describeErrorCauses } from "~/lib/error-diagnostics";
import type { Database } from "~/server/db";
import { classifyJobFailure, stopsPage } from "~/server/generic/jobs/failure";
import { jobKindPolicy } from "~/server/generic/jobs/kind-policy";
import type { JobClaim } from "~/server/generic/jobs/repo/queue";
import {
  claimWork,
  clearWork,
  deferWork,
  lockWork,
  nextWorkReadyAt,
  type WorkItem,
} from "~/server/generic/jobs/repo/work-items";

import type { JobContext, JobHandler } from "../types";

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
};

export type DrainSpec<P> = {
  /** Items claimed per page. */
  limit: number;
  /** Publication weight of an item (default 1); a chunk holds at most 25. */
  weight?: (item: WorkItem, prepared: P) => number;
  isolationLevel?: "serializable";
  /** Consecutive failures before `exhaust` settles an item; omitted retries forever. */
  maxAttempts?: number;
  prepare(
    db: Database,
    items: readonly WorkItem[],
    context: JobContext & { claim: JobClaim },
  ): Promise<DrainPreparation<P>>;
  /**
   * Domain locks taken before the items are locked: producers lock domain
   * rows before marking, so locking items first would invert that order.
   */
  lock?(tx: Database, items: readonly WorkItem[], prepared: P): Promise<void>;
  /** Database writes for items still current and locked; never network work. */
  publish(
    tx: Database,
    items: readonly WorkItem[],
    prepared: P,
  ): Promise<void | DrainPublication>;
  /** Record the terminal outcome of items that ran out of attempts. */
  exhaust?(
    tx: Database,
    items: readonly WorkItem[],
    error: string,
  ): Promise<void>;
};

const message = (error: unknown) => JSON.stringify(describeErrorCauses(error));

const chunked = <P>(
  items: readonly WorkItem[],
  prepared: P,
  weight: DrainSpec<P>["weight"],
) => {
  const chunks: WorkItem[][] = [];
  let current: WorkItem[] = [];
  let load = 0;
  for (const item of items) {
    const cost = Math.max(1, weight?.(item, prepared) ?? 1);
    if (current.length && load + cost > DRAIN_PUBLISH_CHUNK) {
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
      const items = await claimWork(db, claim.key, spec.limit);
      if (!items.length) {
        const next = await nextWorkReadyAt(db, claim.key);
        return {
          page: next ? { done: false, availableAt: next } : { done: true },
        };
      }
      let published = 0;
      let failed = 0;
      const settleFailed = async (
        tx: Database,
        entries: readonly (readonly [WorkItem, unknown])[],
      ) => {
        for (const [item, error] of entries) {
          await spec.lock?.(tx, [item], prepared);
          const held = await lockWork(tx, [item]);
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
        await spec.prepare(db, items, { ...context, claim });
      for (const error of preparationFailures.values())
        if (stopsPage(classifyJobFailure(error))) throw error;
      if (preparationFailures.size)
        await context.fenced((tx) =>
          settleFailed(tx, [...preparationFailures]),
        );
      // A rolled-back chunk splits; committed siblings never replay.
      const publish = async (chunk: readonly WorkItem[]): Promise<void> => {
        try {
          await context.fenced(
            async (tx) => {
              await spec.lock?.(tx, chunk, prepared);
              const held = await lockWork(tx, chunk);
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
              await clearWork(tx, completed);
              published += completed.length;
            },
            { isolationLevel: spec.isolationLevel },
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
      ))
        await publish(chunk);
      return {
        page: {
          done: false,
          result: { processed: items.length, published, failed },
        },
      };
    },
  };
}
