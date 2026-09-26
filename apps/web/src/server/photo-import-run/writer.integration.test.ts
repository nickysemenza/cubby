import { parseEntityId } from "@cubby/schemas/identifiers";
import { generateShortcode } from "@cubby/shared";
import { and, eq } from "drizzle-orm";
import { TEST_HOME_SHORTCODE, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import {
  entityAttachment,
  importRun,
  importRunOperation,
  importRunTarget,
  inventoryEntry,
  product,
} from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import { createInventoryEntry } from "~/server/repo/inventory/crud";
import {
  createImageFixture,
  createLocationFixture,
  createProductFixture,
  makeLocationInput,
  makeProductInput,
} from "~/server/repo/repo.fixtures";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

import { commitPhotoGroup } from "./writer";

describe("commitPhotoGroup", () => {
  const ctx = withTestDb();

  const seedMember = () =>
    insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Wardrobe Member",
      kind: "member" as const,
      userId: ctx.actor.userId,
    });

  const seedRun = async (
    party: Awaited<ReturnType<typeof seedMember>>,
    overrides: Partial<typeof importRun.$inferInsert> = {},
  ) => {
    const id = parseEntityId("importRun", crypto.randomUUID());
    const [run] = await getDb(ctx.db)
      .insert(importRun)
      .values({
        id,
        shortcode: generateShortcode("importRun"),
        ledgerPartyId: party.id,
        actorUserId: ctx.actor.userId,
        actorName: "Wardrobe Tester",
        actorEmail: "test@example.com",
        actorLedgerPartyShortcode: party.shortcode,
        actorLedgerPartyName: party.name,
        actorLedgerPartyKind: "member",
        agentSessionId: `photo-import-run-test:${id}`,
        purpose: "photo_inventory",
        trigger: "manual",
        status: "running",
        ...overrides,
      })
      .returning();
    if (!run) throw new Error("fixture: run not created");
    return run;
  };

  const seedImages = async (count: number) =>
    Promise.all(
      Array.from({ length: count }, (_, index) =>
        createImageFixture(ctx.db, `wardrobe-${crypto.randomUUID()}-${index}`),
      ),
    );

  const seedTargets = async (
    runId: string,
    images: Awaited<ReturnType<typeof seedImages>>,
  ) => {
    await getDb(ctx.db)
      .insert(importRunTarget)
      .values(
        images.map((image, index) => ({
          runId,
          imageId: parseEntityId("image", image.id),
          position: index,
          state: "pending" as const,
          targetFingerprint: `fixture-fingerprint-${crypto.randomUUID()}`,
        })),
      );
  };

  const readTargetStates = async (runId: string) =>
    getDb(ctx.db)
      .select({
        imageId: importRunTarget.imageId,
        state: importRunTarget.state,
        outcome: importRunTarget.outcome,
      })
      .from(importRunTarget)
      .where(eq(importRunTarget.runId, runId));

  it("creates a Product, attaches item+label images, and records a person-owned inventory entry", async () => {
    const party = await seedMember();
    const run = await seedRun(party);
    const images = await seedImages(2);
    await seedTargets(run.id, images);
    const closet = await createLocationFixture(
      ctx.db,
      makeLocationInput({ name: "Closet", parentId: TEST_HOME_SHORTCODE }),
      ctx.actor,
    );

    const result = await commitPhotoGroup(
      ctx.db,
      {
        runId: run.shortcode,
        groupKey: "group-1",
        images: [
          { id: images[0]!.shortcode, purpose: "item" },
          { id: images[1]!.shortcode, purpose: "label" },
        ],
        product: {
          kind: "create",
          create: { name: "Blue Denim Jacket" },
        },
        inventory: {
          locationId: closet.id,
          quantity: 1,
        },
      },
      ctx.actor,
    );

    expect(result.outcome).toBe("committed");
    expect(result.runStatus).toBe("completed");
    expect(result.images).toEqual([
      { id: images[0]!.shortcode, state: "completed" },
      { id: images[1]!.shortcode, state: "completed" },
    ]);
    expect(result.productId).toBeDefined();
    expect(result.inventoryId).toBeDefined();

    const attachments = await getDb(ctx.db)
      .select({
        imageId: entityAttachment.imageId,
        purpose: entityAttachment.purpose,
      })
      .from(entityAttachment)
      .where(eq(entityAttachment.imageId, images[0]!.id));
    expect(attachments).toHaveLength(1);
    expect(attachments[0]?.purpose).toBe("item");

    const [labelAttachment] = await getDb(ctx.db)
      .select({ purpose: entityAttachment.purpose })
      .from(entityAttachment)
      .where(eq(entityAttachment.imageId, images[1]!.id));
    expect(labelAttachment?.purpose).toBe("label");

    const [entry] = await getDb(ctx.db)
      .select({
        ownershipMode: inventoryEntry.ownershipMode,
        ownerLedgerPartyId: inventoryEntry.ownerLedgerPartyId,
      })
      .from(inventoryEntry)
      .where(eq(inventoryEntry.locationId, closet.entityId));
    expect(entry?.ownershipMode).toBe("person");
    expect(entry?.ownerLedgerPartyId).toBe(party.id);

    const targets = await readTargetStates(run.id);
    expect(targets.every((target) => target.state === "completed")).toBe(true);
    expect(targets.every((target) => target.outcome === "attached")).toBe(true);

    const [updatedRun] = await getDb(ctx.db)
      .select({ status: importRun.status, imported: importRun.imported })
      .from(importRun)
      .where(eq(importRun.id, run.id));
    expect(updatedRun?.status).toBe("completed");
    expect(updatedRun?.imported).toBe(1);
  });

  // A Product already stocked at the chosen location must not silently gain a
  // second entry: approval is refused unless the reviewer chose to add the
  // photographed quantity to the existing entry.
  it("refuses a second entry where the Product is already stocked, and adds to it when asked", async () => {
    const party = await seedMember();
    const run = await seedRun(party);
    const images = await seedImages(2);
    await seedTargets(run.id, images);
    const closet = await createLocationFixture(
      ctx.db,
      makeLocationInput({ name: "Hall Closet", parentId: TEST_HOME_SHORTCODE }),
      ctx.actor,
    );
    const boots = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Stocked Work Boots" }),
      ctx.actor,
    );
    const stocked = await createInventoryEntry(
      ctx.db,
      {
        productId: boots.entityId,
        locationId: closet.entityId,
        amount: { value: 1, unit: "each" },
        ownershipMode: "person",
        ownerLedgerPartyId: party.id,
      },
      ctx.actor,
    );
    const group = (groupKey: string, addToExisting = false) => ({
      runId: run.shortcode,
      groupKey,
      images: [{ id: images[0]!.shortcode, purpose: "item" as const }],
      skip: [],
      product: { kind: "existing" as const, existingId: boots.id },
      inventory: {
        locationId: closet.id,
        quantity: 2,
        addToExisting,
      },
    });

    await expect(
      commitPhotoGroup(ctx.db, group("boots"), ctx.actor),
    ).rejects.toThrow(/already has 1 each at Hall Closet/);

    const added = await commitPhotoGroup(
      ctx.db,
      group("boots-added", true),
      ctx.actor,
    );
    expect(added.outcome).toBe("committed");
    expect(added.inventoryId).toBe(stocked.id);
    const entries = await getDb(ctx.db)
      .select({ amount: inventoryEntry.amount })
      .from(inventoryEntry)
      .where(
        and(
          eq(inventoryEntry.productId, boots.entityId),
          eq(inventoryEntry.locationId, closet.entityId),
        ),
      );
    expect(entries).toEqual([{ amount: { value: 3, unit: "each" } }]);
  });

  it("attaches to an existing Product by id", async () => {
    const party = await seedMember();
    const run = await seedRun(party);
    const images = await seedImages(1);
    await seedTargets(run.id, images);
    const existing = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Existing Hiking Boots" }),
      ctx.actor,
    );

    const result = await commitPhotoGroup(
      ctx.db,
      {
        runId: run.shortcode,
        groupKey: "group-existing",
        images: [{ id: images[0]!.shortcode, purpose: "item" }],
        product: { kind: "existing", existingId: existing.id },
      },
      ctx.actor,
    );

    expect(result.outcome).toBe("committed");
    expect(result.productId).toBe(existing.id);
    expect(result.inventoryId).toBeUndefined();
  });

  it("replays an identical group after the operation ledger row is lost, with no duplicate writes", async () => {
    const party = await seedMember();
    const run = await seedRun(party);
    const images = await seedImages(1);
    await seedTargets(run.id, images);
    const commitArgs = {
      runId: run.shortcode,
      groupKey: "group-replay",
      images: [{ id: images[0]!.shortcode, purpose: "item" as const }],
      product: { kind: "create" as const, create: { name: "Replay Sweater" } },
    };

    const first = await commitPhotoGroup(ctx.db, commitArgs, ctx.actor);
    expect(first.outcome).toBe("committed");

    // Simulate the crash window documented in `runImportOperation`: the
    // writer's own transaction committed, but the operation ledger row never
    // reached `completed`. Deleting it forces the next call to re-enter
    // `doCommit`, which must recognize the already-attached image and refuse
    // to create a second Product or a duplicate attachment.
    await getDb(ctx.db)
      .delete(importRunOperation)
      .where(
        and(
          eq(importRunOperation.runId, run.id),
          eq(importRunOperation.operationId, "photo-group:group-replay"),
        ),
      );

    const replay = await commitPhotoGroup(ctx.db, commitArgs, ctx.actor);
    expect(replay.outcome).toBe("replayed");
    expect(replay.productId).toBe(first.productId);

    const products = await getDb(ctx.db)
      .select({ id: product.id })
      .from(product)
      .where(eq(product.name, "Replay Sweater"));
    expect(products).toHaveLength(1);

    const attachments = await getDb(ctx.db)
      .select({ id: entityAttachment.id })
      .from(entityAttachment)
      .where(eq(entityAttachment.imageId, images[0]!.id));
    expect(attachments).toHaveLength(1);
  });

  it.each([
    {
      ledger: "completed",
      error: /replayed with different input/,
    },
    {
      // Regression: a `failed` ledger row may take over with a changed
      // payload, but the writer transaction can commit and only the ledger's
      // completion write fail — fresh work under that key duplicated it.
      ledger: "failed",
      error: /already committed to run .* with a different image roster/,
    },
  ] as const)(
    "refuses a changed payload under a groupKey that already committed (ledger $ledger)",
    async ({ ledger, error }) => {
      const party = await seedMember();
      const run = await seedRun(party);
      const images = await seedImages(2);
      await seedTargets(run.id, images);

      await commitPhotoGroup(
        ctx.db,
        {
          runId: run.shortcode,
          groupKey: "group-drift",
          images: [{ id: images[0]!.shortcode, purpose: "item" }],
          product: { kind: "create", create: { name: "Drift Cardigan" } },
        },
        ctx.actor,
      );
      if (ledger === "failed")
        await getDb(ctx.db)
          .update(importRunOperation)
          .set({ state: "failed" })
          .where(
            and(
              eq(importRunOperation.runId, run.id),
              eq(importRunOperation.operationId, "photo-group:group-drift"),
            ),
          );

      await expect(
        commitPhotoGroup(
          ctx.db,
          {
            runId: run.shortcode,
            groupKey: "group-drift",
            images: [{ id: images[1]!.shortcode, purpose: "item" }],
            product: { kind: "create", create: { name: "Drift Cardigan" } },
          },
          ctx.actor,
        ),
      ).rejects.toThrow(error);
      const pending = (await readTargetStates(run.id)).filter(
        (target) => target.state === "pending",
      );
      expect(pending).toHaveLength(1);
    },
  );

  it("reports a name collision as data, with zero writes and no operation row", async () => {
    const party = await seedMember();
    const run = await seedRun(party);
    const images = await seedImages(1);
    await seedTargets(run.id, images);
    const existing = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Green Rain Boots" }),
      ctx.actor,
    );

    const result = await commitPhotoGroup(
      ctx.db,
      {
        runId: run.shortcode,
        groupKey: "group-collision",
        images: [{ id: images[0]!.shortcode, purpose: "item" }],
        product: { kind: "create", create: { name: "green rain boots" } },
      },
      ctx.actor,
    );

    expect(result.outcome).toBe("conflict");
    expect(result.conflict?.existingProductIds).toEqual([existing.id]);

    const targets = await readTargetStates(run.id);
    expect(targets.every((target) => target.state === "pending")).toBe(true);

    const operations = await getDb(ctx.db)
      .select({ id: importRunOperation.id })
      .from(importRunOperation)
      .where(eq(importRunOperation.runId, run.id));
    expect(operations).toHaveLength(0);
  });

  it("commits a skip-only group and records the reason without attaching anything", async () => {
    const party = await seedMember();
    const run = await seedRun(party);
    const images = await seedImages(1);
    await seedTargets(run.id, images);
    const existing = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Unidentifiable Item" }),
      ctx.actor,
    );

    const result = await commitPhotoGroup(
      ctx.db,
      {
        runId: run.shortcode,
        groupKey: "group-skip",
        images: [],
        skip: [{ id: images[0]!.shortcode, reason: "Too blurry to identify" }],
        product: { kind: "existing", existingId: existing.id },
      },
      ctx.actor,
    );

    expect(result.outcome).toBe("committed");
    expect(result.images).toEqual([
      { id: images[0]!.shortcode, state: "skipped" },
    ]);

    const [target] = await readTargetStates(run.id);
    expect(target?.state).toBe("skipped");

    const [updatedRun] = await getDb(ctx.db)
      .select({ skipped: importRun.skipped, imported: importRun.imported })
      .from(importRun)
      .where(eq(importRun.id, run.id));
    expect(updatedRun?.skipped).toBe(1);
    expect(updatedRun?.imported).toBe(0);
  });

  it("flips the run to completed once its last group commits", async () => {
    const party = await seedMember();
    const run = await seedRun(party);
    const images = await seedImages(2);
    await seedTargets(run.id, images);
    const existing = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Two-Group Sneakers" }),
      ctx.actor,
    );

    const first = await commitPhotoGroup(
      ctx.db,
      {
        runId: run.shortcode,
        groupKey: "group-a",
        images: [{ id: images[0]!.shortcode, purpose: "item" }],
        product: { kind: "existing", existingId: existing.id },
      },
      ctx.actor,
    );
    expect(first.runStatus).toBe("running");

    const second = await commitPhotoGroup(
      ctx.db,
      {
        runId: run.shortcode,
        groupKey: "group-b",
        images: [{ id: images[1]!.shortcode, purpose: "label" }],
        product: { kind: "existing", existingId: existing.id },
      },
      ctx.actor,
    );
    expect(second.runStatus).toBe("completed");

    const [updatedRun] = await getDb(ctx.db)
      .select({ status: importRun.status, endedAt: importRun.endedAt })
      .from(importRun)
      .where(eq(importRun.id, run.id));
    expect(updatedRun?.status).toBe("completed");
    expect(updatedRun?.endedAt).not.toBeNull();
  });

  it("refuses 'person' ownership with no owner instead of guessing one", async () => {
    const party = await seedMember();
    const run = await seedRun(party);
    const images = await seedImages(1);
    await seedTargets(run.id, images);

    await expect(
      commitPhotoGroup(
        ctx.db,
        {
          runId: run.shortcode,
          groupKey: "group-no-owner",
          images: [{ id: images[0]!.shortcode, purpose: "item" }],
          product: { kind: "create", create: { name: "Ownerless Scarf" } },
          inventory: {
            locationId: TEST_HOME_SHORTCODE,
            ownershipMode: "person",
            quantity: 1,
          },
        },
        ctx.actor,
      ),
    ).rejects.toThrow(/explicit ownerPartyId/);

    const targets = await readTargetStates(run.id);
    expect(targets.every((target) => target.state === "pending")).toBe(true);
  });
});
