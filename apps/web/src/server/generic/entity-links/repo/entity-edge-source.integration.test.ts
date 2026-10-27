import { recordSourceTransactionRecordsInput } from "@cubby/schemas/source-transaction-record";
import { eq } from "drizzle-orm";
import { createRepoEntity } from "tooling/factories/repo";
import { TEST_ACTOR, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb } from "~/server/db/helpers";
import {
  imageSighting,
  purchase,
  sourceTransactionRecord,
} from "~/server/db/schema";
import { createOrReuseAttachedImage } from "~/server/domains/image/repo/image";
import { mergeProducts } from "~/server/domains/product/repo/merge";
import { recordSourceTransactionRecords } from "~/server/domains/transaction-import/repo/source-transaction-record";
import { listSourceTransactionRecords } from "~/server/domains/transaction-import/repo/source-transaction-record.fixtures";
import { kernelScaffold } from "~/server/entity-kernel/scaffolds";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";
import {
  createImageFixture,
  createInventoryFixture,
  createLocationFixture,
  createProductFixture,
  createProductIdentityFixture,
  makeLocationInput,
  makeProductInput,
} from "~/server/testing/repo.fixtures";

import { findOrphanEntities, getEntityConnections } from "./entity-edge-source";

describe("entity edge source", () => {
  const ctx = withTestDb();

  const seedStockedProduct = async (name: string) => {
    const shelf = await createLocationFixture(
      ctx.db,
      makeLocationInput({ name: `${name} shelf` }),
      TEST_ACTOR,
    );
    const item = await createProductFixture(
      ctx.db,
      makeProductInput({ name }),
      TEST_ACTOR,
    );
    await createInventoryFixture(
      ctx.db,
      {
        productId: item.id,
        locationId: shelf.id,
        amount: { value: 1, unit: "each" },
        placement: "stock",
      },
      TEST_ACTOR,
    );
    await createOrReuseAttachedImage(
      ctx.db,
      {
        key: `test/${crypto.randomUUID()}.jpg`,
        filename: `${name}.jpg`,
        contentType: "image/jpeg",
        size: 10,
      },
      { entity: "product", id: item.entityId },
    );
    return { item, shelf };
  };

  it("groups one-hop connections both ways, across join rows and attachments", async () => {
    const { item, shelf } = await seedStockedProduct("Edge lamp");

    const connections = await getEntityConnections(
      ctx.db,
      { id: item.id },
      kernelScaffold,
    );
    expect(connections).toMatchObject({ id: item.id });
    expect(connections.groups).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          direction: "incoming",
          edgeKey: "InventoryEntry.productId",
          otherKind: "inventory",
          count: 1,
          disposition: null,
        }),
        // The attachment row's subject is the source; the image the target.
        expect.objectContaining({
          direction: "outgoing",
          edgeKey: "EntityAttachment.imageId",
          otherKind: "image",
          count: 1,
        }),
      ]),
    );

    const fromShelf = await getEntityConnections(
      ctx.db,
      { id: shelf.id },
      kernelScaffold,
    );
    expect(fromShelf.groups).toContainEqual(
      expect.objectContaining({
        direction: "incoming",
        edgeKey: "InventoryEntry.locationId",
        count: 1,
      }),
    );
  });

  it("attaches the operation's declared disposition for an impact preview", async () => {
    const { item } = await seedStockedProduct("Edge chair");
    const preview = await getEntityConnections(
      ctx.db,
      {
        id: item.id,
        operation: "delete",
      },
      kernelScaffold,
    );
    const stock = preview.groups.find(
      (group) => group.edgeKey === "InventoryEntry.productId",
    );
    expect(stock?.disposition).toMatchObject({ effect: expect.any(String) });
  });

  it("connects retained source versions through accepted aliases with exact counts and bounded samples", async () => {
    const observe = (
      fingerprint: string,
      providerId: string,
      version: number,
    ) =>
      recordSourceTransactionRecords(
        ctx.db,
        recordSourceTransactionRecordsInput.parse({
          import: {
            source: "synthetic-edge-source",
            label: "Synthetic connection evidence",
            fingerprint,
            dateKind: "transaction",
            rowCountDeclared: 1,
          },
          rows: [
            {
              providerTransactionId: providerId,
              accountDescriptor: "Synthetic card",
              statementDate: "2026-06-01",
              providerAmount: -12.5,
              rawDescription: "Synthetic connection charge",
              // A revision changes a fact; providerData alone is an annotation.
              providerNotes: version === 1 ? null : `Synthetic v${version}`,
              providerData: { version },
            },
          ],
        }),
        ctx.actor,
      );
    await observe("synthetic-edge-v1", "synthetic-charge", 1);
    const original = (await listSourceTransactionRecords(ctx.db, {})).data[0];
    if (!original) throw new Error("Synthetic source record was not recorded");
    await getDb(ctx.db)
      .update(sourceTransactionRecord)
      .set({ legacyReference: "synthetic-legacy-settlement" })
      .where(eq(sourceTransactionRecord.shortcode, original.id));
    const account = (
      await createRepoEntity(ctx, "financialAccount", {
        name: "Synthetic connection account",
      })
    ).output;
    const transaction = async (externalIds: string[]) =>
      (
        await createRepoEntity(ctx, "financialTransaction", {
          accountId: account.id,
          kind: "purchase",
          status: "posted",
          amount: 12.5,
          postedDate: "2026-06-01",
          sourceRefs: externalIds.map((externalId) => ({
            source: original.source,
            externalId,
          })),
        })
      ).output;
    const first = await transaction([
      original.externalId,
      "synthetic-legacy-settlement",
    ]);
    await observe("synthetic-edge-v2", "synthetic-charge", 2);
    const revised = (await listSourceTransactionRecords(ctx.db, {})).data.find(
      (row) => row.id !== original.id,
    );
    if (!revised)
      throw new Error("Synthetic revised source record was not recorded");
    const second = await transaction([revised.externalId]);
    await observe("synthetic-edge-other", "synthetic-other-charge", 1);
    const unrelated = (
      await listSourceTransactionRecords(ctx.db, {})
    ).data.find((row) => row.chargeKey !== original.chargeKey);
    if (!unrelated)
      throw new Error("Synthetic unrelated source record was not recorded");
    await transaction([unrelated.externalId]);

    const edgeKey =
      "rows:sourceTransactionRecord.acceptedTransactions.transaction";
    const outgoing = await getEntityConnections(
      ctx.db,
      {
        id: revised.id,
        operation: "delete",
        limitPerGroup: 1,
      },
      kernelScaffold,
    );
    const outgoingGroup = outgoing.groups.find(
      (group) => group.edgeKey === edgeKey,
    );
    expect(outgoingGroup).toMatchObject({
      direction: "outgoing",
      otherKind: "financialTransaction",
      role: "reference",
      disposition: null,
      count: 2,
      items: [
        { id: [first.id, second.id].sort()[0], kind: "financialTransaction" },
      ],
    });
    const fullOutgoing = await getEntityConnections(
      ctx.db,
      {
        id: original.id,
      },
      kernelScaffold,
    );
    expect(
      fullOutgoing.groups
        .find((group) => group.edgeKey === edgeKey)
        ?.items.map((item) => item.id)
        .sort(),
    ).toEqual([first.id, second.id].sort());
    const incoming = await getEntityConnections(
      ctx.db,
      {
        id: first.id,
        operation: "delete",
        limitPerGroup: 1,
      },
      kernelScaffold,
    );
    const incomingGroup = incoming.groups.find(
      (group) => group.edgeKey === edgeKey,
    );
    expect(incomingGroup).toMatchObject({
      direction: "incoming",
      otherKind: "sourceTransactionRecord",
      role: "reference",
      disposition: null,
      count: 2,
      items: [
        {
          id: [original.id, revised.id].sort()[0],
          kind: "sourceTransactionRecord",
        },
      ],
    });
    expect(
      (
        await getEntityConnections(
          ctx.db,
          { id: first.id, limitPerGroup: 1 },
          kernelScaffold,
        )
      ).groups.find((group) => group.edgeKey === edgeKey)?.items,
    ).toEqual(incomingGroup?.items);
    await getDb(ctx.db)
      .update(sourceTransactionRecord)
      .set({ deletedAt: new Date() })
      .where(eq(sourceTransactionRecord.shortcode, original.id));
    expect(
      (
        await getEntityConnections(ctx.db, { id: second.id }, kernelScaffold)
      ).groups.find((group) => group.edgeKey === edgeKey),
    ).toMatchObject({
      count: 1,
      items: [{ id: revised.id }],
    });
  });

  it("refuses a merged-away code", async () => {
    const { item } = await seedStockedProduct("Edge keeper");
    const loser = await createProductIdentityFixture(
      ctx.db,
      makeProductInput({ name: "Edge loser" }),
      TEST_ACTOR,
    );
    await mergeProducts(
      ctx.db,
      { keepId: item.id, mergeIds: [loser.id] },
      TEST_ACTOR,
    );
    await expect(
      getEntityConnections(ctx.db, { id: loser.id }, kernelScaffold),
    ).rejects.toThrow(`was merged into ${item.id}`);
  });

  it("finds live entities of a checked kind with no connection", async () => {
    const { item, shelf } = await seedStockedProduct("Edge table");
    const lonely = await createLocationFixture(
      ctx.db,
      makeLocationInput({ name: "Edge orphan shelf" }),
      TEST_ACTOR,
    );
    // A same-kind parent edge connects its target, but does not make an
    // otherwise empty child location occupied.
    const parent = await createLocationFixture(
      ctx.db,
      makeLocationInput({ name: "Edge parent shelf" }),
      TEST_ACTOR,
    );
    const child = await createLocationFixture(
      ctx.db,
      makeLocationInput({ name: "Edge empty child", parentId: parent.id }),
      TEST_ACTOR,
    );
    // An edge counts only while its other endpoint is live.
    const [kept, dropped] = await Promise.all([
      insertWithShortcode(ctx.db, "vendor", { name: "Synthetic kept vendor" }),
      insertWithShortcode(ctx.db, "vendor", {
        name: "Synthetic dropped vendor",
      }),
    ]);
    await insertWithShortcode(ctx.db, "purchase", { vendorId: kept.id });
    const removed = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: dropped.id,
    });
    await getDb(ctx.db)
      .update(purchase)
      .set({ deletedAt: new Date() })
      .where(eq(purchase.id, removed.id));
    const orphans = await findOrphanEntities(ctx.db, { limit: 200 });
    const codes = orphans.items.map((entry) => entry.id);
    expect(codes).not.toContain(kept.shortcode);
    expect(codes).toContain(dropped.shortcode);
    expect(codes).toContain(lonely.id);
    expect(codes).not.toContain(shelf.id);
    expect(codes).not.toContain(parent.id);
    expect(codes).toContain(child.id);
    // Products are left to the dedicated orphaned-products detector.
    expect(codes).not.toContain(item.id);
    expect(orphans.count).toBeGreaterThanOrEqual(1);
  });

  it("keeps an image connected only through its sighting owner", async () => {
    // The owner kind is outside the orphan check: retaining target-kind
    // arms alone would incorrectly report this image as an orphan.
    const owner = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic sighting owner",
      kind: "member",
    });
    const device = await insertWithShortcode(ctx.db, "device", {
      name: "Synthetic camera",
      installationId: crypto.randomUUID(),
      platform: "ios",
      ledgerPartyId: owner.id,
    });
    const seen = await createImageFixture(ctx.db, "sighting-only");
    const unseen = await createImageFixture(ctx.db, "unconnected-image");
    await getDb(ctx.db)
      .insert(imageSighting)
      .values({
        imageId: seen.id,
        ledgerPartyId: owner.id,
        deviceId: device.id,
        sourceType: "userLibrary",
        assetKey: "synthetic-sighting",
        matchKind: "import",
        observedAt: new Date("2026-06-01T10:00:00Z"),
      });
    const orphans = await findOrphanEntities(ctx.db, { limit: 200 });
    expect(orphans.items.map((entry) => entry.id)).not.toContain(
      seen.shortcode,
    );
    expect(orphans.items.map((entry) => entry.id)).toContain(unseen.shortcode);
  });
});
