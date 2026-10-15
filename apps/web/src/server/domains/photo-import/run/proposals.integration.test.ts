import { readFileSync } from "node:fs";

import { buildActorContext } from "@cubby/schemas/context";
import { parseEntityId, parseShortcodeFor } from "@cubby/schemas/identifiers";
import type { PhotoGroupProposalGroup } from "@cubby/schemas/photo-import-run";
import { testUserId } from "@cubby/schemas/testing";
import { generateShortcode } from "@cubby/shared";
import { and, eq, ilike, sql } from "drizzle-orm";
import { TEST_HOME_SHORTCODE, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import {
  getDb,
  notDeleted,
  withTransactionDatabase,
} from "~/server/db/helpers";
import {
  image,
  imageProcessingJob,
  imageProcessingAttempt,
  run as runTable,
  photoRunImage,
  inventoryEntry,
  photoGroupProposal,
  product,
} from "~/server/db/schema";
import {
  IMAGE_APPLE_DESCRIPTION_PROCESSOR_REVISION,
  IMAGE_DESCRIPTION_PROCESSOR_REVISION,
} from "~/server/domains/image-processing/repo/image-processing";
import { deleteImages } from "~/server/domains/image/repo/image";
import { mergeLedgerParties } from "~/server/domains/ledger-party/repo/ledger-party";
import { mergeProducts } from "~/server/domains/product/repo/merge";
import {
  loadRunDetail,
  reconcileSettledRun,
  stopRunForReview,
} from "~/server/domains/purchase-import/run-service";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";
import { deleteThroughKernel } from "~/server/testing/entity-kernel";
import {
  createImageFixture,
  createInventoryFixture,
  createLocationFixture,
  createProductFixture,
  makeLocationInput,
  makeProductInput,
} from "~/server/testing/repo.fixtures";

import {
  approvePhotoGroupProposals,
  assertPhotoRunReviewer,
  chooseExistingProductForPhotoGroup,
  updatePhotoGroupProductDraft,
  discardPhotoGroupProposal,
  listPhotoGroupProposals,
  listPhotoRunImages,
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
    const id = parseEntityId("run", crypto.randomUUID());
    const [run] = await getDb(ctx.db)
      .insert(runTable)
      .values({
        id,
        shortcode: generateShortcode("run"),
        ledgerPartyId: party.id,
        actorUserId: ctx.actor.userId,
        actorName: "Proposal Tester",
        actorEmail: "test@example.com",
        actorLedgerPartyShortcode: party.shortcode,
        actorLedgerPartyName: party.name,
        actorLedgerPartyKind: "member",
        agentSessionId: `photo-proposal-test:${id}`,
        dispatchEventId: crypto.randomUUID(),
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
      .insert(photoRunImage)
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
    stockIntent: "evidence" | "receive" = "evidence",
  ): PhotoGroupProposalGroup => ({
    groupKey,
    images: imageCodes.map((id, index) => ({
      id: parseShortcodeFor("image", id),
      purpose: index === 0 ? "item" : "label",
    })),
    product: { kind: "create", create: { name } },
    review: { observedName: name, unresolvedReason: null, stockIntent },
  });

  const readRow = async (runId: string, groupKey: string) => {
    const [row] = await getDb(ctx.db)
      .select()
      .from(photoGroupProposal)
      .where(
        and(
          eq(photoGroupProposal.runId, parseEntityId("run", runId)),
          eq(photoGroupProposal.groupKey, groupKey),
        ),
      );
    return row;
  };

  // Legacy prose-only ambiguity and failed field edits must not commit stock
  // or attach evidence to a guessed variant. Retrying a reviewed edit is once-only.
  it("requires explicit identity resolution and atomically applies selected Product changes", async () => {
    const { run, codes } = await seedRun(1);
    const original = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic blue shirt" }),
      ctx.actor,
    );
    const draft = {
      ...createGroup("reviewed-shirt", codes),
      product: {
        kind: "existing" as const,
        existingId: parseShortcodeFor("product", original.id),
      },
      review: {
        observedName: "Blue shirt",
        unresolvedReason: "Choose the size",
        stockIntent: "evidence" as const,
        productChanges: { notes: "Label: medium" },
      },
    };
    await proposePhotoGroups(ctx.db, { runId: run.shortcode, groups: [draft] });
    await expect(
      commitPhotoGroup(ctx.db, { ...draft, runId: run.shortcode }, ctx.actor),
    ).rejects.toThrow("Choose the size");
    const blocked = await approvePhotoGroupProposals(
      ctx.db,
      { runId: run.shortcode },
      ctx.actor,
    );
    expect(blocked.results).toEqual([
      expect.objectContaining({
        outcome: "failed",
        error: expect.stringContaining("Choose the size"),
      }),
    ]);
    expect((await readRow(run.id, draft.groupKey))?.state).toBe("proposed");
    await proposePhotoGroups(ctx.db, {
      runId: run.shortcode,
      groups: [
        { ...draft, review: { ...draft.review, unresolvedReason: null } },
      ],
    });
    const applied = await approvePhotoGroupProposals(
      ctx.db,
      { runId: run.shortcode },
      ctx.actor,
    );
    expect(applied.results[0]?.outcome).toBe("committed");
    const [saved] = await getDb(ctx.db)
      .select({ name: product.name, notes: product.notes })
      .from(product)
      .where(eq(product.id, original.entityId));
    expect(saved).toEqual({
      name: "Synthetic blue shirt",
      notes: "Label: medium",
    });
    const replay = await approvePhotoGroupProposals(
      ctx.db,
      { runId: run.shortcode, groupKeys: [draft.groupKey] },
      ctx.actor,
    );
    expect(replay.results[0]?.outcome).toBe("replayed");
  });

  // A failed receive must roll back selected fields and attachments with stock.
  it("rolls back selected Product changes when receiving Inventory fails", async () => {
    const { run, codes } = await seedRun(1);
    const closet = await createLocationFixture(
      ctx.db,
      makeLocationInput({
        name: "Synthetic review closet",
        parentId: TEST_HOME_SHORTCODE,
      }),
      ctx.actor,
    );
    const original = await createProductFixture(
      ctx.db,
      makeProductInput({
        name: "Synthetic rollback shirt",
        notes: "Original notes",
      }),
      ctx.actor,
    );
    const draft: PhotoGroupProposalGroup = {
      ...createGroup("rollback", codes),
      product: {
        kind: "existing",
        existingId: parseShortcodeFor("product", original.id),
      },
      review: {
        observedName: "Synthetic shirt",
        unresolvedReason: null,
        stockIntent: "receive",
        productChanges: { notes: "Reviewed notes" },
      },
      inventory: {
        locationId: parseShortcodeFor("location", closet.id),
        ownershipMode: "explicit",
        quantity: 1,
      },
    };
    await proposePhotoGroups(ctx.db, { runId: run.shortcode, groups: [draft] });
    const failed = await approvePhotoGroupProposals(
      ctx.db,
      { runId: run.shortcode },
      ctx.actor,
    );
    expect(failed.results[0]).toMatchObject({
      outcome: "failed",
      error: expect.stringContaining("ownerPartyId"),
    });
    const [unchanged] = await getDb(ctx.db)
      .select({ notes: product.notes })
      .from(product)
      .where(eq(product.id, original.entityId));
    expect(unchanged?.notes).toBe("Original notes");
    const [target] = await getDb(ctx.db)
      .select({
        state: photoRunImage.state,
        receipt: photoRunImage.commitReceipt,
      })
      .from(photoRunImage)
      .where(eq(photoRunImage.runId, run.id));
    expect(target).toMatchObject({ state: "pending", receipt: null });
    await proposePhotoGroups(ctx.db, {
      runId: run.shortcode,
      groups: [
        { ...draft, inventory: { ...draft.inventory!, ownerPartyId: null } },
      ],
    });
    expect(
      (
        await approvePhotoGroupProposals(
          ctx.db,
          { runId: run.shortcode },
          ctx.actor,
        )
      ).results[0]?.outcome,
    ).toBe("committed");
  });

  it("requires a legacy proposal to be explicitly confirmed through a native edit", async () => {
    const { run, codes } = await seedRun(1);
    const draft = createGroup("legacy", codes, "Synthetic legacy shirt");
    await proposePhotoGroups(ctx.db, {
      runId: run.shortcode,
      groups: [{ ...draft, review: undefined }],
    });
    expect(
      (
        await approvePhotoGroupProposals(
          ctx.db,
          { runId: run.shortcode },
          ctx.actor,
        )
      ).results[0],
    ).toMatchObject({
      outcome: "failed",
      error: expect.stringContaining("Confirm"),
    });
    const confirmed = await updatePhotoGroupProductDraft(ctx.db, {
      runId: run.shortcode,
      groupKey: "legacy",
      name: "Synthetic confirmed shirt",
    });
    expect(confirmed.proposals[0]?.review).toMatchObject({
      observedName: "Synthetic legacy shirt",
      unresolvedReason: null,
      stockIntent: "evidence",
    });
    expect(
      (
        await approvePhotoGroupProposals(
          ctx.db,
          { runId: run.shortcode },
          ctx.actor,
        )
      ).results[0]?.outcome,
    ).toBe("committed");
  });

  // Receipt settlement can fail after the Product, photos and stock commit.
  it("reconciles a committed receipt before a retry saves the same group", async () => {
    const { run, codes } = await seedRun(1);
    const closet = await createLocationFixture(
      ctx.db,
      makeLocationInput({
        name: "Synthetic settlement closet",
        parentId: TEST_HOME_SHORTCODE,
      }),
      ctx.actor,
    );
    const draft: PhotoGroupProposalGroup = {
      ...createGroup("settlement", codes),
      review: {
        observedName: "Synthetic receipt item",
        unresolvedReason: null,
        stockIntent: "receive",
      },
      inventory: {
        locationId: parseShortcodeFor("location", closet.id),
        quantity: 2,
      },
    };
    await proposePhotoGroups(ctx.db, { runId: run.shortcode, groups: [draft] });
    const database = getDb(ctx.db);
    await database.execute(
      sql.raw(`CREATE FUNCTION test_failed_proposal_settlement() RETURNS trigger AS $$
      BEGIN
        IF NEW.state = 'committed' AND OLD."lastError" IS NULL THEN
          RAISE EXCEPTION 'Synthetic settlement failure';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`),
    );
    await database.execute(
      sql.raw(`CREATE TRIGGER test_failed_proposal_settlement BEFORE UPDATE ON "PhotoGroupProposal"
      FOR EACH ROW EXECUTE FUNCTION test_failed_proposal_settlement()`),
    );
    try {
      const failed = await approvePhotoGroupProposals(
        ctx.db,
        { runId: run.shortcode },
        ctx.actor,
      );
      expect(failed.results[0]).toMatchObject({
        outcome: "failed",
        error: expect.stringContaining("committed"),
      });
      expect((await readRow(run.id, "settlement"))?.state).toBe("proposed");
      const saved = await proposePhotoGroups(ctx.db, {
        runId: run.shortcode,
        groups: [draft],
      });
      expect(saved.frozenGroupKeys).toEqual(["settlement"]);
      expect(saved.proposals[0]?.state).toBe("committed");
      expect(
        (
          await approvePhotoGroupProposals(
            ctx.db,
            { runId: run.shortcode, groupKeys: ["settlement"] },
            ctx.actor,
          )
        ).results[0]?.outcome,
      ).toBe("replayed");
      const stock = await database
        .select({ id: inventoryEntry.id })
        .from(inventoryEntry)
        .where(
          eq(
            inventoryEntry.productId,
            (await readRow(run.id, "settlement"))!.productId!,
          ),
        );
      expect(stock).toHaveLength(1);
    } finally {
      await database.execute(
        sql.raw(
          `DROP TRIGGER test_failed_proposal_settlement ON "PhotoGroupProposal"`,
        ),
      );
      await database.execute(
        sql.raw(`DROP FUNCTION test_failed_proposal_settlement()`),
      );
    }
  });

  it.each([
    {
      review: {
        observedName: "Synthetic item",
        unresolvedReason: null,
        stockIntent: "evidence" as const,
        productChanges: { notes: "Ignored edit" },
      },
      product: {
        kind: "create" as const,
        create: { name: "Synthetic incompatible edit" },
      },
      error: /existing Product/i,
    },
  ])(
    "refuses inconsistent review intent before proposal or direct commit",
    async ({ review, product, error }) => {
      const { run, codes } = await seedRun(1);
      const group = { ...createGroup("intent", codes), product, review };
      await expect(
        proposePhotoGroups(ctx.db, { runId: run.shortcode, groups: [group] }),
      ).rejects.toThrow(error);
      await expect(
        commitPhotoGroup(ctx.db, { ...group, runId: run.shortcode }, ctx.actor),
      ).rejects.toThrow(error);
    },
  );

  // Native decodes an empty changes object as a non-nil edit; normalize it
  // before publication so clearing the last checkbox re-enables all clients.
  it("omits empty Product changes after the last selected edit is cleared", async () => {
    const { run, codes } = await seedRun(1);
    const original = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic unchanged shirt" }),
      ctx.actor,
    );
    const saved = await proposePhotoGroups(ctx.db, {
      runId: run.shortcode,
      groups: [
        {
          ...createGroup("empty-edits", codes),
          product: {
            kind: "existing",
            existingId: parseShortcodeFor("product", original.id),
          },
          review: {
            observedName: "Synthetic observed shirt",
            unresolvedReason: null,
            stockIntent: "evidence",
            productChanges: {},
          },
        },
      ],
    });
    expect(saved.proposals[0]?.review?.productChanges).toBeUndefined();
    expect(
      (await listPhotoGroupProposals(ctx.db, run.shortcode)).proposals[0]
        ?.review?.productChanges,
    ).toBeUndefined();
  });

  it("saves an incomplete receive draft but refuses to apply it", async () => {
    const { run, codes } = await seedRun(1);
    const draft = createGroup(
      "incomplete",
      codes,
      "Synthetic incomplete receive",
      "receive",
    );
    const saved = await proposePhotoGroups(ctx.db, {
      runId: run.shortcode,
      groups: [draft],
    });
    expect(saved.proposals[0]?.review?.stockIntent).toBe("receive");
    const applied = await approvePhotoGroupProposals(
      ctx.db,
      { runId: run.shortcode },
      ctx.actor,
    );
    expect(applied.results[0]).toMatchObject({
      outcome: "failed",
      error: expect.stringMatching(/receive decision requires Inventory/i),
    });
    await expect(
      commitPhotoGroup(ctx.db, { ...draft, runId: run.shortcode }, ctx.actor),
    ).rejects.toThrow(/receive decision requires Inventory/i);
    expect((await readRow(run.id, "incomplete"))?.state).toBe("proposed");
  });

  it("clears destination-specific field edits and stock selection when choosing a different Product", async () => {
    const { run, codes } = await seedRun(1);
    const [first, second] = await Promise.all([
      createProductFixture(
        ctx.db,
        makeProductInput({
          name: "Synthetic first variant",
          notes: "First notes",
        }),
        ctx.actor,
      ),
      createProductFixture(
        ctx.db,
        makeProductInput({
          name: "Synthetic second variant",
          notes: "Second notes",
        }),
        ctx.actor,
      ),
    ]);
    const closet = await createLocationFixture(
      ctx.db,
      makeLocationInput({
        name: "Synthetic variant closet",
        parentId: TEST_HOME_SHORTCODE,
      }),
      ctx.actor,
    );
    const stock = await createInventoryFixture(
      ctx.db,
      {
        productId: first.id,
        locationId: closet.id,
        amount: { value: 1, unit: "each" },
      },
      ctx.actor,
    );
    await proposePhotoGroups(ctx.db, {
      runId: run.shortcode,
      groups: [
        {
          ...createGroup("variant", codes),
          product: {
            kind: "existing",
            existingId: parseShortcodeFor("product", first.id),
          },
          review: {
            observedName: "Synthetic observed variant",
            unresolvedReason: null,
            stockIntent: "receive",
            productChanges: { notes: "Reviewed first variant" },
          },
          inventory: {
            locationId: parseShortcodeFor("location", closet.id),
            quantity: 1,
            mode: "add",
            existingEntryId: parseShortcodeFor("inventory", stock.id),
          },
        },
      ],
    });
    const same = await chooseExistingProductForPhotoGroup(ctx.db, {
      runId: run.shortcode,
      groupKey: "variant",
      productId: first.id,
    });
    expect(same.proposals[0]?.review?.productChanges).toEqual({
      notes: "Reviewed first variant",
    });
    expect(same.proposals[0]?.inventory?.existingEntryId).toBe(stock.id);
    const changed = await chooseExistingProductForPhotoGroup(ctx.db, {
      runId: run.shortcode,
      groupKey: "variant",
      productId: second.id,
    });
    expect(changed.proposals[0]?.review).toMatchObject({
      observedName: "Synthetic observed variant",
      stockIntent: "receive",
    });
    expect(changed.proposals[0]?.review?.productChanges).toBeUndefined();
    expect(changed.proposals[0]?.inventory?.existingEntryId).toBeUndefined();
    expect(changed.proposals[0]?.inventory?.mode).toBe("create");
    expect(
      (
        await approvePhotoGroupProposals(
          ctx.db,
          { runId: run.shortcode },
          ctx.actor,
        )
      ).results[0]?.outcome,
    ).toBe("committed");
    const [unchanged] = await getDb(ctx.db)
      .select({ notes: product.notes })
      .from(product)
      .where(eq(product.id, second.entityId));
    expect(unchanged?.notes).toBe("Second notes");
  });

  // Regression: `assertPhotoRunReviewer` is every review handler's gate
  // (`photoImportHandlers` in `photo-import.server.ts` calls it before doing
  // anything else). It must reject an actor with no live `member`
  // LedgerParty the exact same way as a run that doesn't exist — a 404, not a
  // 403 — so a non-member can never learn a run exists by the shape of the
  // error they get back.
  it("treats an actor with no member LedgerParty as if the run doesn't exist", async () => {
    const { run } = await seedRun(1);
    const outsider = buildActorContext(testUserId("outsider-user-id"), "web");

    await expect(
      assertPhotoRunReviewer(ctx.db, outsider, run.shortcode),
    ).rejects.toThrow(`Import run ${run.shortcode} was not found`);
  });

  it("hands a saved photo proposal to human review when the agent ends without a final progress call", async () => {
    const { run, codes } = await seedRun(2);
    const owner = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic shared photo owner",
      kind: "household",
    });
    await getDb(ctx.db)
      .update(runTable)
      .set({ ledgerPartyId: owner.id })
      .where(eq(runTable.id, run.id));
    await proposePhotoGroups(ctx.db, {
      runId: run.shortcode,
      groups: [createGroup("shirt", codes)],
    });

    const settled = await reconcileSettledRun(ctx.db, {
      runId: run.id,
      operationId: "synthetic-photo-settle",
      generation: run.dispatchEventId!,
      sequence: 1,
      receivedEventIds: new Set([run.dispatchEventId!]),
    });
    expect(settled).toEqual({ reconciled: false, status: "running" });
    expect(
      (await loadRunDetail(ctx.db, run.shortcode)).latestProgress,
    ).toMatchObject({
      phase: "awaiting_approval",
      awaitingApproval: true,
    });
    expect(
      (await listPhotoGroupProposals(ctx.db, run.shortcode)).runStatus,
    ).toBe("running");

    const approved = await approvePhotoGroupProposals(
      ctx.db,
      { runId: run.shortcode, groupKeys: ["shirt"] },
      ctx.actor,
    );
    expect(approved.results).toEqual([
      { groupKey: "shirt", outcome: "committed" },
    ]);
    expect(approved.runStatus).toBe("completed");
  });

  it("rejects a stale selected batch before committing any group", async () => {
    const { run, codes } = await seedRun(2);
    await proposePhotoGroups(ctx.db, {
      runId: run.shortcode,
      groups: [
        createGroup("shirt", [codes[0]!]),
        createGroup("hat", [codes[1]!]),
      ],
    });
    const request = {
      runId: run.shortcode,
      groupKeys: ["shirt", "hat"],
      expectedRevisions: [
        { groupKey: "shirt", updatedAt: "2000-01-01T00:00:00.000Z" },
        { groupKey: "hat", updatedAt: "2000-01-01T00:00:00.000Z" },
      ],
    };

    await expect(
      approvePhotoGroupProposals(ctx.db, request, ctx.actor),
    ).rejects.toThrow("Photo group review changed");
    expect(
      (await listPhotoGroupProposals(ctx.db, run.shortcode)).proposals.map(
        (proposal) => proposal.state,
      ),
    ).toEqual(["proposed", "proposed"]);
  });

  it("lets a reviewer finish a photo proposal stranded in needs-review", async () => {
    const { run, codes } = await seedRun(3);
    await proposePhotoGroups(ctx.db, {
      runId: run.shortcode,
      groups: [
        createGroup("shirt", codes.slice(0, 2)),
        createGroup("hat", [codes[2]!]),
      ],
    });
    await stopRunForReview(ctx.db, {
      runId: run.id,
      operationId: "synthetic-photo-review-stop",
      kind: "other",
      summary: "Agent ended before review handoff",
    });

    const review = await listPhotoGroupProposals(ctx.db, run.shortcode);
    expect(review.runStatus).toBe("needs_review");
    const approved = await approvePhotoGroupProposals(
      ctx.db,
      { runId: run.shortcode, groupKeys: ["shirt"] },
      ctx.actor,
    );
    expect(approved.results).toEqual([
      { groupKey: "shirt", outcome: "committed" },
    ]);
    expect(approved.runStatus).toBe("needs_review");
    const final = await approvePhotoGroupProposals(
      ctx.db,
      { runId: run.shortcode, groupKeys: ["hat"] },
      ctx.actor,
    );
    expect(final.results).toEqual([{ groupKey: "hat", outcome: "committed" }]);
    expect(final.runStatus).toBe("completed");
  });

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
          review: {
            observedName: "Synthetic observed shirt",
            unresolvedReason: "Choose the exact size",
            stockIntent: "counted",
          },
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
    expect(group?.review).toMatchObject({
      observedName: "Synthetic observed shirt",
      unresolvedReason: null,
      stockIntent: "counted",
    });

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
          ...createGroup("coat", codes, "Synthetic Rain Coat", "receive"),
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

  it("waits for current cloud descriptions but lets Apple descriptions and device cutout work continue", async () => {
    const { run, codes } = await seedRun(1);
    const [source] = await getDb(ctx.db)
      .select({ id: image.id })
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
        shortcode: generateShortcode("imageJob"),
        imageId: parseEntityId("image", source.id),
        kind: "describe_image",
        state: "pending",
        sourceContentHash: sourceHash,
        processorRevision: IMAGE_DESCRIPTION_PROCESSOR_REVISION,
      })
      .returning();
    const [appleDescription] = await getDb(ctx.db)
      .insert(imageProcessingJob)
      .values({
        shortcode: generateShortcode("imageJob"),
        imageId: parseEntityId("image", source.id),
        kind: "describe_image",
        state: "waiting_for_device",
        sourceContentHash: sourceHash,
        processorRevision: IMAGE_APPLE_DESCRIPTION_PROCESSOR_REVISION,
      })
      .returning({ id: imageProcessingJob.id });
    await getDb(ctx.db)
      .insert(imageProcessingJob)
      .values({
        shortcode: generateShortcode("imageJob"),
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
    expect(
      await getDb(ctx.db)
        .select({ state: imageProcessingJob.state })
        .from(imageProcessingJob)
        .where(eq(imageProcessingJob.id, appleDescription!.id)),
    ).toEqual([{ state: "waiting_for_device" }]);
  });

  // Regression: each upload numbers its photos from 0, so a second batch
  // appended to an open run interleaved with the first when the run sorted by
  // `position`, separating tags from their garments.
  it("orders run photos by capture time across appended batches, undated last", async () => {
    const { run, codes } = await seedRun(5);
    const batches = [
      { code: codes[0]!, position: 0, capturedAt: "2026-09-20T09:00:00.000Z" },
      { code: codes[1]!, position: 1, capturedAt: "2026-09-20T09:02:00.000Z" },
      { code: codes[2]!, position: 0, capturedAt: "2026-09-20T09:01:00.000Z" },
      { code: codes[3]!, position: 1, capturedAt: "2026-09-20T09:03:00.000Z" },
      { code: codes[4]!, position: 0, capturedAt: null },
    ];
    for (const photo of batches) {
      const [row] = await getDb(ctx.db)
        .update(image)
        .set({
          capturedAt: photo.capturedAt ? new Date(photo.capturedAt) : null,
        })
        .where(eq(image.shortcode, photo.code))
        .returning({ id: image.id });
      await getDb(ctx.db)
        .update(photoRunImage)
        .set({ position: photo.position })
        .where(eq(photoRunImage.imageId, parseEntityId("image", row!.id)));
    }

    const listed = await listPhotoRunImages(ctx.db, run.shortcode);
    expect(listed.map((photo) => photo.id)).toEqual([
      codes[0],
      codes[2],
      codes[1],
      codes[3],
      codes[4],
    ]);
    expect(listed[1]).toMatchObject({
      capturedAt: "2026-09-20T09:01:00.000Z",
    });
  });

  // Undated photos (stripped-EXIF exports) tie on capture time, so each
  // appended batch must stay together before its own picker order applies.
  it("keeps undated photos grouped by the upload that added them", async () => {
    const { run, codes } = await seedRun(4);
    const uploads = [
      { code: codes[0]!, position: 0, addedAt: "2026-09-20T09:00:00.000Z" },
      { code: codes[1]!, position: 1, addedAt: "2026-09-20T09:00:00.000Z" },
      { code: codes[2]!, position: 0, addedAt: "2026-09-20T10:00:00.000Z" },
      { code: codes[3]!, position: 1, addedAt: "2026-09-20T10:00:00.000Z" },
    ];
    for (const photo of uploads) {
      const [row] = await getDb(ctx.db)
        .update(image)
        .set({ capturedAt: null })
        .where(eq(image.shortcode, photo.code))
        .returning({ id: image.id });
      await getDb(ctx.db)
        .update(photoRunImage)
        .set({ position: photo.position, createdAt: new Date(photo.addedAt) })
        .where(eq(photoRunImage.imageId, parseEntityId("image", row!.id)));
    }

    const listed = await listPhotoRunImages(ctx.db, run.shortcode);
    expect(listed.map((photo) => photo.id)).toEqual(codes);
  });

  it("reports description attempt time separately from queue time", async () => {
    const { run, codes } = await seedRun(1);
    const [source] = await getDb(ctx.db)
      .select({ id: image.id })
      .from(image)
      .where(eq(image.shortcode, codes[0]!));
    if (!source) throw new Error("fixture: image not found");
    const contentHash = "e".repeat(64);
    await getDb(ctx.db)
      .update(image)
      .set({ sha256: contentHash })
      .where(eq(image.id, source.id));
    const dispatchedAt = new Date("2026-09-20T08:00:00.000Z");
    const completedAt = new Date("2026-09-20T14:38:55.500Z");
    const [job] = await getDb(ctx.db)
      .insert(imageProcessingJob)
      .values({
        shortcode: generateShortcode("imageJob"),
        imageId: parseEntityId("image", source.id),
        kind: "describe_image",
        state: "ready",
        sourceContentHash: contentHash,
        processorRevision: IMAGE_DESCRIPTION_PROCESSOR_REVISION,
        dispatchedAt,
        completedAt,
      })
      .returning({ id: imageProcessingJob.id });
    await getDb(ctx.db)
      .insert(imageProcessingJob)
      .values({
        shortcode: generateShortcode("imageJob"),
        imageId: parseEntityId("image", source.id),
        kind: "describe_image",
        state: "waiting_for_device",
        sourceContentHash: contentHash,
        processorRevision: IMAGE_APPLE_DESCRIPTION_PROCESSOR_REVISION,
        dispatchedAt: new Date("2026-09-20T07:00:00.000Z"),
      });
    await getDb(ctx.db)
      .insert(imageProcessingAttempt)
      .values({
        id: crypto.randomUUID(),
        jobId: job!.id,
        number: 1,
        state: "ready",
        startedAt: new Date("2026-09-20T14:38:51.500Z"),
        completedAt,
      });

    expect(await listPhotoRunImages(ctx.db, run.shortcode)).toEqual([
      expect.objectContaining({
        id: codes[0],
        describe: "ready",
        describeStartedAt: dispatchedAt.toISOString(),
        describeCompletedAt: completedAt.toISOString(),
        describeAttemptMs: 4_000,
        describeWaitingMs: 23_931_500,
      }),
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
          ...createGroup("boots", codes, "Synthetic Hiking Boots", "receive"),
          // Explicit ownership with no owner key is refused by the writer.
          inventory: {
            locationId: parseShortcodeFor("location", closet.id),
            ownershipMode: "explicit",
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
      .select({ state: photoRunImage.state })
      .from(photoRunImage)
      .where(
        eq(
          photoRunImage.imageId,
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
          ...createGroup("owned", codes, "Synthetic Owned Lamp", "receive"),
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
            ownershipMode: "explicit",
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
    await deleteThroughKernel(ctx.db, ctx.actor, "productCategory", [
      parseShortcodeFor("productCategory", category.shortcode),
    ]);

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
      .update(runTable)
      .set({ status: "failed" })
      .where(eq(runTable.id, run.id));

    await proposePhotoGroups(ctx.db, {
      runId: run.shortcode,
      groups: [],
      removeGroupKeys: ["late"],
    });
    expect(await readRow(run.id, "late")).toBeUndefined();
  });

  // Regression: deleting a run photo hard-deletes its PhotoRunImage but not
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
        .delete(photoRunImage)
        .where(eq(photoRunImage.imageId, parseEntityId("image", deleted)));

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

  // A save can win after the request's revision precheck but before its writer
  // acquires the Run lock. The stale approval must preserve the newer draft.
  it("rechecks the proposal revision under the domain write lock and preserves a concurrent edit", async () => {
    const { run, codes } = await seedRun(2);
    const original = createGroup("hat", [codes[0]!], "Synthetic original hat");
    const initial = await proposePhotoGroups(ctx.db, {
      runId: run.shortcode,
      groups: [original],
    });
    const revision = initial.proposals[0]!.updatedAt;
    let approval:
      | Promise<Awaited<ReturnType<typeof approvePhotoGroupProposals>>>
      | undefined;
    let approved:
      | Awaited<ReturnType<typeof approvePhotoGroupProposals>>
      | undefined;
    try {
      await withTransactionDatabase(ctx.db, async (holder) => {
        const connection = await getDb(holder).execute<{ pid: number }>(
          sql`SELECT pg_backend_pid() AS pid`,
        );
        const pid = connection.rows[0]!.pid;
        await getDb(holder)
          .select({ id: runTable.id })
          .from(runTable)
          .where(eq(runTable.id, run.id))
          .for("update");
        approval = approvePhotoGroupProposals(
          ctx.db,
          {
            runId: run.shortcode,
            groupKeys: ["hat"],
            expectedRevisions: [{ groupKey: "hat", updatedAt: revision }],
          },
          ctx.actor,
        );
        // Observe the writer actually waiting for this transaction, so the
        // edit lands after its initial precheck with no timing assumption.
        await expect
          .poll(
            async () => {
              const waiting = await getDb(ctx.db).execute<{
                count: number;
              }>(sql`
            SELECT count(*)::int AS count FROM pg_stat_activity
            WHERE datname = current_database() AND ${pid} = ANY(pg_blocking_pids(pid))`);
              return waiting.rows[0]!.count;
            },
            { timeout: 5_000, interval: 20 },
          )
          .toBe(1);
        await proposePhotoGroups(holder, {
          runId: run.shortcode,
          groups: [createGroup("hat", codes, "Synthetic edited hat")],
        });
      });
    } finally {
      if (approval) approved = await approval;
    }
    expect(approved?.results).toEqual([
      {
        groupKey: "hat",
        outcome: "failed",
        error: expect.stringContaining("Photo group review changed"),
      },
    ]);
    const saved = await readRow(run.id, "hat");
    expect(saved).toMatchObject({
      state: "proposed",
      productCreate: { name: "Synthetic edited hat" },
      lastError: null,
    });
    expect(saved?.images).toHaveLength(2);
    expect(
      await getDb(ctx.db)
        .select({ id: product.id })
        .from(product)
        .where(ilike(product.name, "Synthetic original hat")),
    ).toEqual([]);
    expect(
      await getDb(ctx.db)
        .select({ state: photoRunImage.state })
        .from(photoRunImage)
        .where(eq(photoRunImage.runId, run.id)),
    ).toEqual([{ state: "pending" }, { state: "pending" }]);
    const current = (await listPhotoGroupProposals(ctx.db, run.shortcode))
      .proposals[0]!;
    const retry = await approvePhotoGroupProposals(
      ctx.db,
      {
        runId: run.shortcode,
        groupKeys: ["hat"],
        expectedRevisions: [{ groupKey: "hat", updatedAt: current.updatedAt }],
      },
      ctx.actor,
    );
    expect(retry.results).toEqual([{ groupKey: "hat", outcome: "committed" }]);
    expect(retry.proposals[0]?.committedProduct?.name).toBe(
      "Synthetic edited hat",
    );
  });
  // Household data must survive 0067: a stored person proposal keeps its owner
  // column, and a stored unassigned one stays household stock.
  it("reads proposals stored in the old ownership vocabulary after the migration", async () => {
    const { run, codes } = await seedRun(2);
    const owner = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic proposal owner",
      kind: "member",
    });
    const inventory = (ownerPartyId: string | null) => ({
      locationId: parseShortcodeFor("location", TEST_HOME_SHORTCODE),
      ownershipMode: "explicit" as const,
      ownerPartyId:
        ownerPartyId === null
          ? null
          : parseShortcodeFor("ledgerParty", ownerPartyId),
      quantity: 1,
    });
    await proposePhotoGroups(ctx.db, {
      runId: run.shortcode,
      groups: [
        {
          ...createGroup(
            "person",
            [codes[0]!],
            "Synthetic person item",
            "receive",
          ),
          inventory: inventory(owner.shortcode),
        },
        {
          ...createGroup(
            "household",
            [codes[1]!],
            "Synthetic household item",
            "receive",
          ),
          inventory: inventory(null),
        },
      ],
    });
    const db = getDb(ctx.db);
    // Rewind both rows to the shape stored before 0067.
    for (const [groupKey, legacyMode] of [
      ["person", "person"],
      ["household", "unassigned"],
    ])
      await db.execute(sql`
        UPDATE "PhotoGroupProposal"
        SET "inventory" = ("inventory" - ${"household"}) || jsonb_build_object(${"ownershipMode"}::text, ${legacyMode}::text)
        WHERE "groupKey" = ${groupKey}`);
    const migration = readFileSync(
      new URL(
        "../../../../../drizzle/0067_inventory_ownership_explicit.sql",
        import.meta.url,
      ),
      "utf8",
    );
    for (const statement of migration.split("--> statement-breakpoint"))
      if (statement.includes('"PhotoGroupProposal"'))
        await db.execute(sql.raw(statement));

    const { proposals } = await listPhotoGroupProposals(ctx.db, run.shortcode);
    const byKey = new Map(proposals.map((row) => [row.groupKey, row]));
    expect(byKey.get("person")?.inventory).toMatchObject({
      ownershipMode: "explicit",
      ownerPartyId: owner.shortcode,
    });
    expect(byKey.get("household")?.inventory).toMatchObject({
      ownershipMode: "explicit",
      ownerPartyId: null,
    });
  });
});
