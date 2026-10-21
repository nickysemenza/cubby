import { fromPartial } from "@total-typescript/shoehorn";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it, vi } from "vitest";

import { getDb } from "~/server/db/helpers";
import { derivedRefreshWork, searchDocument } from "~/server/db/schema";
import type { StepRunOwner } from "~/server/domains/run/repo/run-step";
import type { StepContext } from "~/server/domains/run/service/step-run";
import type { DerivedRefreshPorts } from "~/server/generic/derived-refresh/repo/refresh-ports.boundary";
import * as statementRetirement from "~/server/generic/derived-refresh/repo/statement-retirement";
import { captureBackgroundQueue } from "~/server/testing/background-queue";
import {
  createProductIdentityFixture,
  makeProductInput,
  createRecipeFixture,
  makeRecipeInput,
} from "~/server/testing/repo.fixtures";

import {
  derivedRefreshDrivers,
  processDerivedRefreshPage,
} from "./derived-refresh";

// Waiting for one provider must not suppress unrelated SQL-only repair work.
describe("derived refresh driver fairness", () => {
  const ctx = withTestDb();
  it("publishes projections without consulting providers, including recipe inputs", async () => {
    const queue = captureBackgroundQueue();
    try {
      const subject = await createRecipeFixture(
        ctx.db,
        makeRecipeInput({ name: "Synthetic provider independent recipe" }),
        ctx.actor,
      );
      const prepareRecipe = vi.fn<DerivedRefreshPorts["prepareRecipe"]>(() => {
        throw new Error("Synthetic unavailable recipe provider");
      });
      const refreshEmbeddings = vi.fn<DerivedRefreshPorts["refreshEmbeddings"]>(
        () => {
          throw new Error("Synthetic unavailable embedding provider");
        },
      );
      let done = false;
      for (let page = 0; page < 100; page++) {
        const result = await processDerivedRefreshPage(
          ctx.db,
          { prepareRecipe, refreshEmbeddings },
          { frontierOnly: true },
        );
        expect(result.errors).toEqual([]);
        if (result.done) {
          done = true;
          break;
        }
      }
      expect(done).toBe(true);
      expect(prepareRecipe).not.toHaveBeenCalled();
      expect(refreshEmbeddings).not.toHaveBeenCalled();
      const [projection] = await getDb(ctx.db)
        .select()
        .from(searchDocument)
        .where(eq(searchDocument.entityId, subject.entityId));
      expect(projection?.title).toBe("Synthetic provider independent recipe");
      const [pending] = await getDb(ctx.db)
        .select()
        .from(derivedRefreshWork)
        .where(eq(derivedRefreshWork.entityId, subject.entityId));
      expect(pending).toMatchObject({ state: "pending", publishing: true });
    } finally {
      queue.restore();
    }
  });
  it("advances periodic repair while other refresh work is in backoff", async () => {
    const queue = captureBackgroundQueue();
    try {
      await createProductIdentityFixture(
        ctx.db,
        makeProductInput({ name: "Synthetic deferred refresh" }),
        ctx.actor,
      );
      await getDb(ctx.db)
        .update(derivedRefreshWork)
        .set({ availableAt: new Date(Date.now() + 60_000) });
      const [driver] = await derivedRefreshDrivers(
        ctx.db,
        fromPartial<StepRunOwner>({}),
      );
      if (!driver) throw new Error("Derived refresh driver missing");
      const page = await driver.page(
        fromPartial<StepContext>({ db: ctx.db, retrying: false }),
      );
      expect(page.kind).toBe("progress");
    } finally {
      queue.restore();
    }
  });
  it("advances ordinary projections while statement retirement remains unfinished", async () => {
    const queue = captureBackgroundQueue();
    const statements = vi
      .spyOn(statementRetirement, "processStatementRetirementPage")
      .mockResolvedValue({ done: false, processed: 100 });
    try {
      const subject = await createProductIdentityFixture(
        ctx.db,
        makeProductInput({ name: "Synthetic retirement fairness" }),
        ctx.actor,
      );
      await getDb(ctx.db)
        .delete(searchDocument)
        .where(eq(searchDocument.entityId, subject.entityId));
      const [driver] = await derivedRefreshDrivers(
        ctx.db,
        fromPartial<StepRunOwner>({}),
      );
      if (!driver) throw new Error("Derived refresh driver missing");
      let title: string | undefined;
      for (let page = 0; page < 10 && title === undefined; page++) {
        expect(
          await driver.page(
            fromPartial<StepContext>({ db: ctx.db, retrying: false }),
          ),
        ).toMatchObject({ kind: "progress", done: false });
        title = (
          await getDb(ctx.db)
            .select({ title: searchDocument.title })
            .from(searchDocument)
            .where(eq(searchDocument.entityId, subject.entityId))
        )[0]?.title;
      }
      expect(title).toBe("Synthetic retirement fairness");
    } finally {
      statements.mockRestore();
      queue.restore();
    }
  });
});
