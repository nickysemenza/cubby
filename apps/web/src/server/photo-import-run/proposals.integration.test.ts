import { parseEntityId, parseShortcodeFor } from "@cubby/schemas/identifiers";
import type { PhotoGroupProposalGroup } from "@cubby/schemas/photo-import-run";
import { generateShortcode } from "@cubby/shared";
import { and, eq, ilike } from "drizzle-orm";
import { TEST_HOME_SHORTCODE, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import {
  importRun,
  importRunTarget,
  inventoryEntry,
  photoGroupProposal,
  product,
} from "~/server/db/schema";
import { getDb, notDeleted } from "~/server/repo/database-helpers";
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
});
