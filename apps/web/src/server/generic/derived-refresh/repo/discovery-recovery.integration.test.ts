import { testUserId } from "@cubby/schemas/testing";
import { and, eq } from "drizzle-orm";
import { createRepoEntity } from "tooling/factories/repo";
import { buildKernelContext } from "tooling/scenarios/context";
import { withTestDb } from "tooling/test-setup";
import { TEST_USER_ID } from "tooling/test-setup";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { activateAiRefresh } from "~/server/ai/repo/ai-refresh";
import { getDb } from "~/server/db/helpers";
import {
  cookbook,
  derivedDiscoveryPass,
  derivedRefreshCursor,
  derivedRefreshWork,
  expense,
  run,
} from "~/server/db/schema";
import { connectionDiscoveryFingerprint } from "~/server/domains/connection/repo/discovery-fingerprint";
import { upsertCookbook } from "~/server/domains/cookbook/repo/cookbook";
import { updateProduct } from "~/server/domains/product/repo/crud";
import { scheduleDerivedDiscovery } from "~/server/domains/run/service/derived-discovery";
import { processDerivedRefreshPage } from "~/server/domains/run/service/derived-refresh";
import { executeEntity } from "~/server/entity-kernel";
import { getSearchDocumentEmbeddingText } from "~/server/generic/search/repo/search-document";
import { captureBackgroundQueue } from "~/server/testing/background-queue";
import {
  createProductFixture,
  createSystemUserFixture,
  makeCookbookExtraction,
  makeProductInput,
} from "~/server/testing/repo.fixtures";
import type { WorkflowLauncher } from "~/server/workflows/runs/launcher";

import { foldDerivedRefreshCaptures } from "./capture";
import { reconcileDerivedRefreshPage } from "./reconcile";

const launcher: WorkflowLauncher = {
  create: async () => {},
  terminate: async () => {},
  status: async () => ({ state: "running", error: null }),
};

describe("discovery epoch recovery", () => {
  const ctx = withTestDb();
  let queue: ReturnType<typeof captureBackgroundQueue>;
  beforeEach(() => {
    queue = captureBackgroundQueue();
  });
  afterEach(() => queue.restore());
  it("admits positive discovery despite exhausted and provider-pending derived work", async () => {
    await createSystemUserFixture(ctx.db);
    await activateAiRefresh(ctx.db, "synthetic-positive-discovery", {
      enabled: true,
    });
    const product = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic exhausted target" }),
      ctx.actor,
    );
    await upsertCookbook(
      ctx.db,
      {
        name: "Synthetic healthy source",
        rawJson: makeCookbookExtraction([]),
        sourceLabel: "synthetic.epub",
      },
      ctx.actor,
    );
    await foldDerivedRefreshCaptures(ctx.db);
    await getDb(ctx.db).update(derivedRefreshWork).set({ publishing: true });
    await getDb(ctx.db)
      .update(derivedRefreshWork)
      .set({ state: "failed", hasFailures: true })
      .where(eq(derivedRefreshWork.entityId, product.entityId));
    await scheduleDerivedDiscovery(ctx.db, launcher);
    const [pass] = await getDb(ctx.db)
      .select()
      .from(derivedDiscoveryPass)
      .where(eq(derivedDiscoveryPass.family, "cookbook"));
    expect(pass?.runId).toBeTruthy();
  });
  async function repair() {
    await getDb(ctx.db)
      .update(derivedRefreshCursor)
      .set({ availableAt: new Date(0) });
    let repaired = false;
    for (let page = 0; page < 2_000; page++) {
      if ((await reconcileDerivedRefreshPage(ctx.db)).done) {
        repaired = true;
        break;
      }
    }
    if (!repaired)
      throw new Error("Synthetic reconciliation exceeded its page budget");
    for (let work = 0; work < 2_000; work++) {
      const result = await processDerivedRefreshPage(ctx.db);
      expect(result.errors).toEqual([]);
      if (result.done) return;
    }
    throw new Error("Synthetic repair exceeded its page budget");
  }

  it.each(["reassign", "sql-reassign", "hard-remove"] as const)(
    "repairs old Purchase adjustment text after principal %s",
    async (operation) => {
      const project = await createRepoEntity(ctx, "project", {
        name: "Synthetic departed principal project",
        defaultTrade: "other",
      });
      const vendor = await createRepoEntity(ctx, "vendor", {
        name: "Synthetic endpoint vendor",
      });
      const first = await createRepoEntity(ctx, "purchase", {
        vendorId: vendor.output.id,
        orderId: "SYNTHETIC-OLD-ENDPOINT",
        defaultProjectId: null,
      });
      const second = await createRepoEntity(ctx, "purchase", {
        vendorId: vendor.output.id,
        orderId: "SYNTHETIC-NEW-ENDPOINT",
        defaultProjectId: null,
      });
      const principal = await createRepoEntity(ctx, "expense", {
        name: "Synthetic departing principal",
        lineKind: "principal",
        trade: "other",
        cost: 100,
        purchaseId: first.output.id,
        projectId: project.output.id,
      });
      const tax = await createRepoEntity(ctx, "expense", {
        name: "Synthetic retained adjustment",
        lineKind: "tax",
        trade: "other",
        cost: 10,
        purchaseId: first.output.id,
        projectId: null,
      });
      await repair();
      const text = async () =>
        (await getSearchDocumentEmbeddingText(ctx.db, "expense", tax.entityId))
          ?.embeddingText;
      expect(await text()).toContain("Synthetic departed principal project");
      const drain = async (frontierOnly = false) => {
        for (let page = 0; page < 500; page++) {
          const result = await processDerivedRefreshPage(ctx.db, undefined, {
            frontierOnly,
          });
          expect(result.errors).toEqual([]);
          if (result.done) return;
        }
        throw new Error("Synthetic saved endpoint refresh did not terminate");
      };
      if (operation === "reassign") {
        await executeEntity(
          buildKernelContext(ctx.db, testUserId(TEST_USER_ID)),
          {
            action: "update",
            entity: "expense",
            id: principal.output.id,
            data: { notes: "Synthetic refresh awaiting provider publication" },
          },
        );
        await drain(true);
        await executeEntity(
          buildKernelContext(ctx.db, testUserId(TEST_USER_ID)),
          {
            action: "update",
            entity: "expense",
            id: principal.output.id,
            data: { purchaseId: second.output.id },
          },
        );
        await drain();
      } else if (operation === "sql-reassign") {
        await getDb(ctx.db)
          .update(expense)
          .set({ purchaseId: second.entityId })
          .where(eq(expense.id, principal.entityId));
        await repair();
      } else {
        await getDb(ctx.db)
          .delete(expense)
          .where(eq(expense.id, principal.entityId));
        await repair();
      }
      expect(await text()).not.toContain(
        "Synthetic departed principal project",
      );
    },
    30_000,
  );

  it("repairs SQL endpoint changes without traversing unrelated Project members", async () => {
    const previous = await createRepoEntity(ctx, "project", {
      name: "Synthetic previous SQL project",
      defaultTrade: "other",
    });
    const next = await createRepoEntity(ctx, "project", {
      name: "Synthetic next SQL project",
      defaultTrade: "other",
    });
    const untouched = await createRepoEntity(ctx, "expense", {
      name: "Synthetic independent SQL line",
      lineKind: "principal",
      trade: "other",
      cost: 10,
      projectId: next.output.id,
    });
    const moved = await createRepoEntity(ctx, "expense", {
      name: "Synthetic moved SQL line",
      lineKind: "principal",
      trade: "other",
      cost: 10,
      projectId: previous.output.id,
    });
    await repair();
    await repair();
    const versions = async () =>
      await getDb(ctx.db)
        .select({
          id: derivedRefreshWork.entityId,
          version: derivedRefreshWork.version,
        })
        .from(derivedRefreshWork)
        .where(eq(derivedRefreshWork.entityKind, "project"));
    const before = await versions();
    const [unrelatedBefore] = await getDb(ctx.db)
      .select()
      .from(derivedRefreshWork)
      .where(eq(derivedRefreshWork.entityId, untouched.entityId));
    await getDb(ctx.db)
      .update(expense)
      .set({ projectId: next.entityId })
      .where(eq(expense.id, moved.entityId));
    await repair();
    expect(await versions()).toEqual(before);
    const [unrelatedAfter] = await getDb(ctx.db)
      .select()
      .from(derivedRefreshWork)
      .where(eq(derivedRefreshWork.entityId, untouched.entityId));
    expect(unrelatedAfter?.version).toBe(unrelatedBefore?.version);
  }, 30_000);

  it("does not recapture unrelated records after an ordinary edit", async () => {
    const edited = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic changed root" }),
      ctx.actor,
    );
    const unrelated = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic independent root" }),
      ctx.actor,
    );
    await repair();
    await repair();
    const readVersion = async () =>
      (
        await getDb(ctx.db)
          .select({ version: derivedRefreshWork.version })
          .from(derivedRefreshWork)
          .where(eq(derivedRefreshWork.entityId, unrelated.entityId))
      )[0]?.version;
    const before = await readVersion();
    await updateProduct(
      ctx.db,
      edited.entityId,
      { notes: "Synthetic changed note" },
      ctx.actor,
    );
    await repair();
    expect(await readVersion()).toBe(before);
  }, 30_000);

  // A family pass must create a different per-source work key after bypass writes.
  it("advances the source-only Cookbook fingerprint after an unmarked edit", async () => {
    const subject = await upsertCookbook(
      ctx.db,
      {
        name: "Synthetic cookbook",
        rawJson: makeCookbookExtraction([]),
        sourceLabel: "synthetic.epub",
      },
      ctx.actor,
    );
    await repair();
    const source = {
      entityKind: "cookbook" as const,
      entityId: subject.output.id,
    };
    const before = await connectionDiscoveryFingerprint(ctx.db, source);
    await getDb(ctx.db)
      .update(cookbook)
      .set({ name: "Synthetic revised cookbook" })
      .where(eq(cookbook.id, subject.entityId));
    await repair();
    expect(await connectionDiscoveryFingerprint(ctx.db, source)).not.toBe(
      before,
    );
  });

  // Exhaustion belongs to the failed epoch, never to all future inputs.
  it("keeps an unchanged failed pass stopped but admits a changed epoch", async () => {
    await createSystemUserFixture(ctx.db);
    await activateAiRefresh(ctx.db, "synthetic-derived-discovery", {
      enabled: true,
    });
    await scheduleDerivedDiscovery(ctx.db, launcher);
    const [first] = await getDb(ctx.db)
      .select()
      .from(derivedDiscoveryPass)
      .where(eq(derivedDiscoveryPass.family, "product"));
    if (!first?.runId) throw new Error("Synthetic discovery owner missing");
    await getDb(ctx.db)
      .update(run)
      .set({ status: "failed", failureCode: "ai_work_workflow_failed" })
      .where(eq(run.id, first.runId));
    await scheduleDerivedDiscovery(ctx.db, launcher);
    const [unchanged] = await getDb(ctx.db)
      .select()
      .from(derivedDiscoveryPass)
      .where(eq(derivedDiscoveryPass.family, "product"));
    expect(unchanged?.runId).toBe(first.runId);
    await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic new discovery input" }),
      ctx.actor,
    );
    await foldDerivedRefreshCaptures(ctx.db);
    // This test isolates admission epochs; projection convergence has its own real drain regression.
    await getDb(ctx.db)
      .update(derivedRefreshWork)
      .set({ state: "completed", publishing: true });
    await scheduleDerivedDiscovery(ctx.db, launcher);
    const [changed] = await getDb(ctx.db)
      .select()
      .from(derivedDiscoveryPass)
      .where(and(eq(derivedDiscoveryPass.family, "product")));
    expect(changed?.fingerprint).not.toBe(first.fingerprint);
    expect(changed?.runId).not.toBe(first.runId);
  });
});
