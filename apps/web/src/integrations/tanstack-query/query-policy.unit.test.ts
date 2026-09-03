import { describe, expect, it } from "vitest";

import {
  operationCachePolicy,
  PERSISTED_QUERY_MAX_AGE,
  QUERY_CLIENT_DEFAULT_OPTIONS,
} from "./query-policy";

describe("query policy", () => {
  it("keeps app-wide recovery behavior out of domain profiles", () => {
    expect(QUERY_CLIENT_DEFAULT_OPTIONS).toMatchObject({
      queries: {
        staleTime: 60_000,
        gcTime: 300_000,
        retry: false,
        networkMode: "online",
        refetchOnMount: true,
        refetchOnWindowFocus: true,
        refetchOnReconnect: false,
      },
      mutations: { retry: false, networkMode: "online" },
    });
    expect(operationCachePolicy("browse")).toEqual({
      profile: "browse",
      persistence: "memory",
      freshness: { staleTime: 120_000 },
    });
  });

  it("retains persisted details for the complete restore window", () => {
    const policy = operationCachePolicy("persisted-detail");
    expect(policy.persistence).toBe("persist");
    expect(policy.freshness?.gcTime).toBeGreaterThanOrEqual(
      PERSISTED_QUERY_MAX_AGE,
    );
  });
});
