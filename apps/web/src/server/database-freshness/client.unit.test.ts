import { afterEach, describe, expect, it, vi } from "vitest";

import {
  readDashboardCountsSnapshot,
  readDatabaseFreshness,
  recordDatabaseWrite,
} from "./client";
import { databaseFreshness } from "./state";

afterEach(() => vi.useRealTimers());
describe("freshness RPC failure policy", () => {
  it("fails reads closed and never rejects a committed write notification", async () => {
    const port = {
      readFreshness: vi.fn().mockRejectedValue(new Error("offline")),
      recordWrite: vi.fn().mockRejectedValue(new Error("offline")),
    };
    expect(await readDatabaseFreshness(port)).toBeNull();
    await expect(
      recordDatabaseWrite("test.mutation", port),
    ).resolves.toBeUndefined();
  });
  it("bounds an unresponsive RPC to one second", async () => {
    vi.useFakeTimers();
    const port = {
      readFreshness: () =>
        new Promise<ReturnType<typeof databaseFreshness>>(() => {}),
      recordWrite: async () => databaseFreshness(0),
    };
    const read = readDatabaseFreshness(port);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await read).toBeNull();
  });

  it("falls back to direct reads when the dashboard snapshot fails", async () => {
    expect(
      await readDashboardCountsSnapshot({
        getDashboardCounts: async () => {
          throw new Error("offline");
        },
      }),
    ).toBeNull();
  });
});
