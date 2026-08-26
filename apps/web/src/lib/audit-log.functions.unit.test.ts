import { describe, expect, it } from "vitest";
import { auditLogListOptions } from "~/lib/audit-log.functions";

describe("audit log Start query options", () => {
  it("preserves the infinite-query key and cursor paging contract", () => {
    const options = auditLogListOptions({
      entityType: undefined,
      entityId: undefined,
      source: undefined,
      limit: 20,
    });

    expect(options.queryKey).toEqual([
      "operation",
      "auditLog.list",
      "infinite",
      {
        input: {
          entityType: undefined,
          entityId: undefined,
          source: undefined,
          limit: 20,
        },
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
    const options = auditLogListOptions({
      limit: 20,
      cursor: "v1.cursor",
    });

    expect(options.queryKey[3]).toEqual({
      input: { limit: 20 },
    });
    expect(options.initialPageParam).toBe("v1.cursor");
  });
});
