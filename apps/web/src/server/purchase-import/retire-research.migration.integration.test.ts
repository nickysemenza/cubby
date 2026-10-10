import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { eq, sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import {
  entitySource,
  product,
  run,
  runEvidence,
  runFactEvidence,
  runFinding,
  runTarget,
} from "~/server/db/schema";
import {
  entityKernelContextSchema,
  executeEntityAs,
} from "~/server/entity-kernel";
import { getDb } from "~/server/repo/database-helpers";
import {
  createProductFixture,
  makeProductInput,
} from "~/server/repo/repo.fixtures";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import { ensureRun } from "~/server/runs/ensure-run";
import { createTestRequestContext } from "~/server/testing/request-context";

const migration = readFileSync(
  fileURLToPath(
    new URL(
      "../../../drizzle/0033_retire_unattended_research.sql",
      import.meta.url,
    ),
  ),
  "utf8",
);

// The preserving cutover step (ADR 0010): supported research provenance
// survives as Sources that still support the current value, stranded Apply
// actions disappear, and unfinished retired Runs stop.
describe("retire unattended research migration", () => {
  const ctx = withTestDb();

  it("copies supported facts into Sources and retires stranded work", async () => {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Migration member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const created = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic drill", manufacturer: "Acme" }),
      ctx.actor,
    );
    const [productRow] = await getDb(ctx.db)
      .select({ shortcode: product.shortcode })
      .from(product)
      .where(eq(product.id, created.entityId));
    const runId = await ensureRun(ctx.db, ctx.actor, {
      purpose: "product_enrichment",
      trigger: "manual",
      status: "running",
    });
    await getDb(ctx.db)
      .update(run)
      .set({ ledgerPartyId: party.id })
      .where(eq(run.id, runId));
    const [target] = await getDb(ctx.db)
      .insert(runTarget)
      .values({
        runId,
        entityKind: "product",
        entityId: created.entityId,
        state: "completed",
        targetFingerprint: "f".repeat(64),
      })
      .returning();
    const [evidence] = await getDb(ctx.db)
      .insert(runEvidence)
      .values({
        runId,
        targetId: target!.id,
        kind: "web_page",
        objectKey: "synthetic/evidence-1",
        checksum: "a".repeat(64),
        mediaType: "text/plain",
        sourceMetadata: {
          sourceURL: "https://shop.example/drill",
          capturedAt: "2026-09-01T12:00:00.000Z",
        },
      })
      .returning();
    // A category the Product still has, recorded by its internal uuid.
    const category = await insertWithShortcode(ctx.db, "productCategory", {
      name: "Synthetic power tools",
    });
    await getDb(ctx.db)
      .update(product)
      .set({ categoryId: category.id })
      .where(eq(product.id, created.entityId));
    // A Product merged into the drill after its fact was recorded.
    const loser = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic drill duplicate" }),
      ctx.actor,
    );
    await getDb(ctx.db).execute(sql`
      UPDATE "Product" SET "deletedAt" = now() WHERE "id" = ${loser.entityId}`);
    await getDb(ctx.db).execute(sql`
      UPDATE "Entity" SET "deletedAt" = now(), "mergedIntoId" = ${created.entityId}
      WHERE "id" = ${loser.entityId}`);
    const fact = {
      targetId: target!.id,
      evidenceId: evidence!.id,
      entityKind: "product" as const,
      entityId: created.entityId,
      valueFingerprint: "b".repeat(64),
    };
    await getDb(ctx.db)
      .insert(runFactEvidence)
      .values([
        {
          ...fact,
          fieldPath: "manufacturer",
          value: "Acme",
          support: {
            observation: "Manufacturer: Acme",
            reasoning: "The product page names the brand.",
          },
        },
        {
          ...fact,
          fieldPath: "categoryId",
          value: category.id,
          support: {
            observation: "Department: Power tools",
            reasoning: "The page lists the department.",
          },
        },
        {
          ...fact,
          entityId: loser.entityId,
          fieldPath: "images.isynthetic",
          value: { url: "https://shop.example/drill.jpg" },
          support: {
            observation: "Gallery image of the drill",
            reasoning: "The gallery shows this drill.",
          },
        },
        {
          ...fact,
          fieldPath: "model",
          value: "D-1",
          support: null,
          supportRetiredAt: new Date(),
        },
      ]);
    await getDb(ctx.db)
      .insert(runFinding)
      .values({
        runId,
        ledgerPartyId: party.id,
        kind: "other",
        entityKind: "product",
        entityId: created.entityId,
        summary: "Correct the model",
        evidenceFingerprint: "c".repeat(64),
        proposedFix: { kind: "research_field_correction" },
      });

    for (const statement of migration.split("--> statement-breakpoint"))
      await getDb(ctx.db).execute(sql.raw(statement));

    const sources = await getDb(ctx.db)
      .select()
      .from(entitySource)
      .where(eq(entitySource.entityId, created.entityId));
    expect(sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fieldPath: "manufacturer",
          url: "https://shop.example/drill",
          quote: "Manufacturer: Acme",
          runId,
        }),
        expect.objectContaining({ fieldPath: "categoryId" }),
        // The merged-away record's object-valued fact lands on the survivor
        // as a record-level Source.
        expect.objectContaining({
          fieldPath: null,
          valueFingerprint: null,
          quote: "Gallery image of the drill",
        }),
      ]),
    );
    expect(sources).toHaveLength(3);
    const detail = await executeEntityAs(
      entityKernelContextSchema.parse(
        createTestRequestContext(ctx.db, {
          auth: { userId: ctx.actor.userId },
        }),
      ),
      "get",
      { entity: "product", id: productRow!.shortcode, missing: "null" },
    );
    expect(detail.item).toMatchObject({
      sources: expect.arrayContaining([
        expect.objectContaining({
          fieldPath: "manufacturer",
          supportsCurrentValue: true,
        }),
        // A category reference read as its public code still matches.
        expect.objectContaining({
          fieldPath: "categoryId",
          supportsCurrentValue: true,
        }),
      ]),
    });
    const [finding] = await getDb(ctx.db)
      .select({
        status: runFinding.status,
        proposedFix: runFinding.proposedFix,
      })
      .from(runFinding)
      .where(eq(runFinding.runId, runId));
    expect(finding).toEqual({ status: "dismissed", proposedFix: null });
    const [stopped] = await getDb(ctx.db)
      .select({ status: run.status, failureCode: run.failureCode })
      .from(run)
      .where(eq(run.id, runId));
    expect(stopped).toEqual({
      status: "failed",
      failureCode: "retired_workflow",
    });
  });
});
