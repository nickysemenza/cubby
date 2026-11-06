import {
  type ProductId,
  parseEntityId,
  parseShortcodeFor,
} from "@cubby/schemas/identifiers";
import { HOUSEHOLD_PROJECT_SHORTCODE } from "@cubby/schemas/project-fields";
import { fromPartial } from "@total-typescript/shoehorn";
import { eq, sql } from "drizzle-orm";
import { createRepoEntity } from "tooling/factories/repo";
import { taxonomyShortcode } from "tooling/product-category-fixtures";
import { seedPerformanceCorpus } from "tooling/scenarios/performance";
import { seedEntity, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { USDAClient } from "~/server/clients/usda";
import { entityStoredDerivedDeclarations } from "~/server/db/derived-declarations";
import { storedSourceSql } from "~/server/db/derived-source-sql";
import { getDb } from "~/server/db/helpers";
import {
  entityAttachment,
  image,
  ledgerParty,
  product,
  project,
} from "~/server/db/schema";
import { upsertCookbook } from "~/server/domains/cookbook/repo/cookbook";
import {
  createImageProcessingJob,
  IMAGE_SUBJECT_LIFT_PROCESSOR_REVISION,
} from "~/server/domains/image-processing/repo/image-processing";
import { createUploadedImageRecord } from "~/server/domains/image/repo/image";
import { createFinancialEvidenceFixture } from "~/server/domains/transaction-import/repo/source-transaction-record.fixtures";
import type { UsdaReleaseRpc } from "~/server/domains/usda-release/operations/rpc";
import { publishFieldAssessment } from "~/server/generic/assessment/repo/assessment";
import {
  type DerivedAdapter,
  derivedSink,
} from "~/server/generic/derived/repo/compute";
import { rebuildDerived } from "~/server/generic/derived/service/rebuild";
import { readRebuildObservation as readDerivedRebuildStatus } from "~/server/generic/jobs/repo/observation";
import { prepareProductConversionCoverage } from "~/server/generic/problems/service/problems.service";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";
import {
  createProductFixture,
  makeProductInput,
  makeCookbookExtraction,
} from "~/server/testing/repo.fixtures";
import { derivedComputes } from "~/server/workflows/derived-computes";

/** USDA is a Worker binding; the tracer needs only the database reads. */
const offlineUsda = new USDAClient(
  fromPartial<UsdaReleaseRpc>({
    lookupBatch: async (lookups: readonly unknown[]) => lookups.map(() => null),
    search: async () => ({ data: [], count: 0 }),
  }),
);
const computes = new Map<string, DerivedAdapter>([
  ...Object.entries(derivedComputes),
  [
    "product.conversionCoverage",
    derivedSink({
      prepare: (db, ids) =>
        // SAFETY: the tracer samples Product ids for this declaration.
        prepareProductConversionCoverage(db, ids as ProductId[], offlineUsda),
      publish: async (tx, ids, prepared) => {
        await prepared.publish(tx, ids);
      },
    }),
  ],
]);

/** Rebuild every deterministic cache from retained synthetic household inputs. */
describe("deterministic cache rebuild", () => {
  const ctx = withTestDb();

  const firstCode = async (table: string) => {
    const [row] = (
      await getDb(ctx.db).execute(
        sql`SELECT shortcode FROM ${sql.identifier(table)} ORDER BY id LIMIT 1`,
      )
    ).rows;
    return String((row as { shortcode: string }).shortcode);
  };

  /** Kinds the performance corpus does not create, with their relations. */
  async function seedCorpusGaps() {
    // Product Cost publishes a stored result only for service-category charges.
    const service = await createProductFixture(
      ctx.db,
      makeProductInput({
        name: "Synthetic read-set service",
        categoryId: taxonomyShortcode("services"),
      }),
      ctx.actor,
    );
    await createRepoEntity(ctx, "expense", {
      name: "Synthetic read-set service charge",
      trade: "other",
      productId: service.id,
      cost: 25,
      date: "2026-01-01",
      future: false,
    });
    const other = await seedEntity(ctx.db, "ledgerParty");
    await seedEntity(ctx.db, "ledgerTransfer", {
      fromPartyId: parseShortcodeFor(
        "ledgerParty",
        await firstCode("LedgerParty"),
      ),
      toPartyId: other.id,
    });
    for (const entity of ["recipe", "ingredient", "meal", "wish"] as const)
      await seedEntity(ctx.db, entity);
    await seedEntity(ctx.db, "project");
    await seedEntity(ctx.db, "task", { trade: "other" });
    await seedEntity(ctx.db, "financialTransaction", {
      accountId: parseShortcodeFor(
        "financialAccount",
        await firstCode("FinancialAccount"),
      ),
    });
    const plant = await seedEntity(ctx.db, "plant");
    await seedEntity(ctx.db, "planting", { plantId: plant.id });
    await seedEntity(ctx.db, "gardenEntry", {
      locationId: parseShortcodeFor("location", await firstCode("Location")),
    });
    await seedEntity(ctx.db, "device", {
      installationId: crypto.randomUUID(),
    });
    await upsertCookbook(
      ctx.db,
      {
        name: "Synthetic read-set cookbook",
        rawJson: makeCookbookExtraction(),
        sourceLabel: "read-set.epub",
      },
      ctx.actor,
    );
    await createFinancialEvidenceFixture(ctx.db);
    const photo = await createUploadedImageRecord(ctx.db, {
      key: `tests/${crypto.randomUUID()}.jpg`,
      filename: "read-set.jpg",
      contentType: "image/jpeg",
      size: 512,
    });
    const hash = "d".repeat(64);
    await getDb(ctx.db)
      .update(image)
      .set({ sha256: hash })
      .where(eq(image.id, photo.id));
    const [subject] = await getDb(ctx.db)
      .select({ id: product.id })
      .from(product)
      .limit(1);
    if (!subject) throw new Error("Synthetic Product was not created");
    await publishFieldAssessment(
      ctx.db,
      {
        entity: "product",
        recordId: subject.id,
        field: "model",
        currentValue: null,
        suggestedValue: "Synthetic read-set model",
        confidence: 0.9,
        model: "typesafe/jev",
        kind: "addition",
        status: "pending",
      },
      true,
    );
    // Attached descriptions must be traced for the owner as well as the Image.
    await getDb(ctx.db).insert(entityAttachment).values({
      entityKind: "product",
      entityId: subject.id,
      imageId: photo.id,
      purpose: "item",
    });
    await createImageProcessingJob(ctx.db, {
      imageId: parseEntityId("image", photo.id),
      kind: "subject_lift",
      sourceContentHash: hash,
      processorRevision: IMAGE_SUBJECT_LIFT_PROCESSOR_REVISION,
    });
  }

  async function seedCorpus() {
    const member = await createRepoEntity(ctx, "ledgerParty", {
      kind: "member",
      name: "Synthetic read-set member",
    });
    await getDb(ctx.db)
      .update(ledgerParty)
      .set({ userId: ctx.actor.userId })
      .where(eq(ledgerParty.id, member.entityId));
    await seedPerformanceCorpus(ctx.db, ctx.actor.userId, { bundles: 1 });
    await seedCorpusGaps();
    const created = await createRepoEntity(ctx, "project", {
      name: "Synthetic read-set anchor",
    });
    const [row] = await getDb(ctx.db)
      .select()
      .from(project)
      .where(eq(project.id, created.entityId));
    if (!row) throw new Error("Synthetic Project was not persisted");
    // The reserved system code is not assignable through the ordinary create contract.
    const { id: _id, shortcode: _shortcode, ...values } = row;
    await insertWithShortcode(ctx.db, "project", values, {
      generate: (entity) =>
        parseShortcodeFor(entity, HOUSEHOLD_PROJECT_SHORTCODE),
    });
  }

  it("rebuilds every declared cache family idempotently from retained inputs", async () => {
    await seedCorpus();
    const adapters = Object.fromEntries(computes);
    const drain = async () => {
      for (let page = 0; page < 1_000; page++) {
        if (!(await rebuildDerived(ctx.db, adapters, { force: page === 0 })))
          return;
      }
      throw new Error("Synthetic deterministic pass exceeded its page bound");
    };
    const snapshot = async () => ({
      values: (
        await getDb(ctx.db).execute(sql`
          SELECT * FROM (${sql.join(
            entityStoredDerivedDeclarations()
              .filter((entry) => entry.publishes === "derivedValue")
              .map(
                (entry) => sql`
            SELECT ${entry.target}::text AS target, e.id::text AS id, projected.value, projected."sortNumber", projected."sortDate", projected."sortText"
            FROM "Entity" e CROSS JOIN LATERAL (${storedSourceSql(entry, sql`e.id`)}) projected WHERE e.kind = ${entry.entity}`,
              ),
            sql` UNION ALL `,
          )}) values ORDER BY target,id`)
      ).rows,
      quality: (
        await getDb(ctx.db).execute(sql`
        SELECT "entityId"::text, kind, "rulesVersion", checks FROM "QualitySnapshot" ORDER BY "entityId"`)
      ).rows,
      search: (
        await getDb(ctx.db).execute(sql`
          SELECT "entityKind", "entityId"::text, title, body,
            "semanticText", "normalizedText", "sourceHash"
          FROM "SearchDocument" WHERE "deletedAt" IS NULL
          ORDER BY "entityKind", "entityId"`)
      ).rows,
      coverage: (
        await getDb(ctx.db).execute(sql`
          SELECT to_jsonb(c) - 'computedAt' AS value
          FROM "ProductConversionCoverage" c ORDER BY "productId"`)
      ).rows,
      recipes: (
        await getDb(ctx.db).execute(sql`
          SELECT id::text, totals FROM "Recipe" WHERE "deletedAt" IS NULL ORDER BY "Recipe".id`)
      ).rows,
    });
    await drain();
    const incremental = await snapshot();
    const targets = new Set(
      z
        .array(z.object({ target: z.string() }))
        .parse(incremental.values)
        .map((row) => row.target),
    );
    expect(
      entityStoredDerivedDeclarations()
        .filter(
          (declaration) =>
            declaration.publishes === "derivedValue" &&
            !declaration.snapshotSource?.view,
        )
        .map((declaration) => declaration.target)
        .filter((target) => !targets.has(target)),
    ).toEqual([]);
    expect(
      incremental.values.some(
        (row) => row.target === "inventory.valuation" && row.value !== null,
      ),
    ).toBe(true);
    const searchKinds = new Set(
      z
        .array(z.object({ entityKind: z.string() }))
        .parse(incremental.search)
        .map((row) => row.entityKind),
    );
    expect(
      entityStoredDerivedDeclarations()
        .filter((declaration) => declaration.compute.startsWith("search."))
        .map((declaration) => declaration.entity)
        .filter((entity) => !searchKinds.has(entity)),
    ).toEqual([]);
    expect(
      [
        ...new Set(
          entityStoredDerivedDeclarations()
            .filter((declaration) => declaration.publishes === "ownTable")
            .map((declaration) => declaration.key),
        ),
      ].sort(),
    ).toEqual([
      "conversionCoverage",
      "dataQuality",
      "searchDocument",
      "totals",
    ]);
    expect(incremental.coverage.length).toBeGreaterThan(0);
    expect(incremental.recipes.some((row) => row.totals !== null)).toBe(true);

    await drain();
    expect(await snapshot()).toEqual(incremental);

    // Clear only disposable projections, leaving all household inputs in place.
    for (const table of new Set(
      entityStoredDerivedDeclarations().flatMap((entry) =>
        entry.snapshotSource && !entry.snapshotSource.view
          ? [entry.snapshotSource.table]
          : [],
      ),
    ))
      await getDb(ctx.db).execute(sql`DELETE FROM ${sql.identifier(table)}`);
    await getDb(ctx.db).execute(sql`DELETE FROM "SearchDocument"`);
    await getDb(ctx.db).execute(sql`DELETE FROM "ProductConversionCoverage"`);
    await getDb(ctx.db).execute(
      sql`UPDATE "Recipe" SET totals = NULL, "totalsComputedAt" = NULL`,
    );
    await drain();
    expect(await snapshot()).toEqual(incremental);
    const status = await readDerivedRebuildStatus(ctx.db);
    expect(status.durationsMs).toHaveLength(3);
    process.stdout.write(
      JSON.stringify({
        measurement: "synthetic deterministic full rebuild",
        durationsMs: status.durationsMs,
        targetMs: 900_000,
      }) + "\n",
    );
  }, 30_000);
});
