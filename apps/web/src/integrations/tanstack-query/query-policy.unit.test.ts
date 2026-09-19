import { describe, expect, it } from "vitest";

import {
  operationCachePolicy,
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
        refetchOnMount: false,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
      },
      mutations: { retry: false, networkMode: "online" },
    });
    expect(operationCachePolicy("browse")).toEqual({
      profile: "browse",
      freshness: { staleTime: 120_000 },
    });
  });

  it("keeps persisted details' long in-memory GC window", () => {
    const policy = operationCachePolicy("persisted-detail");
    expect(policy.freshness?.gcTime).toBeGreaterThanOrEqual(24 * 60 * 60_000);
  });
});
