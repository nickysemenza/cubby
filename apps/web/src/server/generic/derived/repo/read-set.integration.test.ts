import {
  type ProductId,
  parseEntityId,
  parseShortcodeFor,
} from "@cubby/schemas/identifiers";
import { HOUSEHOLD_PROJECT_SHORTCODE } from "@cubby/schemas/project-fields";
import { fromPartial } from "@total-typescript/shoehorn";
import { eq, sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { createRepoEntity } from "tooling/factories/repo";
import { taxonomyShortcode } from "tooling/product-category-fixtures";
import { seedPerformanceCorpus } from "tooling/scenarios/performance";
import { seedEntity, withTestDb } from "tooling/test-setup";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { USDAClient } from "~/server/clients/usda";
import { storedDerivedDeclarations } from "~/server/db/derived-declarations";
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
import {
  type DerivedAdapter,
  derivedSink,
  isDerivedSink,
} from "~/server/generic/derived/repo/compute";
import { markAllStoredDerived } from "~/server/generic/derived/repo/drain";
import { readWorkItems } from "~/server/generic/jobs/jobs.fixtures";
import { prepareProductConversionCoverage } from "~/server/generic/problems/service/problems.service";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";
import { drainStoredDerived } from "~/server/testing/background-queue";
import {
  createProductFixture,
  makeProductInput,
  makeCookbookExtraction,
} from "~/server/testing/repo.fixtures";
import { derivedComputes } from "~/server/workflows/derived-computes";

/**
 * Infrastructure every compute may read without declaring it: identity and
 * the derived cache itself (a `dependsOn` value is read from `DerivedValue`).
 */
const UNDECLARED_READS = new Set(["Entity", "DerivedValue"]);

/** Full read models also load presentation fields these sinks never publish. */
const INCIDENTAL_READS = {
  // Input availability reads queue status; scheduling changes are not diagnostic inputs.
  "project.workDiagnosticFacts": new Set(["WorkItem"]),
  "recipe.totals": new Set([
    // getRecipesByIDs loads cookbook metadata; recipeWasmInput uses only yield and rows.
    "Cookbook",
    // getRecipesByIDs resolves display images; neither costing nor its fingerprint uses media.
    "EntityAttachment",
    // The same display-image projection loads image integrity and representations only.
    "Image",
    // Transparent representations are discarded before recipeWasmInput.
    "ImageDerivative",
    // Meals supply borrowed recipe images, never costing inputs.
    "Meal",
    // Meal membership is traversed only for those borrowed images.
    "MealRecipe",
  ]),
  "product.conversionCoverage": new Set([
    // loadProductsForCoverage loads brandName/brandCode for problem captions;
    // the published coverage projection uses neither.
    "Vendor",
  ]),
  "project.completionYear": new Set([
    // loadProjectTree loads assignee labels; the date-window fold uses no assignee fields.
    "LedgerParty",
  ]),
};

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
      publish: (tx, ids, prepared) => prepared.publish(tx, ids),
    }),
  ],
]);

/**
 * The read-set tracer (ADR 0021): every table a compute adapter reads must be
 * a declared input, or a change to it would leave the stored value silently
 * stale. Each declaration's compute runs (sinks: `prepare` only) over sample
 * rows of a synthetic household (the performance corpus plus one of each kind
 * it lacks) and its traced reads are compared to its inputs.
 */
describe("stored derived read sets", () => {
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

  it("reads only declared inputs", async () => {
    await seedCorpus();
    const tableNames = new Set(
      (
        await getDb(ctx.db).execute(
          sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
        )
      ).rows.map((row) => String((row as { tablename: string }).tablename)),
    );
    const undeclared: string[] = [];
    const unsampled: string[] = [];
    const failed: string[] = [];
    for (const declaration of storedDerivedDeclarations()) {
      const adapter = computes.get(declaration.compute);
      if (!adapter) {
        failed.push(`${declaration.target}: no compute adapter`);
        continue;
      }
      if (declaration.target === "project.workDiagnosticFacts")
        await drainStoredDerived(ctx.db, 100, Object.fromEntries(computes));
      const ids = (
        await getDb(ctx.db).execute(
          sql`SELECT id::text AS id FROM ${sql.identifier(declaration.table)}
          ${declaration.target === "project.workDiagnosticFacts" ? sql`WHERE shortcode=${HOUSEHOLD_PROJECT_SHORTCODE}` : sql``}
          ORDER BY id LIMIT 25`,
        )
      ).rows.map((row) => String((row as { id: string }).id));
      if (ids.length === 0) {
        unsampled.push(declaration.target);
        continue;
      }
      // Compiled SQL names every table the adapter reads.
      const compiled = vi.spyOn(PgDialect.prototype, "sqlToQuery");
      let error: string | null = null;
      try {
        await (isDerivedSink(adapter)
          ? adapter.prepare(ctx.db, ids)
          : adapter(ctx.db, ids));
      } catch (caught) {
        error = String(caught);
      }
      const tables = new Set(
        compiled.mock.results.flatMap((result) =>
          result.type === "return"
            ? [
                ...result.value.sql.matchAll(
                  /\b(?:FROM|JOIN|UPDATE|INTO)\s+"([A-Za-z][A-Za-z0-9_]*)"/giu,
                ),
              ].flatMap((match) => (match[1] ? [match[1]] : []))
            : [],
        ),
      );
      compiled.mockRestore();
      if (error) {
        failed.push(`${declaration.target}: ${error}`);
        continue;
      }
      if (tables.size === 0) {
        failed.push(`${declaration.target}: no compiled SQL observed`);
        continue;
      }
      const declared = new Set([
        declaration.table,
        ...declaration.inputs.flatMap((input) => [
          input.table,
          ...(input.path ?? []).map((step) => step.table),
        ]),
        ...declaration.dependsOn.flatMap((dependency) =>
          "through" in dependency ? [dependency.through.table] : [],
        ),
      ]);
      const incidental = Object.entries(INCIDENTAL_READS).find(
        ([target]) => target === declaration.target,
      )?.[1];
      for (const table of tables)
        if (
          tableNames.has(table) &&
          !declared.has(table) &&
          !UNDECLARED_READS.has(table) &&
          !incidental?.has(table)
        )
          undeclared.push(`${declaration.target} reads ${table}`);
    }
    expect(failed.join("\n")).toBe("");
    expect(unsampled.join("\n")).toBe("");
    expect(undeclared.join("\n")).toBe("");
  });

  it("reconciles and rebuilds every declared cache family from retained inputs", async () => {
    await seedCorpus();
    const adapters = Object.fromEntries(computes);
    const drain = async () => {
      await drainStoredDerived(ctx.db, 100, adapters);
      // Ready-only draining must not hide deferred computations from this proof.
      expect(await readWorkItems(ctx.db)).toEqual([]);
    };
    const snapshot = async () => ({
      values: (
        await getDb(ctx.db).execute(sql`
          SELECT kind || '.' || key AS target, "entityId"::text AS id,
            value, "sortNumber", "sortDate", "sortText"
          FROM "DerivedValue" ORDER BY kind, "entityId", key`)
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
      storedDerivedDeclarations()
        .filter((declaration) => declaration.publishes === "derivedValue")
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
      storedDerivedDeclarations()
        .filter((declaration) => declaration.compute.startsWith("search."))
        .map((declaration) => declaration.entity)
        .filter((entity) => !searchKinds.has(entity)),
    ).toEqual([]);
    expect(
      [
        ...new Set(
          storedDerivedDeclarations()
            .filter((declaration) => declaration.publishes === "ownTable")
            .map((declaration) => declaration.key),
        ),
      ].sort(),
    ).toEqual(["conversionCoverage", "searchDocument", "totals"]);
    expect(incremental.coverage.length).toBeGreaterThan(0);
    expect(incremental.recipes.some((row) => row.totals !== null)).toBe(true);

    await markAllStoredDerived(ctx.db);
    await drain();
    expect(await snapshot()).toEqual(incremental);

    // Clear only disposable projections, leaving all household inputs in place.
    await getDb(ctx.db).execute(sql`DELETE FROM "DerivedValue"`);
    await getDb(ctx.db).execute(sql`DELETE FROM "SearchDocument"`);
    await getDb(ctx.db).execute(sql`DELETE FROM "ProductConversionCoverage"`);
    await getDb(ctx.db).execute(
      sql`UPDATE "Recipe" SET totals = NULL, "totalsComputedAt" = NULL`,
    );
    await markAllStoredDerived(ctx.db);
    await drain();
    expect(await snapshot()).toEqual(incremental);
  });
});
