import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineContract, query } from "~/contracts/define";
import { auditLog } from "~/integrations/tanstack-query/generated/audit-log.gen";

import { cursorQueryOptions } from "./cursor-query-options";
import { defineOperationDomain } from "./operation-catalog";

// A reduced `activity.detail`: the registered id, only the paging shape.
const activity = defineOperationDomain(
  defineContract("activity", {
    detail: query({
      input: z.object({ id: z.string(), cursor: z.string().optional() }),
      output: z.object({
        numbers: z.array(z.int()),
        nextAttemptCursor: z.string().nullable(),
      }),
    }),
  }),
  { detail: { tags: [["activity", "detail"]], cache: "browse" } },
);

describe("cursorQueryOptions", () => {
  it("seeds the first page from a supplied cursor and keeps it out of the cache key", () => {
    const options = cursorQueryOptions(auditLog.list, {
      limit: 20,
      cursor: "v1.cursor",
    });

    expect(options.queryKey[3]).toEqual({ input: { limit: 20 } });
    expect(options.initialPageParam).toBe("v1.cursor");
    expect(
      cursorQueryOptions(auditLog.list, { limit: 20 }).initialPageParam,
    ).toBeNull();
  });

  // Failure modes: a repeated first page (the cursor never sent), a lost
  // custom next cursor (run attempts), paging past a null cursor, and a lost
  // AbortSignal.
  it("sends each next cursor, reads a custom one, and stops at null", async () => {
    const calls: { input: unknown; signal: AbortSignal | undefined }[] = [];
    const page = activity.detail.withTransport(async ({ input, signal }) => {
      calls.push({ input, signal });
      return input.cursor
        ? { numbers: [1], nextAttemptCursor: null }
        : { numbers: [2], nextAttemptCursor: "attempt-1" };
    });
    const options = cursorQueryOptions(
      page,
      { id: "IPR-4K7M" },
      (last) => last.nextAttemptCursor,
    );
    const fetched = await new QueryClient().fetchInfiniteQuery({
      ...options,
      pages: 3,
    });

    expect(fetched.pages.flatMap((entry) => entry.numbers)).toEqual([2, 1]);
    expect(calls.map((call) => call.input)).toEqual([
      { id: "IPR-4K7M" },
      { id: "IPR-4K7M", cursor: "attempt-1" },
    ]);
    expect(calls.every((call) => call.signal instanceof AbortSignal)).toBe(
      true,
    );
  });
});
