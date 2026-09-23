import { fromPartial } from "@total-typescript/shoehorn";
import { withTestDb } from "tooling/test-setup";
import { afterEach, describe, expect, it } from "vitest";

import { setCfEnv } from "~/server/cf-env";
import { claimCatchUp } from "~/server/repo/catch-up-claim";

import { requestCatchUp } from "./catch-up.service";

describe("app-open catch-up", () => {
  const ctx = withTestDb();
  afterEach(() => setCfEnv(undefined));

  it("accepts one queue handoff across concurrent clients", async () => {
    const batches: Array<Array<{ body: { task: { kind: string } } }>> = [];
    setCfEnv(
      fromPartial<Env>({
        BACKGROUND_QUEUE: {
          sendBatch: async (
            messages: Iterable<{ body: { task: { kind: string } } }>,
          ) => {
            batches.push([...messages]);
          },
        },
      }),
    );

    const results = await Promise.all(
      Array.from({ length: 4 }, () => requestCatchUp(ctx.db)),
    );

    expect(results.filter(({ status }) => status === "queued")).toHaveLength(1);
    expect(results.filter(({ status }) => status === "recent")).toHaveLength(3);
    expect(batches).toHaveLength(1);
    expect(batches[0]?.map(({ body }) => body.task.kind)).toEqual([
      "maintenance.recover",
      "maintenance.purchase-discovery",
    ]);
  });

  it("opens the global gate at the hour boundary", async () => {
    const first = new Date("2026-09-23T00:00:00.000Z");
    expect(await claimCatchUp(ctx.db, first)).toBe(true);
    expect(
      await claimCatchUp(ctx.db, new Date(first.getTime() + 3_599_999)),
    ).toBe(false);
    expect(
      await claimCatchUp(ctx.db, new Date(first.getTime() + 3_600_000)),
    ).toBe(true);
  });

  it("releases a rejected queue handoff so the next request can retry", async () => {
    let calls = 0;
    setCfEnv(
      fromPartial<Env>({
        BACKGROUND_QUEUE: {
          sendBatch: async () => {
            calls += 1;
            if (calls === 1) throw new Error("queue unavailable");
          },
        },
      }),
    );

    await expect(requestCatchUp(ctx.db)).rejects.toThrow("queue unavailable");
    await expect(requestCatchUp(ctx.db)).resolves.toEqual({ status: "queued" });
    expect(calls).toBe(2);
  });
});
