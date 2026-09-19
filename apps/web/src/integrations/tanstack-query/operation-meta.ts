import type { QueryKey } from "@tanstack/react-query";
import { z } from "zod";

import type { OperationTransport } from "~/lib/perf/perf-store";

import type { InvalidationTagSet } from "./cache-tags";
import type {
  OperationCacheProfile,
  OperationFreshnessPolicy,
} from "./query-policy";

export type {
  OperationCacheProfile,
  OperationFreshnessPolicy,
} from "./query-policy";

export interface CubbyOperationMeta extends Record<string, unknown> {
  transport?: OperationTransport;
  operation?: string;
  entity?: string;
  speculative?: boolean;
  /** The transport wrapper records the network lifecycle and semantic ledger. */
  observedByTransport?: boolean;
  /** Semantic cache tags owned by an operation descriptor. */
  cacheTags?: readonly OperationCacheTag[];
  /** Cache tags invalidated after a successful mutation. */
  invalidates?: InvalidationTagSet;
  /** Named descriptor policy and the resolved timings copied onto query options. */
  cacheProfile?: OperationCacheProfile;
  freshness?: OperationFreshnessPolicy;
  /**
   * Suppress the global error toast for this query. Suggestion queries are
   * advisory (a hint, never a value the user asked for) — an unconfigured AI
   * gateway must not toast on every dialog a suggestable field appears in.
   */
  silentErrors?: boolean;
}

export type OperationCacheTag = readonly [string, ...string[]];

declare module "@tanstack/react-query" {
  interface Register {
    queryMeta: CubbyOperationMeta;
    mutationMeta: CubbyOperationMeta;
  }
}

export interface OperationDescriptor {
  transport: OperationTransport;
  operation: string;
  entity?: string;
  speculative: boolean;
  observedByTransport: boolean;
}

const nestedKey = (queryKey: QueryKey): readonly unknown[] | null => {
  const head = queryKey[0];
  return Array.isArray(head) ? head : null;
};

const inferredOperation = (queryKey: QueryKey): string => {
  const head = nestedKey(queryKey);
  if (head) return head.map(String).join(".");
  return queryKey.length > 0 ? String(queryKey[0]) : "unknown";
};

const inferredTransport = (queryKey: QueryKey): OperationTransport => {
  return inferredOperation(queryKey) === "session" ? "auth" : "client";
};

export function operationDescriptor(
  queryKey: QueryKey,
  meta?: CubbyOperationMeta,
): OperationDescriptor {
  const head = nestedKey(queryKey);
  const inferredEntityResult = z.string().safeParse(head?.[0]);
  const inferredEntity = inferredEntityResult.success
    ? inferredEntityResult.data
    : undefined;
  return {
    transport: meta?.transport ?? inferredTransport(queryKey),
    operation: meta?.operation ?? inferredOperation(queryKey),
    entity: meta?.entity ?? inferredEntity,
    speculative: meta?.speculative ?? false,
    observedByTransport: meta?.observedByTransport ?? false,
  };
}
