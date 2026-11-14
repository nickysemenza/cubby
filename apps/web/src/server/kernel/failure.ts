import type { ExecutionWaitReason } from "@cubby/schemas/execution";

import type { UnparsedError } from "~/lib/error-utils";
import {
  findPgError,
  isTransientConnectionError,
} from "~/server/errors/db-errors";

import {
  WorkDeferredError,
  WorkPausedError,
  WorkRetryableError,
  WorkSupersededError,
  WorkTargetError,
} from "./work-errors";

/**
 * The one failure classification for claimed work and page items. Control errors
 * win anywhere in the cause chain, so wrapping never turns a lease loss into
 * a retried item.
 */
export type WorkFailure =
  | { kind: "paused"; error: WorkPausedError }
  | { kind: "deferred"; until: Date; reason: ExecutionWaitReason }
  /** Ownership is gone: stop the invocation; never retry an item for it. */
  | { kind: "interrupted" }
  /** The item's own data: roll back, split the chunk, settle the item alone. */
  | { kind: "isolated" }
  /** External and temporary: back off without exhausting. */
  | { kind: "transient" }
  | { kind: "failed" };

const causes = (error: UnparsedError) => {
  const chain: unknown[] = [];
  for (
    let cause: unknown = error;
    cause instanceof Error && !chain.includes(cause);
    cause = cause.cause
  )
    chain.push(cause);
  return chain.length ? chain : [error];
};

/** SQLSTATE data exception, integrity violation or program limit. */
const isTargetDataError = (error: UnparsedError) =>
  /^(22|23|54)/.test(findPgError(error)?.code ?? "");

export function classifyWorkFailure(
  error: UnparsedError,
  { publication = false }: { publication?: boolean } = {},
): WorkFailure {
  const chain = causes(error);
  const paused = chain.find((cause) => cause instanceof WorkPausedError);
  if (paused instanceof WorkPausedError)
    return { kind: "paused", error: paused };
  const deferred = chain.find((cause) => cause instanceof WorkDeferredError);
  if (deferred instanceof WorkDeferredError)
    return { kind: "deferred", until: deferred.until, reason: deferred.reason };
  if (chain.some((cause) => cause instanceof WorkSupersededError))
    return { kind: "interrupted" };
  if (
    chain.some((cause) => cause instanceof WorkTargetError) ||
    (publication && isTargetDataError(error))
  )
    return { kind: "isolated" };
  // Classification never replays a committed transaction or its effects here.
  // A Hyperdrive pool-slot timeout (58000), a lock wait (55P03), or a dropped
  // connection (with or without a SQLSTATE) is capacity, not the work's fault:
  // it backs off without spending attempts. Mail discovery also defers 55P03.
  if (
    chain.some((cause) => cause instanceof WorkRetryableError) ||
    chain.some((cause) => findPgError(cause)?.code === "55P03") ||
    isTransientConnectionError(error)
  )
    return { kind: "transient" };
  return { kind: "failed" };
}

/** Pause, defer and lease loss stop the whole page; item isolation never absorbs them. */
export const stopsPage = (failure: WorkFailure) =>
  failure.kind === "paused" ||
  failure.kind === "deferred" ||
  failure.kind === "interrupted";
