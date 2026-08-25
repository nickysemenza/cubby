import type { QueryKey } from "@tanstack/react-query";
import type { OperationTransport } from "~/lib/perf/perf-store";

export interface CubbyOperationMeta extends Record<string, unknown> {
  transport?: OperationTransport;
  operation?: string;
  entity?: string;
  speculative?: boolean;
  /** The transport wrapper records the network lifecycle and semantic ledger. */
  observedByTransport?: boolean;
}

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
  const options = queryKey[1];
  if (
    options &&
    typeof options === "object" &&
    "type" in options &&
    (options.type === "query" || options.type === "infinite")
  ) {
    return "trpc";
  }
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
