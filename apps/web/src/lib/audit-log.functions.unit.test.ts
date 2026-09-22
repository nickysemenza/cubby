import { describe, expect, it } from "vitest";

import { auditLogListOptions } from "~/lib/audit-log.functions";

describe("audit log Start query options", () => {
  it("starts cursor paging from the unbounded first page", () => {
    const options = auditLogListOptions({
      entityType: undefined,
      entityId: undefined,
      channel: undefined,
      limit: 20,
    });

    expect(options.initialPageParam).toBeNull();
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
