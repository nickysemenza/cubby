import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { invalidateQueryRoots, queryKeys } from "./query-keys";

describe("invalidateQueryRoots", () => {
  it("bridges legacy entity roots to operation cache tags", async () => {
    const queryClient = new QueryClient();
    const taskKey = ["operation", "task.listActionable", { input: undefined }];
    const calendarKey = ["operation", "calendar.range", { input: {} }];
    queryClient.setQueryData(taskKey, ["cached task"]);
    queryClient.setQueryData(calendarKey, ["cached calendar"]);
    queryClient
      .getQueryCache()
      .find({ queryKey: taskKey })!
      .setOptions({
        meta: { cacheTags: [["task"], ["task", "listActionable"]] },
      });
    queryClient
      .getQueryCache()
      .find({ queryKey: calendarKey })!
      .setOptions({
        meta: { cacheTags: [["calendar", "range"]] },
      });

    invalidateQueryRoots(queryClient, [queryKeys.task.all]);
    await Promise.resolve();

    expect(queryClient.getQueryState(taskKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(calendarKey)?.isInvalidated).toBe(false);
  });
});
