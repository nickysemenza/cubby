import {
  type ProductId,
  parseEntityId,
  parseShortcodeFor,
} from "@cubby/schemas/identifiers";
import { fromPartial } from "@total-typescript/shoehorn";
import { eq, sql } from "drizzle-orm";
import { seedPerformanceCorpus } from "tooling/scenarios/performance";
import { countTestDbQueries, seedEntity, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { USDAClient } from "~/server/clients/usda";
import { storedDerivedDeclarations } from "~/server/db/derived-declarations";
import { getDb } from "~/server/db/helpers";
import { image } from "~/server/db/schema";
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
import { prepareProductConversionCoverage } from "~/server/generic/problems/service/problems.service";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";
import { makeCookbookExtraction } from "~/server/testing/repo.fixtures";
import { derivedComputes } from "~/server/workflows/derived-computes";

/**
 * Infrastructure every compute may read without declaring it: identity and
 * the derived cache itself (a `dependsOn` value is read from `DerivedValue`).
 */
const UNDECLARED_READS = new Set(["Entity", "DerivedValue"]);

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
      publish: async () => [],
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
    await createImageProcessingJob(ctx.db, {
      imageId: parseEntityId("image", photo.id),
      kind: "subject_lift",
      sourceContentHash: hash,
      processorRevision: IMAGE_SUBJECT_LIFT_PROCESSOR_REVISION,
    });
  }

  it("reads only declared inputs", async () => {
    await insertWithShortcode(ctx.db, "ledgerParty", {
      kind: "member",
      name: "Synthetic read-set member",
      userId: ctx.actor.userId,
    });
    await seedPerformanceCorpus(ctx.db, ctx.actor.userId, { bundles: 1 });
    await seedCorpusGaps();
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
      const ids = (
        await getDb(ctx.db).execute(
          sql`SELECT id::text AS id FROM ${sql.identifier(declaration.table)} ORDER BY id LIMIT 25`,
        )
      ).rows.map((row) => String((row as { id: string }).id));
      if (ids.length === 0) {
        unsampled.push(declaration.target);
        continue;
      }
      const traced = await countTestDbQueries(async () => {
        try {
          await (isDerivedSink(adapter)
            ? adapter.prepare(ctx.db, ids)
            : adapter(ctx.db, ids));
          return null;
        } catch (error) {
          return String(error);
        }
      });
      if (traced.result) {
        failed.push(`${declaration.target}: ${traced.result}`);
        continue;
      }
      const { tables } = traced;
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
      for (const table of tables)
        if (
          tableNames.has(table) &&
          !declared.has(table) &&
          !UNDECLARED_READS.has(table)
        )
          undeclared.push(`${declaration.target} reads ${table}`);
    }
    expect(failed.join("\n")).toBe("");
    expect(unsampled.join("\n")).toBe("");
    expect(undeclared.join("\n")).toBe("");
  });
});
