import { describe, expect, it } from "vitest";
import { auditLogListInfiniteQueryOptions } from "~/lib/audit-log.functions";

describe("audit log Start query options", () => {
  it("preserves the infinite-query key and cursor paging contract", () => {
    const options = auditLogListInfiniteQueryOptions({
      entityType: undefined,
      entityId: undefined,
      source: undefined,
      limit: 20,
    });

    expect(options.queryKey).toEqual([
      ["auditLog", "list"],
      {
        input: {
          entityType: undefined,
          entityId: undefined,
          source: undefined,
          limit: 20,
        },
        type: "infinite",
      },
    ]);
    expect(options.initialPageParam).toBeNull();
    expect(options.meta).toMatchObject({
      transport: "start",
      operation: "auditLog.list",
      observedByTransport: true,
    });
  });

  it("keeps the cursor out of the cache key while seeding the first page", () => {
    const options = auditLogListInfiniteQueryOptions({
      limit: 20,
      cursor: "v1.cursor",
    });

    expect(options.queryKey[1]).toEqual({
      input: { limit: 20 },
      type: "infinite",
    });
    expect(options.initialPageParam).toBe("v1.cursor");
  });
});
