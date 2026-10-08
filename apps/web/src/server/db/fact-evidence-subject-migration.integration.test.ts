import { readFileSync } from "node:fs";
import { join } from "node:path";

import { sql } from "drizzle-orm";
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

// Populated historical proof must survive schema expansion without losing its
// source/task authority, accepted value, rationale, identifier, or timestamp.
describe("canonical fact subject migration", () => {
  const ctx = withTestDb();
  it("preserves historical Product and Purchase proof and derives each canonical subject from its task", async () => {
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
      await withTransaction(ctx.db, (tx) =>
        recordAcceptedFactEvidence(tx, {
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
        }),
      );
    }
    const db = getDb(ctx.db);
    const before = await db.select().from(runFactEvidence);
    const folder = join(import.meta.dirname, "../../../drizzle");
    const journal: { entries: { tag: string }[] } = JSON.parse(
      readFileSync(join(folder, "meta/_journal.json"), "utf8"),
    );
    const migrations = journal.entries.filter(
      (entry) =>
        entry.tag.endsWith("_fact_evidence_subject") ||
        entry.tag.endsWith("_backfill_fact_evidence_subject") ||
        entry.tag.endsWith("_fact_evidence_subject_reference"),
    );
    expect(migrations).not.toHaveLength(0);
    await db.transaction(async (tx) => {
      await tx.execute(
        sql.raw(
          'ALTER TABLE "RunFactEvidence" DROP CONSTRAINT "RunFactEvidence_entityKind_check"',
        ),
      );
      await tx.execute(
        sql.raw(
          'ALTER TABLE "RunFactEvidence" DROP COLUMN "entityKind", DROP COLUMN "entityId"',
        ),
      );
      await tx.execute(
        sql.raw(
          'CREATE UNIQUE INDEX "RunFactEvidence_claim_key" ON "RunFactEvidence" ("targetId", "evidenceId", "fieldPath", "valueFingerprint")',
        ),
      );
      for (const migration of migrations) {
        const content = readFileSync(
          join(folder, `${migration.tag}.sql`),
          "utf8",
        );
        for (const statement of content
          .split("--> statement-breakpoint")
          .map((part) => part.replace(/^(\s*--[^\n]*(?:\n|$))+/u, "").trim())
          .filter(Boolean))
          await tx.execute(sql.raw(statement));
      }
      expect(
        await tx.select().from(runFactEvidence).orderBy(runFactEvidence.id),
      ).toEqual([...before].sort((a, b) => a.id.localeCompare(b.id)));
      const nullability = await tx.execute(
        sql`SELECT column_name, is_nullable FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'RunFactEvidence' AND column_name IN ('entityKind', 'entityId') ORDER BY column_name`,
      );
      expect(nullability.rows).toEqual([
        { column_name: "entityId", is_nullable: "NO" },
        { column_name: "entityKind", is_nullable: "NO" },
      ]);
    });
  });
});
