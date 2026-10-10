import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import type { ProductUpdateInput } from "@cubby/schemas/product";
import { buildEntity, type EntityOverrides } from "tooling/factories/build";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  entityKernelContextSchema,
  executeEntity,
  executeEntityAs,
} from "~/server/entity-kernel";
import { createTestRequestContext } from "~/server/testing/request-context";

/**
 * `entity.update` collection patches. Ported from the retired
 * `product_enrichment.patch_external_ids` contract; failure modes:
 * - an add that should take the slot's primary leaves two identifiers
 *   competing, or a secondary add disturbs the primary;
 * - a remove/replace of an identifier the product does not hold (or holds
 *   with other attributes than `expect`) succeeds, or applies the patch's
 *   other items before failing;
 * - removing a primary leaves the slot with no primary instead of promoting
 *   the oldest secondary;
 * - barcode normalization and global identifier uniqueness bypassed by the
 *   patch path;
 * - a text-array patch replaces the whole array or accepts a stale remove.
 */
describe("collection patches through entity.update", () => {
  const ctx = withTestDb();
  const context = () =>
    entityKernelContextSchema.parse(
      createTestRequestContext(ctx.db, { auth: { userId: ctx.actor.userId } }),
    );

  const externalIdRead = z.object({
    source: z.string(),
    kind: z.string(),
    externalId: z.string(),
    isPrimary: z.boolean().nullable(),
    url: z.string().nullable(),
  });
  const read = async (code: string) =>
    z
      .object({
        aliases: z.array(z.string()),
        externalIds: z.array(externalIdRead),
      })
      .parse(
        (
          await executeEntityAs(context(), "get", {
            entity: "product",
            id: code,
            missing: "error",
          })
        ).item,
      );
  const slot = async (code: string, source: string, kind: string) =>
    (await read(code)).externalIds
      .filter((row) => row.source === source && row.kind === kind)
      .map((row) => ({ externalId: row.externalId, isPrimary: row.isPrimary }))
      .sort((left, right) => left.externalId.localeCompare(right.externalId));

  const create = async (name: string, data: EntityOverrides<"product"> = {}) =>
    (
      await executeEntityAs(context(), "create", {
        entity: "product",
        data: buildEntity("product", {
          name,
          manufacturer: "Synthetic Works",
          ...data,
        }),
      })
    ).item.id;
  const update = (code: string, data: ProductUpdateInput["data"]) =>
    executeEntity(context(), {
      action: "update",
      entity: "product",
      id: parseShortcodeFor("product", code),
      data,
    });
  const asin = (externalId: string) => ({
    source: "amazon",
    kind: "asin" as const,
    externalId,
  });
  const gtin = (externalId: string) => ({
    source: "gtin",
    kind: "gtin_14" as const,
    externalId,
  });

  it("an add takes the slot's primary unless marked secondary, and replace promotes a secondary", async () => {
    const code = await create("Patch drill", {
      externalIds: [{ ...asin("B0PATCH001"), url: null }],
    });

    await update(code, {
      externalIds: [{ op: "add", key: asin("B0PATCH002") }],
    });
    expect(await slot(code, "amazon", "asin")).toEqual([
      { externalId: "B0PATCH002", isPrimary: true },
    ]);

    await update(code, {
      externalIds: [
        { op: "add", key: asin("B0PATCH003"), value: { isPrimary: false } },
      ],
    });
    expect(await slot(code, "amazon", "asin")).toEqual([
      { externalId: "B0PATCH002", isPrimary: true },
      { externalId: "B0PATCH003", isPrimary: false },
    ]);

    await update(code, {
      externalIds: [
        {
          op: "replace",
          key: asin("B0PATCH003"),
          value: { isPrimary: true },
        },
      ],
    });
    expect(await slot(code, "amazon", "asin")).toEqual([
      { externalId: "B0PATCH002", isPrimary: false },
      { externalId: "B0PATCH003", isPrimary: true },
    ]);

    const sku = {
      source: "synthetic-shop",
      kind: "retailer_sku" as const,
      externalId: "SKU-100",
    };
    await update(code, { externalIds: [{ op: "add", key: sku }] });
    await update(code, {
      externalIds: [
        {
          op: "replace",
          key: sku,
          value: { url: "https://example.test/sku-100" },
          expect: { isPrimary: true },
        },
      ],
    });
    expect(
      (await read(code)).externalIds.find(
        (row) => row.externalId === "SKU-100",
      ),
    ).toMatchObject({ url: "https://example.test/sku-100", isPrimary: true });
  });

  it("refuses a remove of an identifier the product does not hold before changing anything", async () => {
    const code = await create("Precondition drill", {
      externalIds: [{ ...asin("B0PRECOND1"), url: null }],
    });
    await expect(
      update(code, {
        externalIds: [
          { op: "add", key: asin("B0PRECOND2"), value: { isPrimary: false } },
          { op: "remove", key: asin("B0PRECOND9") },
        ],
      }),
    ).rejects.toThrow(/holds B0PRECOND1, not the expected B0PRECOND9/);
    await expect(
      update(code, {
        externalIds: [
          {
            op: "remove",
            key: asin("B0PRECOND1"),
            expect: { isPrimary: false },
          },
        ],
      }),
    ).rejects.toThrow(/PRECOND1/);
    expect(await slot(code, "amazon", "asin")).toEqual([
      { externalId: "B0PRECOND1", isPrimary: true },
    ]);
  });

  it("removing a primary promotes the oldest surviving secondary", async () => {
    const code = await create("Promotion drill", { upc: "012345678905" });
    await update(code, {
      externalIds: [
        { op: "add", key: gtin("00012345678912"), value: { isPrimary: false } },
      ],
    });
    await update(code, {
      externalIds: [
        { op: "add", key: gtin("00012345678929"), value: { isPrimary: false } },
      ],
    });
    await update(code, {
      externalIds: [{ op: "remove", key: gtin("00012345678905") }],
    });
    expect(await slot(code, "gtin", "gtin_14")).toEqual([
      { externalId: "00012345678912", isPrimary: true },
      { externalId: "00012345678929", isPrimary: false },
    ]);
  });

  it("normalizes added barcodes and refuses an identifier another product owns", async () => {
    const owner = await create("Owner drill", {
      externalIds: [{ ...asin("B0OWNED001"), url: null }],
    });
    const code = await create("Normalized drill");
    await update(code, {
      externalIds: [{ op: "add", key: gtin("077089850017") }],
    });
    expect(await slot(code, "gtin", "gtin_14")).toEqual([
      { externalId: "00077089850017", isPrimary: true },
    ]);
    await expect(
      update(code, {
        externalIds: [
          { op: "add", key: asin("B0OWNED001"), value: { isPrimary: false } },
        ],
      }),
    ).rejects.toThrow(new RegExp(`already belongs to ${owner}`));
  });

  it("patches a text-array collection by value and refuses a stale remove", async () => {
    const code = await create("Alias drill", {
      aliases: ["Alias one", "Alias two"],
    });
    await update(code, {
      aliases: [
        { op: "add", key: "Alias three" },
        { op: "replace", key: "Alias one", value: "Alias uno" },
        { op: "remove", key: "Alias two" },
      ],
    });
    expect((await read(code)).aliases).toEqual(["Alias uno", "Alias three"]);
    await expect(
      update(code, {
        aliases: [
          { op: "add", key: "Alias four" },
          { op: "remove", key: "Alias two" },
        ],
      }),
    ).rejects.toThrow(/Alias two/);
    expect((await read(code)).aliases).toEqual(["Alias uno", "Alias three"]);
  });
});
