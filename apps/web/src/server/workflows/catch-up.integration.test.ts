import type { BackgroundTaskMessage } from "@cubby/schemas/queue-messages";
import { fromPartial } from "@total-typescript/shoehorn";
import { withTestDb } from "tooling/test-setup";
import { afterEach, describe, expect, it } from "vitest";

import { setCfEnv } from "~/server/cf-env";
import { enqueueJob } from "~/server/generic/jobs/repo/producer";
import { claimJob } from "~/server/generic/jobs/repo/queue";
import { requestCatchUp } from "~/server/workflows/catch-up";

// App-open coalesces queue wakes; a lost wake cannot erase committed work.
describe("app-open catch-up queue handoff", () => {
  const ctx = withTestDb();
  afterEach(() => setCfEnv(undefined));

  it("accepts one queue handoff across concurrent clients", async () => {
    const batches: Array<Array<{ body: BackgroundTaskMessage }>> = [];
    setCfEnv(
      fromPartial<Env>({
        BACKGROUND_QUEUE: {
          sendBatch: async (
            messages: Iterable<{ body: BackgroundTaskMessage }>,
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
    expect(batches[0]?.map(({ body }) => body.queueType)).toEqual([
      "background",
    ]);
  });

  it("keeps committed work claimable when the app-open queue wake is lost", async () => {
    const pending = await enqueueJob(ctx.db, {
      key: "synthetic.lost-wake",
      kind: "synthetic.work",
      input: {},
    });
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

    await expect(requestCatchUp(ctx.db)).resolves.toEqual({ status: "queued" });
    await expect(requestCatchUp(ctx.db)).resolves.toEqual({ status: "recent" });
    expect(calls).toBe(1);
    expect((await claimJob(ctx.db, pending.id))?.id).toBe(pending.id);
  });
});
