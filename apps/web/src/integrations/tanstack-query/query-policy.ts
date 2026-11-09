import type { DefaultOptions, Query } from "@tanstack/react-query";

import type { CacheProfile } from "~/contracts/cache-policy";

const MINUTE = 60_000;

export const IDEMPOTENT_MUTATION_RETRY = 2;

/**
 * Query-cache and mutation replay defaults. Browser query transport owns
 * transient database recovery before a result reaches the cache.
 * Domain descriptors choose a cache
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
    refetchOnMount: (query: Query) => query.state.isInvalidated,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  },
  mutations: {
    retry: false,
    networkMode: "always",
  },
} as const satisfies Pick<DefaultOptions, "queries" | "mutations">;

export type OperationFreshnessPolicy = {
  staleTime: number;
  gcTime?: number;
};

export type OperationCacheProfile = CacheProfile;

export type ResolvedOperationCachePolicy = {
  profile: OperationCacheProfile;
  freshness?: OperationFreshnessPolicy;
};

/**
 * The complete cache-policy vocabulary for operation descriptors. Freshness
 * comes from `household.changed` notifications and the interaction catch-up,
 * so browsing reads stay cached; status reads reread on every mount.
 */
const OPERATION_CACHE_PROFILES: Readonly<
  Record<OperationCacheProfile, ResolvedOperationCachePolicy>
> = Object.freeze({
  browse: Object.freeze({
    profile: "browse",
    freshness: Object.freeze({ staleTime: 5 * MINUTE, gcTime: 30 * MINUTE }),
  }),
  "live-status": Object.freeze({
    profile: "live-status",
    freshness: Object.freeze({ staleTime: 0 }),
  }),
});

export const operationCachePolicy = (
  profile: OperationCacheProfile = "browse",
): ResolvedOperationCachePolicy => OPERATION_CACHE_PROFILES[profile];
