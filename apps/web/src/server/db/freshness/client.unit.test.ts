import { fromPartial } from "@total-typescript/shoehorn";
import { afterEach, describe, expect, it, vi } from "vitest";

import { setCfEnv } from "~/server/cf-env";

import {
  readDatabaseFreshness,
  recordDatabaseWrite,
  notifyDatabaseChanges,
} from "./client";
import { databaseFreshness } from "./state";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  setCfEnv(undefined);
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
    setCfEnv(
      fromPartial<Env>({
        DB_FRESHNESS: {
          getByName: () => ({
            publishChanges: async () => {
              throw new Error("Synthetic notification failure");
            },
          }),
        },
      }),
    );
    await expect(notifyDatabaseChanges(["task"])).resolves.toBeUndefined();
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
