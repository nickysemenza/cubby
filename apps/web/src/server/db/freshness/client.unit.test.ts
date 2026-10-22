import { afterEach, describe, expect, it, vi } from "vitest";

import { readDatabaseFreshness, recordDatabaseWrite } from "./client";
import { databaseFreshness } from "./state";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
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
  it("bounds an unresponsive RPC to five seconds", async () => {
    vi.useFakeTimers();
    const port = {
      readFreshness: () =>
        new Promise<ReturnType<typeof databaseFreshness>>(() => {}),
      recordWrite: async () => databaseFreshness(0),
    };
    const read = readDatabaseFreshness(port);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await read).toBeNull();
  });
});
