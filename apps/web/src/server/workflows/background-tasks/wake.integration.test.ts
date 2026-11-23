import type { BackgroundTaskMessage } from "@cubby/schemas/queue-messages";
import { fromPartial } from "@total-typescript/shoehorn";
import { sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { afterEach, describe, expect, it } from "vitest";

import { setCfEnv } from "~/server/cf-env";
import { repositoryQueries } from "~/server/db/repository-access.boundary";

import { clearDeliveredWakes, offerWake } from "./publish";

// Duplicate and stale permits must not clone wake chains.
describe("single pending future wake", () => {
  const ctx = withTestDb();
  afterEach(() => setCfEnv(undefined));

  it("sends one permit per pending deadline, re-arms on its own delivery and ignores a past one", async () => {
    const sent: BackgroundTaskMessage[] = [];
    setCfEnv(
      fromPartial<Env>({
        BACKGROUND_QUEUE: {
          sendBatch: async (
            messages: Iterable<{ body: BackgroundTaskMessage }>,
          ) => {
            for (const { body } of messages) sent.push(body);
          },
        },
      }),
    );
    const later = new Date(Date.now() + 10 * 60_000);
    const sooner = new Date(Date.now() + 5 * 60_000);

    // Two deliveries offering the same next deadline, and a later one.
    await offerWake(ctx.db, later, "synthetic.first");
    await offerWake(ctx.db, later, "synthetic.duplicate");
    await offerWake(
      ctx.db,
      new Date(later.getTime() + 60_000),
      "synthetic.late",
    );
    expect(sent.map((body) => body.at)).toEqual([later.toISOString()]);

    await offerWake(ctx.db, sooner, "synthetic.sooner");
    expect(sent.map((body) => body.at)).toEqual([
      later.toISOString(),
      sooner.toISOString(),
    ]);

    // The superseded permit leaves the pending one; the pending one's early
    // delivery clears it, so its deadline is offered again.
    await clearDeliveredWakes(ctx.db, [later.toISOString()]);
    await offerWake(ctx.db, sooner, "synthetic.stale");
    expect(sent).toHaveLength(2);
    await clearDeliveredWakes(ctx.db, [sooner.toISOString()]);
    await offerWake(ctx.db, sooner, "synthetic.early");
    expect(sent).toHaveLength(3);

    // A pending wake already past due (its permit lost) no longer blocks.
    await repositoryQueries(ctx.db).execute(
      sql`UPDATE "KernelWake" SET at = now() - interval '1 minute'`,
    );
    await offerWake(ctx.db, later, "synthetic.after-loss");
    expect(sent.at(-1)?.at).toBe(later.toISOString());
  });
});
