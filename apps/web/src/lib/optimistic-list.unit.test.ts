import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { patchListItem } from "./optimistic-list";

describe("exact optimistic list updates", () => {
  it("patches and rolls back only the affected query", async () => {
    const client = new QueryClient();
    const affected = [["task", "list"], { input: { parentTaskId: "TSK-1" } }];
    const unrelated = [["task", "list"], { input: { parentTaskId: "TSK-2" } }];
    const before = { items: [{ id: "TSK-3", status: "not_started" }] };
    client.setQueryData(affected, before);
    client.setQueryData(unrelated, {
      items: [{ id: "TSK-4", status: "not_started" }],
    });

    const snapshot = client.getQueryData(affected);
    client.setQueryData<typeof before>(affected, (current) =>
      patchListItem(current, "TSK-3", (item) => ({
        ...item,
        status: "done",
      })),
    );
    await client.invalidateQueries({ queryKey: affected, refetchType: "none" });

    expect(client.getQueryData<typeof before>(affected)?.items[0]?.status).toBe(
      "done",
    );
    expect(client.getQueryState(affected)?.isInvalidated).toBe(true);
    expect(client.getQueryState(unrelated)?.isInvalidated).toBe(false);

    client.setQueryData(affected, snapshot);
    expect(client.getQueryData(affected)).toEqual(before);
  });
});
