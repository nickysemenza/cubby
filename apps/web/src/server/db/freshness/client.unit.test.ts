import { fromPartial } from "@total-typescript/shoehorn";
import { afterEach, describe, expect, it, vi } from "vitest";

import { setCfEnv } from "~/server/cf-env";

import { notifyDatabaseChanges } from "./client";

afterEach(() => {
  vi.useRealTimers();
  setCfEnv(undefined);
});
describe("change notification failure policy", () => {
  it("never rejects an already committed write when its notification fails", async () => {
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
    await expect(
      notifyDatabaseChanges({ task: null }),
    ).resolves.toBeUndefined();
  });
  it("bounds an unresponsive notification without a per-read RPC", async () => {
    vi.useFakeTimers();
    setCfEnv(
      fromPartial<Env>({
        DB_FRESHNESS: {
          getByName: () => ({
            publishChanges: () => new Promise<void>(() => {}),
          }),
        },
      }),
    );
    const pending = notifyDatabaseChanges({ task: null });
    await vi.advanceTimersByTimeAsync(5000);
    await expect(pending).resolves.toBeUndefined();
  });
});
