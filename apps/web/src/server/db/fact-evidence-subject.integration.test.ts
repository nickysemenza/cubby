import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { runEvidence, runFactEvidence, runTarget } from "~/server/db/schema";
import { recordAcceptedFactEvidence } from "~/server/purchase-import/fact-verification";
import { getDb, withTransaction } from "~/server/repo/database-helpers";
import {
  createProductFixture,
  makeProductInput,
} from "~/server/repo/repo.fixtures";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import { ensureRun } from "~/server/runs/ensure-run";

// Accepted proof must retain its real task/source authority and canonical
// Product or Purchase subject across idempotent writes.
describe("canonical fact subjects", () => {
  const ctx = withTestDb();
  it("preserves accepted Product and Purchase proof and derives each canonical subject from its task", async () => {
    const product = await createProductFixture(
      ctx.db,
      makeProductInput({
        name: "Synthetic retained identity",
        manufacturer: "Example Works",
      }),
      ctx.actor,
    );
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Synthetic retained merchant",
    });
    const category = await insertWithShortcode(ctx.db, "spendingCategory", {
      name: "Synthetic retained purpose",
    });
    const purchase = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
      spendingCategoryId: category.id,
    });
    await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic retained research member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const run = {
      id: await ensureRun(ctx.db, ctx.actor, {
        purpose: "product_enrichment",
        trigger: "manual",
      }),
    };
    const subjects = [
      {
        entityKind: "product" as const,
        entityId: product.entityId,
        fieldPath: "manufacturer",
        value: "Example Works",
      },
      {
        entityKind: "purchase" as const,
        entityId: purchase.id,
        fieldPath: "spendingCategoryId",
        value: category.id,
      },
    ];
    for (const subject of subjects) {
      const [target] = await getDb(ctx.db)
        .insert(runTarget)
        .values({
          runId: run.id,
          entityKind: subject.entityKind,
          entityId: subject.entityId,
          targetFingerprint: `synthetic-retained-${subject.entityKind}`,
        })
        .returning();
      if (!target) throw new Error("Synthetic retained task missing");
      const [evidence] = await getDb(ctx.db)
        .insert(runEvidence)
        .values({
          runId: run.id,
          targetId: target.id,
          kind: "browser_capture",
          objectKey: `synthetic-retained/${subject.entityKind}`,
          checksum: "a".repeat(64),
          mediaType: "text/html",
          sourceMetadata: { url: "https://shop.example.test/retained" },
        })
        .returning();
      if (!evidence) throw new Error("Synthetic retained source missing");
      const input = {
        runId: run.id,
        targetId: target.id,
        claims: [
          {
            evidenceId: evidence.id,
            fieldPath: subject.fieldPath,
            value: subject.value,
            support: {
              observation: "Synthetic retained original fact",
              reasoning:
                "The original supports this exact acquired identity and purpose.",
            },
          },
        ],
      };
      await withTransaction(ctx.db, (tx) =>
        recordAcceptedFactEvidence(tx, input),
      );
      const before = await getDb(ctx.db)
        .select()
        .from(runFactEvidence)
        .where(eq(runFactEvidence.targetId, target.id));
      expect(before).toHaveLength(1);
      expect(before).toMatchObject([
        {
          ...subject,
          targetId: target.id,
          evidenceId: evidence.id,
          support: input.claims[0]!.support,
          createdAt: expect.any(Date),
        },
      ]);
      await withTransaction(ctx.db, (tx) =>
        recordAcceptedFactEvidence(tx, input),
      );
      expect(
        await getDb(ctx.db)
          .select()
          .from(runFactEvidence)
          .where(eq(runFactEvidence.targetId, target.id)),
      ).toEqual(before);
    }
  });
});
