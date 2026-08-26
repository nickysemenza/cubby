import type { QueryKey } from "@tanstack/react-query";
import type { OperationTransport } from "~/lib/perf/perf-store";

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
  invalidates?: readonly OperationCacheTag[];
  /** Whether a successful query is eligible for offline persistence. */
  persistence?: "persist" | "memory";
  /** Descriptor-owned freshness policy, also copied onto query options. */
  freshness?: OperationFreshnessPolicy;
}

export type OperationCacheTag = readonly [string, ...string[]];

export type OperationFreshnessPolicy = {
  staleTime?: number;
  gcTime?: number;
  refetchOnWindowFocus?: boolean;
  refetchOnReconnect?: boolean;
};

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
  const inferredEntity =
    head && typeof head[0] === "string" ? head[0] : undefined;
  return {
    transport: meta?.transport ?? inferredTransport(queryKey),
    operation: meta?.operation ?? inferredOperation(queryKey),
    entity: meta?.entity ?? inferredEntity,
    speculative: meta?.speculative ?? false,
    observedByTransport: meta?.observedByTransport ?? false,
  };
}
