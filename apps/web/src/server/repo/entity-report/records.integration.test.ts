import {
  entityReportOut,
  type ReportBlock,
} from "@cubby/schemas/entity-report";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { runTarget } from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import { updateProduct } from "~/server/repo/product/crud";
import {
  createImageFixture,
  createProductFixture as createProduct,
  makeProductInput,
} from "~/server/repo/repo.fixtures";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

import { buildEntityReport } from "./index";

type Records = Extract<ReportBlock, { kind: "records" }>;

/**
 * The `records` blocks behind the product, image, location and purchase slots: one read both
 * clients draw, each row opening the record it names and each block naming its verbs.
 */
describe("records reports", () => {
  const ctx = withTestDb();

  // A completed attempt can remain partially verified, and unchanged/no-write
  // research still needs a history row.
  it("shows Product research outcomes and completion time independently of completed Run status", async () => {
    const product = await createProduct(
      ctx.db,
      makeProductInput({ name: "Synthetic purchased variant" }),
      ctx.actor,
    );
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic research member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const attempt = await insertWithShortcode(ctx.db, "run", {
      purpose: "product_enrichment",
      trigger: "manual",
      status: "completed",
      ledgerPartyId: party.id,
      actorUserId: ctx.actor.userId,
      actorName: "Synthetic member",
      actorEmail: "member@example.test",
      actorLedgerPartyShortcode: party.shortcode,
      actorLedgerPartyName: party.name,
      actorLedgerPartyKind: "member",
    });
    const completedAt = new Date("2026-09-20T12:00:00Z");
    await getDb(ctx.db).insert(runTarget).values({
      runId: attempt.id,
      entityKind: "product",
      entityId: product.entityId,
      workKey: "synthetic-product-work",
      targetFingerprint: "synthetic-fingerprint",
      state: "completed",
      outcome: "partially_verified",
      completedAt,
      warning: "Exact model remains unsupported",
      diff: {},
    });
    const report = entityReportOut.parse(
      await buildEntityReport(
        ctx.db,
        { slot: "product.runs", id: product.id },
        async () => party,
        ctx.actor,
      ),
    );
    const block = report.blocks.find((item) => item.kind === "records");
    if (block?.kind !== "records")
      throw new Error("Missing Product research history");
    expect(block.rows).toHaveLength(1);
    expect(block.rows[0]).toMatchObject({
      entity: "run",
      id: attempt.shortcode,
      at: completedAt.toISOString(),
    });
    expect(block.rows[0]?.statuses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "Completed" }),
        expect.objectContaining({ label: "Partially verified" }),
      ]),
    );
    expect(block.rows[0]?.subtitle).toContain(
      "Exact model remains unsupported",
    );
    expect(block.actions).toContain("enrichProduct");
  });

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
