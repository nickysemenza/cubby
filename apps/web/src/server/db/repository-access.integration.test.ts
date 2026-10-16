import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { user } from "./auth.schema";
import { runAfterCommit, withTransactionDatabase } from "./helpers/core";
import {
  repositoryParentDatabase,
  repositoryQueries,
  repositoryTransaction,
  repositoryTransactionDatabase,
  repositoryTransactionOn,
} from "./repository-access.boundary";

describe("projected repository transactions", () => {
  const ctx = withTestDb();
  const name = async () => {
    const [row] = await repositoryQueries(ctx.db)
      .select({ name: user.name })
      .from(user)
      .where(eq(user.id, ctx.actor.userId));
    return row?.name;
  };

  it("joins the native transaction and defers effects through nested handle savepoints", async () => {
    const observed: Array<string | undefined> = [];
    await withTransactionDatabase(ctx.db, async (outer) => {
      await repositoryTransactionDatabase(outer, async (inner) => {
        await runAfterCommit(inner, async () => {
          observed.push(await name());
        });
        await repositoryTransactionOn(inner, async (tx) => {
          expect(repositoryParentDatabase(tx)).toBe(inner);
          await repositoryTransactionOn(tx, async (joined) => {
            expect(joined).toBe(tx);
            await joined
              .update(user)
              .set({ name: "Synthetic committed member" })
              .where(eq(user.id, ctx.actor.userId));
          });
        });
      });
      expect(observed).toEqual([]);
    });
    expect(observed).toEqual(["Synthetic committed member"]);
  });

  it("rolls back projected writes when their callback fails", async () => {
    const original = await name();
    await expect(
      repositoryTransaction(ctx.db, async (tx) => {
        await tx
          .update(user)
          .set({ name: "Synthetic rolled-back member" })
          .where(eq(user.id, ctx.actor.userId));
        throw new Error("Synthetic transaction refusal");
      }),
    ).rejects.toThrow("Synthetic transaction refusal");
    expect(await name()).toBe(original);
  });
});
