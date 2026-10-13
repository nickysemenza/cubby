import { readFileSync } from "node:fs";

import { buildActorContext } from "@cubby/schemas/context";
import type { EntitySourceInput } from "@cubby/schemas/entity-source";
import { parseEntityId, parseShortcodeFor } from "@cubby/schemas/identifiers";
import { testShortcode } from "@cubby/schemas/testing";
import { getShortcodeUrl } from "@cubby/shared";
import { sql } from "drizzle-orm";
import { buildEntity } from "tooling/factories/build";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  entityKernelContextSchema,
  executeEntity,
  executeEntityAs,
} from "~/server/entity-kernel";
import { unwrapDb } from "~/server/repo/database-helpers";
import { createOrReuseAttachedImage } from "~/server/repo/image";
import { resolveLiveShortcode } from "~/server/repo/shortcode-resolver";
import { createTestRequestContext } from "~/server/testing/request-context";

/**
 * Sources are caller-supplied records of where a fact was seen. Failure modes
 * this file pins down:
 * - sources silently dropped by the command schema or the kernel;
 * - the recorder taken from caller input instead of the authenticated actor;
 * - a fieldPath that names no writable field, or a source with neither url
 *   sourceEntity nor quote, accepted (and the mutation applied anyway);
 * - the fingerprint taken from the input instead of the post-write value, so
 *   a later overwrite still reads as supporting the current value;
 * - merge dropping or duplicating the loser's sources;
 * - a soft delete discarding the entity's sources;
 * - image attach ignoring its sources;
 * - internal citations kept as URLs or confused with an external lookalike;
 * - target merges or deletion breaking historical citations;
 * - different target citations incorrectly deduplicated.
 */
describe("entity sources", () => {
  const ctx = withTestDb();
  const context = () => {
    const base = entityKernelContextSchema.parse(
      createTestRequestContext(ctx.db, { auth: { userId: ctx.actor.userId } }),
    );
    return {
      ...base,
      actorContext: buildActorContext(ctx.actor.userId, "mcp", {
        oauthClientId: "synthetic-client",
      }),
    };
  };

  const sourceRead = z.object({
    fieldPath: z.string().nullable(),
    url: z.string().nullable(),
    sourceEntity: z
      .object({
        entityKind: z.string(),
        entityId: z.string(),
        name: z.string().nullable(),
        deleted: z.boolean(),
      })
      .nullable(),
    quote: z.string().nullable(),
    observedAt: z.coerce.date().nullable(),
    selectedVariant: z.string().nullable(),
    supportsCurrentValue: z.boolean().nullable(),
    recorder: z.object({
      channel: z.string(),
      oauthClientId: z.string().nullable(),
    }),
  });
  const detailSources = async (id: string) => {
    const result = await executeEntityAs(context(), "get", {
      entity: "product",
      id,
      missing: "error",
    });
    return z.object({ sources: z.array(sourceRead) }).parse(result.item)
      .sources;
  };
  const storedSources = async (entityId: string) =>
    z
      .array(
        z.object({
          fieldPath: z.string().nullable(),
          url: z.string().nullable(),
          userId: z.string(),
          channel: z.string(),
          oauthClientId: z.string().nullable(),
          valueFingerprint: z.string().nullable(),
        }),
      )
      .parse(
        (
          await unwrapDb(ctx.db).execute(
            sql`SELECT "fieldPath", url, "userId", channel, "oauthClientId", "valueFingerprint" FROM "EntitySource" WHERE "entityId" = ${entityId} ORDER BY "createdAt", url`,
          )
        ).rows,
      );

  const createProduct = async (name: string, sources?: EntitySourceInput[]) => {
    const created = await executeEntityAs(context(), "create", {
      entity: "product",
      data: buildEntity("product", {
        name,
        manufacturer: "Synthetic Works",
        model: "SW-100",
      }),
      sources,
    });
    const entityId = await resolveLiveShortcode(
      ctx.db,
      created.item.id,
      "product",
    );
    if (!entityId) throw new Error("created product did not resolve");
    return { code: created.item.id, entityId };
  };

  it("records sources with the write, attributed to the actor, and marks overwritten values historical", async () => {
    const product = await createProduct("Sourced drill", [
      {
        fieldPath: "model",
        url: "https://example.test/drill",
        quote: "Model SW-100",
        observedAt: new Date("2026-10-01T00:00:00.000Z"),
        selectedVariant: "Blue",
      },
      { quote: "Printed on the box: Synthetic Works" },
    ]);

    await executeEntity(context(), {
      action: "update",
      entity: "product",
      id: parseShortcodeFor("product", product.code),
      data: { model: "SW-200" },
      sources: [{ fieldPath: "model", url: "https://example.test/drill-v2" }],
    });

    const stored = await storedSources(product.entityId);
    expect(stored).toHaveLength(3);
    for (const row of stored) {
      expect(row).toMatchObject({
        userId: ctx.actor.userId,
        channel: "mcp",
        oauthClientId: "synthetic-client",
      });
    }
    expect(
      stored.find((row) => row.fieldPath === null)?.valueFingerprint,
    ).toBeNull();

    const sources = await detailSources(product.code);
    expect(sources).toHaveLength(3);
    expect(
      sources.find((source) => source.url === "https://example.test/drill"),
    ).toMatchObject({
      fieldPath: "model",
      quote: "Model SW-100",
      selectedVariant: "Blue",
      observedAt: new Date("2026-10-01T00:00:00.000Z"),
      supportsCurrentValue: false,
    });
    expect(
      sources.find((source) => source.url === "https://example.test/drill-v2"),
    ).toMatchObject({ fieldPath: "model", supportsCurrentValue: true });
    expect(sources.find((source) => source.fieldPath === null)).toMatchObject({
      quote: "Printed on the box: Synthetic Works",
      observedAt: null,
      supportsCurrentValue: null,
      recorder: { channel: "mcp", oauthClientId: "synthetic-client" },
    });
  });

  it("refuses an unwritable fieldPath or an empty source without applying the write", async () => {
    const product = await createProduct("Refused source drill");
    await expect(
      executeEntity(context(), {
        action: "update",
        entity: "product",
        id: parseShortcodeFor("product", product.code),
        data: { model: "SW-999" },
        sources: [{ fieldPath: "dataQuality", url: "https://example.test/x" }],
      }),
    ).rejects.toThrow(/dataQuality/);
    await expect(
      executeEntity(context(), {
        action: "update",
        entity: "product",
        id: parseShortcodeFor("product", product.code),
        data: { model: "SW-999" },
        sources: [{ fieldPath: "model" }],
      }),
    ).rejects.toThrow(/url, sourceEntity or quote/);
    await expect(
      executeEntity(context(), {
        action: "update",
        entity: "product",
        id: parseShortcodeFor("product", product.code),
        data: { model: "SW-999" },
        sources: [
          { sourceEntity: testShortcode("product", "missing-source-target") },
        ],
      }),
    ).rejects.toThrow(/Source entity not found/);
    const read = await executeEntityAs(context(), "get", {
      entity: "product",
      id: product.code,
      missing: "error",
    });
    expect(z.object({ model: z.string() }).parse(read.item).model).toBe(
      "SW-100",
    );
    expect(await storedSources(product.entityId)).toEqual([]);
  });

  it("moves sources to the merge survivor without duplicates and keeps them through a soft delete", async () => {
    const shared = { url: "https://example.test/shared", quote: "Same page" };
    const keeper = await createProduct("Source keeper", [shared]);
    const loser = await createProduct("Source loser", [
      shared,
      { url: "https://example.test/loser-only" },
    ]);

    await executeEntity(context(), {
      action: "merge",
      entity: "product",
      data: { keepId: keeper.code, mergeIds: [loser.code] },
    });

    expect(await storedSources(loser.entityId)).toEqual([]);
    expect(
      (await storedSources(keeper.entityId)).map((row) => row.url).sort(),
    ).toEqual([
      "https://example.test/loser-only",
      "https://example.test/shared",
    ]);

    await executeEntity(context(), {
      action: "delete",
      entity: "product",
      ids: [keeper.code],
    });
    expect(await storedSources(keeper.entityId)).toHaveLength(2);
  });

  it("migrates existing internal URLs without losing citation metadata or unresolved destinations", async () => {
    const target = await createProduct("Migration source document");
    const unresolvedUrl = getShortcodeUrl(
      testShortcode("product", "unresolved-legacy-source"),
    );
    const owner = await createProduct("Migration cited tool", [
      {
        fieldPath: "model",
        url: "https://example.test/legacy-source",
        quote: "SW-100",
        selectedVariant: "Synthetic blue",
        observedAt: new Date("2026-10-01T00:00:00Z"),
      },
      { url: "https://example.test/external", quote: "External evidence" },
      {
        url: "https://example.test/unresolved",
        quote: "Retained unresolved destination",
      },
    ]);
    await unwrapDb(ctx.db).execute(
      sql`UPDATE "EntitySource" SET url = ${`${getShortcodeUrl(target.code.replace(/^PRD-/, "P-"))}/?view=evidence`} WHERE "entityId" = ${owner.entityId} AND "fieldPath" = ${"model"}`,
    );
    await unwrapDb(ctx.db).execute(
      sql`UPDATE "EntitySource" SET url = ${unresolvedUrl} WHERE "entityId" = ${owner.entityId} AND url = 'https://example.test/unresolved'`,
    );
    const before = await storedSources(owner.entityId);
    const migration = readFileSync(
      new URL(
        "../../../drizzle/0052_normalize_entity_source_targets.sql",
        import.meta.url,
      ),
      "utf8",
    );
    await unwrapDb(ctx.db).execute(sql.raw(migration));
    const after = await storedSources(owner.entityId);
    expect(after).toHaveLength(before.length);
    expect(after).toEqual(
      expect.arrayContaining(
        before.map((row) => ({
          ...row,
          url: row.fieldPath === "model" ? null : row.url,
        })),
      ),
    );
    expect(await detailSources(owner.code)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fieldPath: "model",
          url: null,
          sourceEntity: expect.objectContaining({ entityId: target.code }),
          quote: "SW-100",
          supportsCurrentValue: true,
        }),
        expect.objectContaining({
          url: "https://example.test/external",
          sourceEntity: null,
        }),
        expect.objectContaining({
          url: unresolvedUrl,
          sourceEntity: null,
          quote: "Retained unresolved destination",
        }),
      ]),
    );
  });

  it("normalizes internal URLs into typed citations, preserves external URLs, and follows target lifecycle", async () => {
    const keeper = await createProduct("Citation keeper");
    const loser = await createProduct("Citation loser");
    const external = `https://example.test/products/${loser.code}`;
    const cited = await createProduct("Cited model", [
      {
        fieldPath: "model",
        sourceEntity: parseShortcodeFor("product", loser.code),
        quote: "SW-100",
      },
      { fieldPath: "model", url: getShortcodeUrl(loser.code), quote: "SW-100" },
      {
        fieldPath: "model",
        sourceEntity: parseShortcodeFor("product", keeper.code),
        quote: "SW-100",
      },
      { url: external },
    ]);
    const initial = await detailSources(cited.code);
    expect(initial).toHaveLength(3);
    expect(
      initial.find((source) => source.sourceEntity?.entityId === loser.code),
    ).toMatchObject({
      url: null,
      quote: "SW-100",
      supportsCurrentValue: true,
      sourceEntity: {
        entityKind: "product",
        entityId: loser.code,
        name: "Citation loser",
        deleted: false,
      },
    });
    expect(
      initial.find((source) => source.url === external)?.sourceEntity,
    ).toBeNull();

    await executeEntity(context(), {
      action: "merge",
      entity: "product",
      data: { keepId: keeper.code, mergeIds: [loser.code] },
    });
    const merged = await detailSources(cited.code);
    expect(merged.filter((source) => source.sourceEntity)).toHaveLength(1);
    expect(
      merged.find((source) => source.sourceEntity)?.sourceEntity?.entityId,
    ).toBe(keeper.code);
    await executeEntity(context(), {
      action: "delete",
      entity: "product",
      ids: [keeper.code],
    });
    expect(
      (await detailSources(cited.code)).find((source) => source.sourceEntity),
    ).toMatchObject({
      sourceEntity: { entityId: keeper.code, deleted: true },
      quote: "SW-100",
      supportsCurrentValue: true,
    });
  });

  it("records image-attach sources on the target entity", async () => {
    const product = await createProduct("Photographed drill");
    await createOrReuseAttachedImage(
      ctx.db,
      {
        key: `test/${crypto.randomUUID()}.jpg`,
        filename: "drill.jpg",
        contentType: "image/jpeg",
        size: 10,
        sources: [
          { url: "https://example.test/drill.jpg", quote: "Product photo" },
        ],
        recorder: context().actorContext,
      },
      { entity: "product", id: parseEntityId("product", product.entityId) },
    );
    expect(await storedSources(product.entityId)).toEqual([
      expect.objectContaining({
        fieldPath: null,
        url: "https://example.test/drill.jpg",
        channel: "mcp",
      }),
    ]);
  });
});
