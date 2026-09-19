import type { DefaultOptions } from "@tanstack/react-query";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export const IDEMPOTENT_MUTATION_RETRY = 2;

/**
 * App-wide transport and recovery policy. Domain descriptors choose a cache
 * profile below; they do not restate these defaults.
 *
 * Cached queries are deliberately passive after their first load. Explicit
 * invalidation and manual refetch remain available, but background browser
 * focus and component-remount events do not spend network requests.
 */
export const QUERY_CLIENT_DEFAULT_OPTIONS = {
  queries: {
    staleTime: MINUTE,
    gcTime: 5 * MINUTE,
    retry: false,
    networkMode: "online",
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  },
  mutations: {
    retry: false,
    networkMode: "online",
  },
} as const satisfies Pick<DefaultOptions, "queries" | "mutations">;

export type OperationFreshnessPolicy = {
  staleTime: number;
  gcTime?: number;
};

export type OperationCacheProfile =
  | "interactive"
  | "live-status"
  | "browse"
  | "stable"
  | "derived-summary"
  | "persisted-detail";

export type ResolvedOperationCachePolicy = {
  profile: OperationCacheProfile;
  freshness?: OperationFreshnessPolicy;
};

/**
 * The complete cache-policy vocabulary for operation descriptors. These names
 * encode resource behavior, so equal durations used for unrelated UI concerns
 * stay local instead of becoming coupled through a bag of timing constants.
 */
const OPERATION_CACHE_PROFILES: Readonly<
  Record<OperationCacheProfile, ResolvedOperationCachePolicy>
> = Object.freeze({
  interactive: Object.freeze({
    profile: "interactive",
  }),
  "live-status": Object.freeze({
    profile: "live-status",
    freshness: Object.freeze({ staleTime: 0 }),
  }),
  browse: Object.freeze({
    profile: "browse",
    freshness: Object.freeze({ staleTime: 2 * MINUTE }),
  }),
  stable: Object.freeze({
    profile: "stable",
    freshness: Object.freeze({ staleTime: 5 * MINUTE }),
  }),
  "derived-summary": Object.freeze({
    profile: "derived-summary",
    freshness: Object.freeze({
      staleTime: 5 * MINUTE,
      gcTime: 30 * MINUTE,
    }),
  }),
  "persisted-detail": Object.freeze({
    profile: "persisted-detail",
    freshness: Object.freeze({
      staleTime: 5 * MINUTE,
      // Long in-memory GC — this entity's detail is worth keeping warm well
      // past the tab's active session even without disk persistence.
      gcTime: 24 * HOUR,
    }),
  }),
});

export const operationCachePolicy = (
  profile: OperationCacheProfile = "interactive",
): ResolvedOperationCachePolicy => OPERATION_CACHE_PROFILES[profile];
