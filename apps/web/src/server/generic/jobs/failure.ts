import type { JobWaitReason } from "@cubby/schemas/job";

import type { UnparsedError } from "~/lib/error-utils";
import { findPgError } from "~/server/errors/db-errors";

import {
  JobDeferredError,
  JobPausedError,
  JobRetryableError,
  JobSupersededError,
  JobTargetError,
} from "./errors";

/**
 * The one failure classification for Jobs and drain items. Control errors
 * win anywhere in the cause chain, so wrapping never turns a lease loss into
 * a retried item (ADR 0015).
 */
export type JobFailure =
  | { kind: "paused"; error: JobPausedError }
  | { kind: "deferred"; until: Date; reason: JobWaitReason }
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

export function classifyJobFailure(
  error: UnparsedError,
  { publication = false }: { publication?: boolean } = {},
): JobFailure {
  const chain = causes(error);
  const paused = chain.find((cause) => cause instanceof JobPausedError);
  if (paused instanceof JobPausedError)
    return { kind: "paused", error: paused };
  const deferred = chain.find((cause) => cause instanceof JobDeferredError);
  if (deferred instanceof JobDeferredError)
    return { kind: "deferred", until: deferred.until, reason: deferred.reason };
  if (chain.some((cause) => cause instanceof JobSupersededError))
    return { kind: "interrupted" };
  if (
    chain.some((cause) => cause instanceof JobTargetError) ||
    (publication && isTargetDataError(error))
  )
    return { kind: "isolated" };
  if (chain.some((cause) => cause instanceof JobRetryableError))
    return { kind: "transient" };
  return { kind: "failed" };
}

/** Pause, defer and lease loss stop the whole page; item isolation never absorbs them. */
export const stopsPage = (failure: JobFailure) =>
  failure.kind === "paused" ||
  failure.kind === "deferred" ||
  failure.kind === "interrupted";
