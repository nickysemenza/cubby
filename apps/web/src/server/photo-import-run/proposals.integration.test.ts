import { parseEntityId, parseShortcodeFor } from "@cubby/schemas/identifiers";
import type { PhotoGroupProposalGroup } from "@cubby/schemas/photo-import-run";
import { generateShortcode } from "@cubby/shared";
import { and, eq, ilike, sql } from "drizzle-orm";
import { TEST_HOME_SHORTCODE, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import {
  image,
  imageProcessingJob,
  importRun,
  importRunTarget,
  inventoryEntry,
  photoGroupProposal,
  product,
} from "~/server/db/schema";
import { getDb, notDeleted } from "~/server/repo/database-helpers";
import { deleteImages } from "~/server/repo/image";
import { mergeLedgerParties } from "~/server/repo/ledger-party";
import { deleteProductCategories } from "~/server/repo/product-category";
import { mergeProducts } from "~/server/repo/product/merge";
import {
  createImageFixture,
  createLocationFixture,
  createProductFixture,
  makeLocationInput,
  makeProductInput,
} from "~/server/repo/repo.fixtures";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

import {
  approvePhotoGroupProposals,
  chooseExistingProductForPhotoGroup,
  updatePhotoGroupProductDraft,
  discardPhotoGroupProposal,
  listPhotoGroupProposals,
  proposePhotoGroups,
} from "./proposals";
import { commitPhotoGroup } from "./writer";

describe("photo group proposals", () => {
  const ctx = withTestDb();

  /** A running photo-inventory run with `count` pending image targets. */
  const seedRun = async (count: number) => {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Proposal Member",
      kind: "member" as const,
      userId: ctx.actor.userId,
    });
    const id = parseEntityId("importRun", crypto.randomUUID());
    const [run] = await getDb(ctx.db)
      .insert(importRun)
      .values({
        id,
        shortcode: generateShortcode("importRun"),
        ledgerPartyId: party.id,
        actorUserId: ctx.actor.userId,
        actorName: "Proposal Tester",
        actorEmail: "test@example.com",
        actorLedgerPartyShortcode: party.shortcode,
        actorLedgerPartyName: party.name,
        actorLedgerPartyKind: "member",
        agentSessionId: `photo-proposal-test:${id}`,
        purpose: "photo_inventory",
        trigger: "manual",
        status: "running",
      })
      .returning();
    if (!run) throw new Error("fixture: run not created");
    const images = await Promise.all(
      Array.from({ length: count }, (_, index) =>
        createImageFixture(ctx.db, `proposal-${crypto.randomUUID()}-${index}`),
      ),
    );
    await getDb(ctx.db)
      .insert(importRunTarget)
      .values(
        images.map((image, index) => ({
          runId: run.id,
          imageId: parseEntityId("image", image.id),
          position: index,
          state: "pending" as const,
          targetFingerprint: `fixture-${crypto.randomUUID()}`,
        })),
      );
    return { run, codes: images.map((image) => image.shortcode) };
  };

  const createGroup = (
    groupKey: string,
    imageCodes: string[],
    name = `Synthetic Item ${groupKey}`,
  ): PhotoGroupProposalGroup => ({
    groupKey,
    images: imageCodes.map((id, index) => ({
      id: parseShortcodeFor("image", id),
      purpose: index === 0 ? "item" : "label",
    })),
    product: { kind: "create", create: { name } },
  });

  const readRow = async (runId: string, groupKey: string) => {
    const [row] = await getDb(ctx.db)
      .select()
      .from(photoGroupProposal)
      .where(
        and(
          eq(photoGroupProposal.runId, parseEntityId("importRun", runId)),
          eq(photoGroupProposal.groupKey, groupKey),
        ),
      );
    return row;
  };

  it("keeps photo roles and evidence when a reviewer selects an existing product", async () => {
    const { run, codes } = await seedRun(2);
    const existing = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic Canvas Shirt" }),
      ctx.actor,
    );
    await proposePhotoGroups(ctx.db, {
      runId: run.shortcode,
      groups: [
        {
          ...createGroup("shirt", [codes[0]!]),
          skip: [
            {
              id: parseShortcodeFor("image", codes[1]!),
              reason: "Duplicate angle",
            },
          ],
          evidence: "One shirt with a duplicate photo",
        },
      ],
    });

    const chosen = await chooseExistingProductForPhotoGroup(ctx.db, {
      runId: run.shortcode,
      groupKey: "shirt",
      productId: existing.id,
    });
    const group = chosen.proposals.find((item) => item.groupKey === "shirt");
    expect(group?.product.kind).toBe("existing");
    expect(group?.images).toEqual([{ id: codes[0], purpose: "item" }]);
    expect(group?.skip).toEqual([{ id: codes[1], reason: "Duplicate angle" }]);
    expect(group?.evidence).toBe("One shirt with a duplicate photo");

    const approved = await approvePhotoGroupProposals(
      ctx.db,
      { runId: run.shortcode, groupKeys: ["shirt"] },
      ctx.actor,
    );
    expect(approved.results).toEqual([
      { groupKey: "shirt", outcome: "committed" },
    ]);
    expect(
      approved.proposals.find((item) => item.groupKey === "shirt")
        ?.committedProduct?.id,
    ).toBe(existing.id);
  });

  it("edits the proposed product without changing the reviewed photos", async () => {
    const { run, codes } = await seedRun(2);
    await proposePhotoGroups(ctx.db, {
      runId: run.shortcode,
      groups: [
        {
          ...createGroup("shirt", [codes[0]!]),
          skip: [
            {
              id: parseShortcodeFor("image", codes[1]!),
              reason: "Out of focus",
            },
          ],
          evidence: "One garment, second photo is unusable",
        },
      ],
    });

    const changed = await updatePhotoGroupProductDraft(ctx.db, {
      runId: run.shortcode,
      groupKey: "shirt",
      name: "Synthetic Canvas Shirt, Medium",
      categoryId: null,
      manufacturer: "ForgeWear",
      model: null,
      notes: "Size confirmed from tag",
    });
    const group = changed.proposals.find((item) => item.groupKey === "shirt");
    expect(group?.product).toMatchObject({
      kind: "create",
      create: {
        name: "Synthetic Canvas Shirt, Medium",
        manufacturer: "ForgeWear",
        notes: "Size confirmed from tag",
      },
    });
    expect(group?.images).toEqual([{ id: codes[0], purpose: "item" }]);
    expect(group?.skip).toEqual([{ id: codes[1], reason: "Out of focus" }]);
    expect(group?.evidence).toBe("One garment, second photo is unusable");
  });

  describe("propose validation", () => {
    it.each([
      {
        name: "an image in two groups of one call",
        groups: (codes: string[]) => [
          createGroup("a", [codes[0]!]),
          createGroup("b", [codes[0]!, codes[1]!]),
        ],
        error: /appears in both group a and group b/,
      },
      {
        name: "an image outside the run",
        groups: (_codes: string[], foreign: string) => [
          createGroup("a", [foreign]),
        ],
        error: /is not part of photo-inventory run/,
      },
      {
        name: "an image already committed",
        committed: true,
        groups: (codes: string[]) => [createGroup("a", [codes[0]!])],
        error: /already completed/,
      },
      {
        // Discard commits images + skip as one skip list capped at 50.
        name: "more than 50 photos across images and skip",
        groups: () => [
          {
            ...createGroup(
              "a",
              Array.from({ length: 30 }, () => generateShortcode("image")),
            ),
            skip: Array.from({ length: 21 }, () => ({
              id: parseShortcodeFor("image", generateShortcode("image")),
              reason: "Blurry",
            })),
          },
        ],
        error: /holds 51 photos; a proposed group holds at most 50/,
      },
    ])("refuses $name", async ({ groups, error, committed }) => {
      const { run, codes } = await seedRun(2);
      const foreign = await createImageFixture(ctx.db, "proposal-foreign");
      if (committed) {
        await commitPhotoGroup(
          ctx.db,
          {
            runId: run.shortcode,
            groupKey: "direct",
            images: [
              { id: parseShortcodeFor("image", codes[0]!), purpose: "item" },
            ],
            product: { kind: "create", create: { name: "Direct Commit Item" } },
          },
          ctx.actor,
        );
      }
      await expect(
        proposePhotoGroups(ctx.db, {
          runId: run.shortcode,
          groups: groups(codes, foreign.shortcode),
        }),
      ).rejects.toThrow(error);
      expect(await readRow(run.id, "a")).toBeUndefined();
    });

    it("refuses an image already held by another live proposed group", async () => {
      const { run, codes } = await seedRun(2);
      await proposePhotoGroups(ctx.db, {
        runId: run.shortcode,
        groups: [createGroup("a", [codes[0]!])],
      });
      await expect(
        proposePhotoGroups(ctx.db, {
          runId: run.shortcode,
          groups: [createGroup("b", [codes[0]!, codes[1]!])],
        }),
      ).rejects.toThrow(/appears in both group a and group b/);
    });

    it("replaces a proposed group by groupKey but leaves a committed one untouched", async () => {
      const { run, codes } = await seedRun(3);
      await proposePhotoGroups(ctx.db, {
        runId: run.shortcode,
        groups: [
          createGroup("a", [codes[0]!], "Synthetic Jacket"),
          createGroup("b", [codes[1]!], "Synthetic Scarf"),
        ],
      });
      await approvePhotoGroupProposals(
        ctx.db,
        { runId: run.shortcode, groupKeys: ["a"] },
        ctx.actor,
      );
      const committedBefore = await readRow(run.id, "a");

      const result = await proposePhotoGroups(ctx.db, {
        runId: run.shortcode,
        groups: [
          createGroup("a", [codes[2]!], "Rewritten Jacket"),
          createGroup("b", [codes[1]!, codes[2]!], "Synthetic Wool Scarf"),
        ],
      });

      expect(result.frozenGroupKeys).toEqual(["a"]);
      expect(await readRow(run.id, "a")).toEqual(committedBefore);
      const replaced = await readRow(run.id, "b");
      expect(replaced?.productCreate).toMatchObject({
        name: "Synthetic Wool Scarf",
      });
      expect(replaced?.images).toHaveLength(2);
      expect(result.unassignedImageIds).toEqual([]);
    });
  });

  it("approves idempotently: approving twice writes one Product and one Inventory entry", async () => {
    const { run, codes } = await seedRun(2);
    const closet = await createLocationFixture(
      ctx.db,
      makeLocationInput({
        name: "Proposal Closet",
        parentId: TEST_HOME_SHORTCODE,
      }),
      ctx.actor,
    );
    await proposePhotoGroups(ctx.db, {
      runId: run.shortcode,
      groups: [
        {
          ...createGroup("coat", codes, "Synthetic Rain Coat"),
          inventory: {
            locationId: parseShortcodeFor("location", closet.id),
            quantity: 1,
          },
        },
      ],
    });

    const first = await approvePhotoGroupProposals(
      ctx.db,
      { runId: run.shortcode },
      ctx.actor,
    );
    const second = await approvePhotoGroupProposals(
      ctx.db,
      { runId: run.shortcode, groupKeys: ["coat"] },
      ctx.actor,
    );

    expect(first.results).toEqual([{ groupKey: "coat", outcome: "committed" }]);
    expect(second.results).toEqual([{ groupKey: "coat", outcome: "replayed" }]);
    expect(first.runStatus).toBe("completed");
    const products = await getDb(ctx.db)
      .select({ id: product.id })
      .from(product)
      .where(
        and(ilike(product.name, "Synthetic Rain Coat"), notDeleted(product)),
      );
    expect(products).toHaveLength(1);
    const entries = await getDb(ctx.db)
      .select({ id: inventoryEntry.id })
      .from(inventoryEntry)
      .where(eq(inventoryEntry.productId, products[0]!.id));
    expect(entries).toHaveLength(1);
    const [view] = second.proposals;
    expect(view?.state).toBe("committed");
    expect(view?.committedProduct?.name).toBe("Synthetic Rain Coat");
  });

  it("waits for current cloud descriptions but lets device cutout work continue", async () => {
    const { run, codes } = await seedRun(1);
    const [source] = await getDb(ctx.db)
      .select({ id: image.id, sha256: image.sha256 })
      .from(image)
      .where(eq(image.shortcode, codes[0]!));
    if (!source) throw new Error("fixture: image not found");
    const sourceHash = "a".repeat(64);
    await getDb(ctx.db)
      .update(image)
      .set({ sha256: sourceHash })
      .where(eq(image.id, source.id));
    const [description] = await getDb(ctx.db)
      .insert(imageProcessingJob)
      .values({
        imageId: parseEntityId("image", source.id),
        kind: "describe_image",
        state: "pending",
        sourceContentHash: sourceHash,
        processorRevision: 1,
      })
      .returning();
    await getDb(ctx.db)
      .insert(imageProcessingJob)
      .values({
        imageId: parseEntityId("image", source.id),
        kind: "subject_lift",
        state: "waiting_for_device",
        sourceContentHash: sourceHash,
        processorRevision: 1,
      });
    await proposePhotoGroups(ctx.db, {
      runId: run.shortcode,
      groups: [createGroup("sweater", codes)],
    });

    const blocked = await approvePhotoGroupProposals(
      ctx.db,
      { runId: run.shortcode },
      ctx.actor,
    );
    expect(blocked.results[0]).toMatchObject({
      outcome: "failed",
      error: expect.stringContaining("AI description is still processing"),
    });
    await getDb(ctx.db)
      .update(imageProcessingJob)
      .set({ state: "ready", completedAt: new Date() })
      .where(eq(imageProcessingJob.id, description!.id));

    const approved = await approvePhotoGroupProposals(
      ctx.db,
      { runId: run.shortcode },
      ctx.actor,
    );
    expect(approved.results).toEqual([
      { groupKey: "sweater", outcome: "committed" },
    ]);
  });

  it("keeps a name-collision conflict proposed, then commits once the reviewer picks the existing Product", async () => {
    const { run, codes } = await seedRun(1);
    const existing = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic Linen Shirt" }),
      ctx.actor,
    );
    await proposePhotoGroups(ctx.db, {
      runId: run.shortcode,
      groups: [createGroup("shirt", codes, "synthetic linen shirt")],
    });

    const conflicted = await approvePhotoGroupProposals(
      ctx.db,
      { runId: run.shortcode },
      ctx.actor,
    );
    expect(conflicted.results).toEqual([
      { groupKey: "shirt", outcome: "conflict" },
    ]);
    const [view] = conflicted.proposals;
    expect(view?.state).toBe("proposed");
    expect(view?.conflict?.map((entry) => entry.id)).toEqual([existing.id]);

    await proposePhotoGroups(ctx.db, {
      runId: run.shortcode,
      groups: [
        {
          ...createGroup("shirt", codes),
          product: {
            kind: "existing",
            existingId: parseShortcodeFor("product", existing.id),
          },
        },
      ],
    });
    const approved = await approvePhotoGroupProposals(
      ctx.db,
      { runId: run.shortcode },
      ctx.actor,
    );
    expect(approved.results).toEqual([
      { groupKey: "shirt", outcome: "committed" },
    ]);
    expect(approved.proposals[0]?.committedProduct?.id).toBe(existing.id);
  });

  // Regression: the writer's operation ledger used to refuse any changed
  // payload under a groupKey whose earlier attempt failed, so an edited
  // proposal could never be approved after one failed approval.
  it("approves an edited proposal after an earlier approval failed", async () => {
    const { run, codes } = await seedRun(1);
    const closet = await createLocationFixture(
      ctx.db,
      makeLocationInput({
        name: "Retry Closet",
        parentId: TEST_HOME_SHORTCODE,
      }),
      ctx.actor,
    );
    await proposePhotoGroups(ctx.db, {
      runId: run.shortcode,
      groups: [
        {
          ...createGroup("boots", codes, "Synthetic Hiking Boots"),
          // Person ownership with no owner is refused by the writer.
          inventory: {
            locationId: parseShortcodeFor("location", closet.id),
            ownershipMode: "person",
            quantity: 1,
          },
        },
      ],
    });
    const failed = await approvePhotoGroupProposals(
      ctx.db,
      { runId: run.shortcode },
      ctx.actor,
    );
    expect(failed.results[0]?.outcome).toBe("failed");
    expect(failed.proposals[0]?.lastError).toMatch(/ownerPartyId/);

    await proposePhotoGroups(ctx.db, {
      runId: run.shortcode,
      groups: [createGroup("boots", codes, "Synthetic Hiking Boots")],
    });
    const approved = await approvePhotoGroupProposals(
      ctx.db,
      { runId: run.shortcode },
      ctx.actor,
    );
    expect(approved.results).toEqual([
      { groupKey: "boots", outcome: "committed" },
    ]);
  });

  it("discards a group by skipping its images, creating no Product, and lets the run complete", async () => {
    const { run, codes } = await seedRun(2);
    await proposePhotoGroups(ctx.db, {
      runId: run.shortcode,
      groups: [
        createGroup("keep", [codes[0]!], "Synthetic Keeper"),
        createGroup("junk", [codes[1]!], "Synthetic Blur"),
      ],
    });
    await approvePhotoGroupProposals(
      ctx.db,
      { runId: run.shortcode, groupKeys: ["keep"] },
      ctx.actor,
    );

    const result = await discardPhotoGroupProposal(
      ctx.db,
      { runId: run.shortcode, groupKey: "junk" },
      ctx.actor,
    );

    expect(result.runStatus).toBe("completed");
    expect(
      result.proposals.find((entry) => entry.groupKey === "junk")?.state,
    ).toBe("discarded");
    const targets = await getDb(ctx.db)
      .select({ state: importRunTarget.state })
      .from(importRunTarget)
      .where(
        eq(
          importRunTarget.imageId,
          parseEntityId(
            "image",
            (await readRow(run.id, "junk"))!.images[0]!.imageId,
          ),
        ),
      );
    expect(targets).toEqual([{ state: "skipped" }]);
    const minted = await getDb(ctx.db)
      .select({ id: product.id })
      .from(product)
      .where(ilike(product.name, "junk"));
    expect(minted).toEqual([]);
  });

  it("follows a Product merge: the proposal's product FK repoints onto the survivor", async () => {
    const { run, codes } = await seedRun(1);
    const loser = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic Tote Duplicate" }),
      ctx.actor,
    );
    const keeper = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic Tote" }),
      ctx.actor,
    );
    await proposePhotoGroups(ctx.db, {
      runId: run.shortcode,
      groups: [
        {
          ...createGroup("tote", codes),
          product: {
            kind: "existing",
            existingId: parseShortcodeFor("product", loser.id),
          },
        },
      ],
    });

    await mergeProducts(
      ctx.db,
      { keepId: keeper.id, mergeIds: [loser.id] },
      ctx.actor,
    );

    expect((await readRow(run.id, "tote"))?.productId).toBe(keeper.entityId);
    const list = await listPhotoGroupProposals(ctx.db, run.shortcode);
    const [view] = list.proposals;
    expect(view?.product).toMatchObject({
      kind: "existing",
      existing: { id: keeper.id },
    });
  });

  // Regression: the category and owner were shortcodes in the proposal's
  // JSON, so a merge or delete between proposing and approving broke the
  // approval. They are FK columns now, followed like the product FK.
  it("follows a member merge and a category delete on a proposed new Product", async () => {
    const { run, codes } = await seedRun(1);
    const loserMember = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic Owner Duplicate",
      kind: "member" as const,
    });
    const keeperMember = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic Owner",
      kind: "member" as const,
    });
    const category = await insertWithShortcode(ctx.db, "productCategory", {
      name: "Synthetic Proposal Category",
      sortOrder: 0,
    });
    await proposePhotoGroups(ctx.db, {
      runId: run.shortcode,
      groups: [
        {
          ...createGroup("owned", codes),
          product: {
            kind: "create",
            create: {
              name: "Synthetic Owned Lamp",
              categoryId: parseShortcodeFor(
                "productCategory",
                category.shortcode,
              ),
            },
          },
          inventory: {
            locationId: parseShortcodeFor("location", TEST_HOME_SHORTCODE),
            ownershipMode: "person",
            ownerPartyId: parseShortcodeFor(
              "ledgerParty",
              loserMember.shortcode,
            ),
            quantity: 1,
          },
        },
      ],
    });

    await mergeLedgerParties(
      ctx.db,
      {
        keepId: parseShortcodeFor("ledgerParty", keeperMember.shortcode),
        mergeIds: [parseShortcodeFor("ledgerParty", loserMember.shortcode)],
      },
      ctx.actor,
    );
    await deleteProductCategories(
      ctx.db,
      [parseShortcodeFor("productCategory", category.shortcode)],
      ctx.actor,
    );

    const [view] = (await listPhotoGroupProposals(ctx.db, run.shortcode))
      .proposals;
    expect(view?.inventory?.ownerPartyId).toBe(keeperMember.shortcode);
    expect(view?.product).toMatchObject({
      kind: "create",
      create: { name: "Synthetic Owned Lamp", categoryId: null },
    });
  });

  it("drops a deleted run photo from its proposed group", async () => {
    const { run, codes } = await seedRun(2);
    await proposePhotoGroups(ctx.db, {
      runId: run.shortcode,
      groups: [createGroup("pair", codes)],
    });
    const [, second] = (await readRow(run.id, "pair"))!.images;
    await deleteImages(ctx.db, [parseEntityId("image", second!.imageId)]);

    expect((await readRow(run.id, "pair"))?.images).toHaveLength(1);
  });

  it("removes a proposed group after its run stopped", async () => {
    const { run, codes } = await seedRun(1);
    await proposePhotoGroups(ctx.db, {
      runId: run.shortcode,
      groups: [createGroup("late", codes)],
    });
    await getDb(ctx.db)
      .update(importRun)
      .set({ status: "failed" })
      .where(eq(importRun.id, run.id));

    await proposePhotoGroups(ctx.db, {
      runId: run.shortcode,
      groups: [],
      removeGroupKeys: ["late"],
    });
    expect(await readRow(run.id, "late")).toBeUndefined();
  });

  // Regression: deleting a run photo hard-deletes its ImportRunTarget but not
  // the id in the proposal's JSON, and every reader threw "left its run" —
  // breaking the review page, approve-all, and discard.
  it("tolerates a proposal photo deleted after proposing: lists, approves and discards without it", async () => {
    const { run, codes } = await seedRun(4);
    await proposePhotoGroups(ctx.db, {
      runId: run.shortcode,
      groups: [
        createGroup("kept", [codes[0]!, codes[1]!], "Synthetic Lamp"),
        createGroup("gone", [codes[2]!], "Synthetic Vase"),
        createGroup("rest", [codes[3]!], "Synthetic Rug"),
      ],
    });
    const deletedIds = [
      (await readRow(run.id, "kept"))!.images[1]!.imageId,
      (await readRow(run.id, "gone"))!.images[0]!.imageId,
    ];
    for (const deleted of deletedIds)
      await getDb(ctx.db)
        .delete(importRunTarget)
        .where(eq(importRunTarget.imageId, parseEntityId("image", deleted)));

    const listed = await listPhotoGroupProposals(ctx.db, run.shortcode);
    const kept = listed.proposals.find((entry) => entry.groupKey === "kept");
    expect(kept?.images.map((entry) => entry.id)).toEqual([codes[0]]);
    expect(kept?.missingImageCount).toBe(1);

    const approved = await approvePhotoGroupProposals(
      ctx.db,
      { runId: run.shortcode, groupKeys: ["kept", "gone"] },
      ctx.actor,
    );
    expect(approved.results).toEqual([
      { groupKey: "kept", outcome: "committed" },
      {
        groupKey: "gone",
        outcome: "failed",
        error: expect.stringMatching(/Every photo in group gone was deleted/),
      },
    ]);
    expect((await readRow(run.id, "kept"))?.images).toHaveLength(1);

    await discardPhotoGroupProposal(
      ctx.db,
      { runId: run.shortcode, groupKey: "gone" },
      ctx.actor,
    );
    const done = await discardPhotoGroupProposal(
      ctx.db,
      { runId: run.shortcode, groupKey: "rest" },
      ctx.actor,
    );
    expect(done.runStatus).toBe("completed");
    expect(
      Object.fromEntries(
        done.proposals.map((entry) => [entry.groupKey, entry.state]),
      ),
    ).toEqual({ kept: "committed", gone: "discarded", rest: "discarded" });
  });

  // Regression: an approval marked the row committed AFTER the writer ran,
  // so a save landing between its read and its commit froze a roster and
  // Product choice that were never committed.
  it("freezes what the approval committed, not a save that landed mid-approval", async () => {
    const { run, codes } = await seedRun(2);
    await proposePhotoGroups(ctx.db, {
      runId: run.shortcode,
      groups: [createGroup("hat", [codes[0]!], "Synthetic Sun Hat")],
    });
    // A concurrent save, landed inside the writer's transaction: the trigger
    // rewrites the row the approval already read. The file's database is
    // reused across tests, so the trigger is dropped in `finally`.
    const firstId = (await readRow(run.id, "hat"))!.images[0]!.imageId;
    const [other] = await getDb(ctx.db)
      .select({ imageId: importRunTarget.imageId })
      .from(importRunTarget)
      .where(
        and(
          eq(importRunTarget.runId, run.id),
          sql`${importRunTarget.imageId} <> ${firstId}`,
        ),
      );
    const db = getDb(ctx.db);
    await db.execute(
      sql.raw(`CREATE FUNCTION test_mid_approval_save() RETURNS trigger AS $$
        BEGIN
          UPDATE "PhotoGroupProposal"
          SET "productCreate" = '{"name":"Edited Straw Hat"}'::jsonb,
              images = images || '[{"imageId":"${other!.imageId}","purpose":"label"}]'::jsonb
          WHERE "runId" = NEW."runId" AND "groupKey" = 'hat' AND state = 'proposed';
          RETURN NEW;
        END $$ LANGUAGE plpgsql`),
    );
    await db.execute(
      sql.raw(`CREATE TRIGGER test_mid_approval_save AFTER UPDATE ON "ImportRunTarget"
        FOR EACH ROW EXECUTE FUNCTION test_mid_approval_save()`),
    );

    let approved: Awaited<ReturnType<typeof approvePhotoGroupProposals>>;
    try {
      approved = await approvePhotoGroupProposals(
        ctx.db,
        { runId: run.shortcode },
        ctx.actor,
      );
    } finally {
      await db.execute(
        sql.raw(`DROP TRIGGER test_mid_approval_save ON "ImportRunTarget"`),
      );
      await db.execute(sql.raw(`DROP FUNCTION test_mid_approval_save()`));
    }

    expect(approved.results).toEqual([
      { groupKey: "hat", outcome: "committed" },
    ]);
    const row = await readRow(run.id, "hat");
    expect(row?.images).toHaveLength(1);
    expect(row?.productCreate).toMatchObject({ name: "Synthetic Sun Hat" });
    expect(approved.unassignedImageIds).toEqual([codes[1]]);
  });
});
