import {
  entityReportOut,
  type ReportBlock,
} from "@cubby/schemas/entity-report";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { updateProduct } from "~/server/repo/product/crud";
import {
  createImageFixture,
  createProductFixture as createProduct,
  makeProductInput,
} from "~/server/repo/repo.fixtures";

import { buildEntityReport } from "./index";

type Records = Extract<ReportBlock, { kind: "records" }>;

/**
 * The `records` blocks behind the product, image, location and purchase slots: one read both
 * clients draw, each row opening the record it names and each block naming its verbs.
 */
describe("records reports", () => {
  const ctx = withTestDb();

  const recordsOf = async (
    slot: Parameters<typeof buildEntityReport>[1]["slot"],
    id: string,
  ): Promise<Records> => {
    const out = entityReportOut.parse(
      await buildEntityReport(
        ctx.db,
        { slot, id },
        async () => null,
        ctx.actor,
      ),
    );
    const block = out.blocks[0];
    if (block?.kind !== "records") throw new Error(`${slot} is not records`);
    return block;
  };

  it("lists a product's package labels and the records an image is attached to", async () => {
    const product = await createProduct(
      ctx.db,
      makeProductInput({ name: "Sample canned tomatoes" }),
      ctx.actor,
    );
    const label = await createImageFixture(ctx.db, "records-label");
    const labelCode = parseShortcodeFor("image", label.shortcode);
    await updateProduct(
      ctx.db,
      product.entityId,
      {
        pendingImageIds: [labelCode],
        pendingImagePurposes: { [labelCode]: "label" },
      },
      ctx.actor,
    );

    const labels = await recordsOf("product.labels", product.id);
    // The review is a row verb, offered only where detected nutrition is new; none yet here.
    expect(labels.actions).toEqual([]);
    expect(labels.thumbnail).toBe("large");
    expect(labels.rows[0]?.actions ?? []).toEqual([]);
    expect(labels.rows).toMatchObject([
      { entity: "image", id: labelCode, title: label.filename },
    ]);
    expect(labels.rows[0]?.imageUrl).toMatch(/^https?:\/\//);
    // Present-and-empty reads, so a client never has to tell "absent" from "none".
    expect((await recordsOf("product.cookbooks", product.id)).rows).toEqual([]);
    expect(
      (await recordsOf("product.recipe-appearances", product.id)).rows,
    ).toEqual([]);

    const associations = await recordsOf("image.associations", labelCode);
    expect(associations.actions).toEqual(["attachImage"]);
    expect(associations.rows).toMatchObject([
      {
        entity: "product",
        id: product.id,
        title: "Sample canned tomatoes",
        subtitle: "attachment",
      },
    ]);
  });

  it("refuses a purchase's runs to a login with no member party", async () => {
    await expect(
      buildEntityReport(
        ctx.db,
        { slot: "purchase.runs", id: "PUR-4K7M" },
        async () => null,
        ctx.actor,
      ),
    ).rejects.toThrow(/member ledger party/);
  });
});
