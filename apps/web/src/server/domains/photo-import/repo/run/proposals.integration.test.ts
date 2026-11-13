import { buildActorContext } from "@cubby/schemas/context";
import { parseEntityId, parseShortcodeFor } from "@cubby/schemas/identifiers";
import type { PhotoGroupProposalGroup } from "@cubby/schemas/photo-import-run";
import { testUserId } from "@cubby/schemas/testing";
import { generateShortcode } from "@cubby/shared";
import { and, eq, ilike, sql } from "drizzle-orm";
import { createRepoEntity } from "tooling/factories/repo";
import { TEST_HOME_SHORTCODE, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { insertFieldsFixture as insertWithShortcode } from "~/server/ai/fields/fields.fixtures";
import {
  getDb,
  notDeleted,
  withTransactionDatabase,
} from "~/server/db/helpers";
import {
  suggestionTable,
  aiAnalysis,
  image,
  run as runTable,
  photoRunImage,
  inventoryEntry,
  photoGroupProposal,
  product,
  vendor,
} from "~/server/db/schema";
import { mergeLedgerParties } from "~/server/domains/ledger-party/repo/ledger-party";
import { mergeProducts } from "~/server/domains/product/repo/merge";
import { ensureRun } from "~/server/domains/run/repo/ensure-run";
import { kernelCtx } from "~/server/domains/run/service/suggestion-sweep.fixtures";
import { mergeVendors } from "~/server/domains/vendor/repo/vendor";
import { executeEntityAs } from "~/server/entity-kernel";
import { buildCrudServices } from "~/server/http/request-context";
import { deleteThroughKernel } from "~/server/testing/entity-kernel";
import {
  createImageFixture,
  createInventoryFixture,
  createLocationFixture,
  createProductFixture,
  createProductIdentityFixture,
  makeLocationInput,
  makeProductInput,
} from "~/server/testing/repo.fixtures";
import { readSuggestionDecisions } from "~/server/testing/suggestion-decisions.fixtures";

import {
  rejectPhotoProductCandidate,
  loadRejectedPhotoProductCandidates,
  photoRunCandidates,
} from "../photo-group-candidates";
import {
  readRemainingPhotoRunContext,
  approvePhotoGroupProposals,
  resolvePhotoGroupConcern,
  assertPhotoRunReviewer,
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
    const id = await ensureRun(ctx.db, ctx.actor, {
      purpose: "photo_inventory",
      trigger: "manual",
      execution: false,
    });
    const [run] = await getDb(ctx.db)
      .update(runTable)
      .set({
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
      .where(eq(runTable.id, id))
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

  it("checkpoints an unfinished item atomically and resumes without repeating member decisions", async () => {
    const { run, codes } = await seedRun(4);
    await proposePhotoGroups(
      ctx.db,
      buildCrudServices,
      {
        runId: run.shortcode,
        groups: [
          createGroup("settled-page", [codes[0]!]),
          createGroup("boundary", [codes[1]!]),
        ],
        boundaryGroupKey: "boundary",
      },
      "external_agent",
    );
    const first = await readRemainingPhotoRunContext(ctx.db, run.shortcode);
    expect(first.boundaryGroup?.groupKey).toBe("boundary");
    expect(first.images.map((entry) => entry.id)).toEqual(codes.slice(2));
    await expect(
      proposePhotoGroups(
        ctx.db,
        buildCrudServices,
        {
          runId: run.shortcode,
          groups: [createGroup("invalid", [codes[0]!])],
          boundaryGroupKey: null,
        },
        "external_agent",
      ),
    ).rejects.toThrow(/appears in both/);
    expect(
      (await readRemainingPhotoRunContext(ctx.db, run.shortcode)).boundaryGroup
        ?.groupKey,
    ).toBe("boundary");
    await proposePhotoGroups(
      ctx.db,
      buildCrudServices,
      {
        runId: run.shortcode,
        groups: [createGroup("boundary", [codes[1]!, codes[2]!])],
        boundaryGroupKey: "boundary",
      },
      "external_agent",
    );
    const continued = await readRemainingPhotoRunContext(ctx.db, run.shortcode);
    expect(continued.boundaryGroup?.images.map((entry) => entry.id)).toEqual(
      codes.slice(1, 3),
    );
    expect(continued.images.map((entry) => entry.id)).toEqual(codes.slice(3));
    await proposePhotoGroups(
      ctx.db,
      buildCrudServices,
      {
        runId: run.shortcode,
        groups: [
          createGroup(
            "boundary",
            [codes[1]!, codes[2]!],
            "Synthetic member choice",
          ),
        ],
      },
      "member",
    );
    const reviewed = await readRemainingPhotoRunContext(ctx.db, run.shortcode);
    expect(reviewed.boundaryGroup).toBeNull();
    expect(reviewed.images.map((entry) => entry.id)).toEqual(codes.slice(3));
    expect((await readRow(run.id, "boundary"))?.productCreate?.name).toBe(
      "Synthetic member choice",
    );
  });

  it.each(["create", "update"])(
    "refuses to hydrate a stale %s proposal Brand instead of treating it as a clear",
    async (kind) => {
      const { run, codes } = await seedRun(1);
      const brand = await insertWithShortcode(ctx.db, "vendor", {
        name: "Synthetic stale proposal Brand",
      });
      const destination = await createProductFixture(
        ctx.db,
        makeProductInput({ name: "Synthetic stale Brand destination" }),
        ctx.actor,
      );
      const group = createGroup("stale-brand", codes);
      if (kind === "create") {
        group.product = {
          kind: "create",
          create: {
            name: "Synthetic stale Brand draft",
            brandId: brand.shortcode,
          },
        };
      } else {
        group.product = {
          kind: "existing",
          existingId: parseShortcodeFor("product", destination.id),
        };
        group.review = {
          observedName: "Synthetic stale Brand item",
          unresolvedReason: null,
          stockIntent: "evidence",
          productChanges: { brandId: brand.shortcode },
        };
      }
      await proposePhotoGroups(ctx.db, buildCrudServices, {
        runId: run.shortcode,
        groups: [group],
      });
      // Simulate retained invalid state without asking the lifecycle writer to bypass its policy.
      await getDb(ctx.db)
        .update(vendor)
        .set({ deletedAt: new Date() })
        .where(eq(vendor.id, brand.id));
      await expect(
        listPhotoGroupProposals(ctx.db, run.shortcode),
      ).rejects.toThrow("refers to a Brand that is no longer available");
      expect((await readRow(run.id, "stale-brand"))?.productCreateBrandId).toBe(
        brand.id,
      );
    },
  );

  it.each(["create", "update"])(
    "refuses a %s proposal Brand merged while its save waits for the Vendor lock",
    async (kind) => {
      const { run, codes } = await seedRun(1);
      const keeper = await insertWithShortcode(ctx.db, "vendor", {
        name: "Synthetic Brand keeper",
      });
      const donor = await insertWithShortcode(ctx.db, "vendor", {
        name: "Synthetic Brand donor",
      });
      const destination = await createProductFixture(
        ctx.db,
        makeProductInput({ name: "Synthetic concurrent Brand destination" }),
        ctx.actor,
      );
      const group = createGroup("concurrent-brand", codes);
      if (kind === "create") {
        group.product = {
          kind: "create",
          create: {
            name: "Synthetic concurrent Brand draft",
            brandId: donor.shortcode,
          },
        };
      } else {
        group.product = {
          kind: "existing",
          existingId: parseShortcodeFor("product", destination.id),
        };
        group.review = {
          observedName: "Synthetic concurrent Brand item",
          unresolvedReason: null,
          stockIntent: "evidence",
          productChanges: { brandId: donor.shortcode },
        };
      }
      let saveOutcome: Promise<unknown> | undefined;
      try {
        await withTransactionDatabase(ctx.db, async (holder) => {
          await getDb(holder)
            .select({ id: vendor.id })
            .from(vendor)
            .where(eq(vendor.id, donor.id))
            .for("update");
          const connection = await getDb(holder).execute<{ pid: number }>(
            sql`SELECT pg_backend_pid() AS pid`,
          );
          const pid = connection.rows[0]!.pid;
          saveOutcome = proposePhotoGroups(ctx.db, buildCrudServices, {
            runId: run.shortcode,
            groups: [group],
          }).catch((error: unknown) => error);
          // Observe actual lock contention; no timer or production test hook controls the race.
          await expect
            .poll(
              async () => {
                const waiting = await getDb(ctx.db).execute<{
                  waiting: boolean;
                }>(sql`
            SELECT EXISTS(SELECT 1 FROM pg_stat_activity
              WHERE datname=current_database() AND ${pid}::int = ANY(pg_blocking_pids(pid))) AS waiting`);
                return waiting.rows[0]?.waiting;
              },
              { timeout: 5_000, interval: 20 },
            )
            .toBe(true);
          await mergeVendors(
            holder,
            { keepId: keeper.shortcode, mergeIds: [donor.shortcode] },
            ctx.actor,
          );
        });
      } finally {
        if (saveOutcome) await saveOutcome;
      }
      const outcome = await saveOutcome;
      expect(outcome).toBeInstanceOf(Error);
      expect(outcome).toMatchObject({
        message: expect.stringContaining(
          "selected photo Brand is no longer available",
        ),
      });
      expect(await readRow(run.id, "concurrent-brand")).toBeUndefined();
      expect(
        (await listPhotoGroupProposals(ctx.db, run.shortcode)).proposals,
      ).toEqual([]);
    },
  );

  // Rejections belong to the photographed item, including after group keys change.
  it("suppresses wrong candidate Feedback through combine and split and isolates inference failure", async () => {
    const { run, codes } = await seedRun(3);
    const rejected = await createProductIdentityFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic canvas boot" }),
      ctx.actor,
    );
    await proposePhotoGroups(ctx.db, buildCrudServices, {
      runId: run.shortcode,
      groups: [
        createGroup("first", [codes[0]!]),
        createGroup("second", [codes[1]!]),
      ],
    });
    await rejectPhotoProductCandidate(
      ctx.db,
      {
        runId: run.shortcode,
        groupKey: "first",
        productId: rejected.id,
        operationId: "synthetic-reject",
      },
      kernelCtx(ctx),
    );
    let saved = await proposePhotoGroups(ctx.db, buildCrudServices, {
      runId: run.shortcode,
      removeGroupKeys: ["first", "second"],
      groups: [
        createGroup("combined", codes.slice(0, 2), "Synthetic canvas boot"),
      ],
    });
    expect(
      await loadRejectedPhotoProductCandidates(
        ctx.db,
        run.shortcode,
        saved.proposals[0]!,
      ),
    ).toEqual([
      { id: rejected.id, name: "Synthetic canvas boot", rejected: true },
    ]);
    saved = await proposePhotoGroups(ctx.db, buildCrudServices, {
      runId: run.shortcode,
      removeGroupKeys: ["combined"],
      groups: [
        createGroup("split-a", [codes[0]!], "Synthetic canvas boot"),
        createGroup("split-b", [codes[1]!], "Synthetic canvas boot"),
        createGroup("independent", [codes[2]!], "Synthetic canvas boot"),
      ],
    });
    expect(
      await loadRejectedPhotoProductCandidates(
        ctx.db,
        run.shortcode,
        saved.proposals.find((group) => group.groupKey === "split-a")!,
      ),
    ).toHaveLength(1);
    expect(
      await loadRejectedPhotoProductCandidates(
        ctx.db,
        run.shortcode,
        saved.proposals.find((group) => group.groupKey === "split-b")!,
      ),
    ).toHaveLength(1);
    const result = await photoRunCandidates(
      ctx.db,
      saved,
      [],
      ctx.actor,
      async () => {
        throw new Error("Synthetic inference failure");
      },
    );
    const subset = await photoRunCandidates(
      ctx.db,
      saved,
      [],
      ctx.actor,
      async () => {
        throw new Error("Synthetic subset failure");
      },
      ["independent"],
    );
    expect(subset.groups.map((group) => group.groupKey)).toEqual([
      "independent",
    ]);
    expect(subset.groups[0]).toMatchObject({
      status: "failed",
      error: "Synthetic subset failure",
    });
    expect(
      result.groups.find((group) => group.groupKey === "split-a"),
    ).toMatchObject({
      status: "ready",
      candidates: [],
      rejectedCandidates: [{ id: rejected.id, rejected: true }],
    });
    expect(
      result.groups.find((group) => group.groupKey === "independent"),
    ).toMatchObject({ status: "failed", error: "Synthetic inference failure" });
  });

  // Regrouping is not concern resolution, even when no incoming review is supplied.
  it.each<string>(["split"])(
    "preserves blocking concerns and resolution history through %s saves without review",
    async (operation) => {
      const { run, codes } = await seedRun(3);
      const source = createGroup("source", codes.slice(0, 2));
      source.review!.unresolvedReason = "Check the printed width";
      await proposePhotoGroups(ctx.db, buildCrudServices, {
        runId: run.shortcode,
        groups: [source],
      });
      await resolvePhotoGroupConcern(
        ctx.db,
        {
          runId: run.shortcode,
          groupKey: "source",
          reply: "Width checked",
        },
        ctx.actor,
      );
      source.review!.unresolvedReason =
        operation === "merge"
          ? `Check the printed size ${"s".repeat(470)}`
          : "Check the printed size";
      const destination = createGroup("destination", [codes[2]!]);
      destination.review!.unresolvedReason = "Check the brandName";
      await proposePhotoGroups(ctx.db, buildCrudServices, {
        runId: run.shortcode,
        groups: [source, destination],
      });
      const drafts =
        operation === "split"
          ? [
              createGroup("split-a", [codes[0]!]),
              createGroup("split-b", [codes[1]!]),
            ]
          : operation === "merge"
            ? [createGroup("destination", codes)]
            : [createGroup("source", codes.slice(0, 2))];
      for (const draft of drafts) delete draft.review;
      const saved = await proposePhotoGroups(ctx.db, buildCrudServices, {
        runId: run.shortcode,
        groups: drafts,
        removeGroupKeys: operation === "same-key" ? [] : ["source"],
      });
      for (const draft of drafts) {
        const group = saved.proposals.find(
          (item) => item.groupKey === draft.groupKey,
        )!;
        expect(group.review?.unresolvedReason?.split("\n")).toEqual(
          expect.arrayContaining([
            source.review!.unresolvedReason,
            ...(operation === "merge" ? ["Check the brandName"] : []),
          ]),
        );
        expect(group.blockedReason).toContain("Check the printed size");
        expect(group.review?.resolvedConcerns).toEqual([
          expect.objectContaining({
            reason: "Check the printed width",
            reply: "Width checked",
            by: ctx.actor.userId,
          }),
        ]);
      }
      const applied = await approvePhotoGroupProposals(
        ctx.db,
        buildCrudServices,
        {
          runId: run.shortcode,
          groupKeys: drafts.map((draft) => draft.groupKey),
        },
        ctx.actor,
      );
      expect(applied.results).toEqual(
        drafts.map((draft) =>
          expect.objectContaining({
            groupKey: draft.groupKey,
            outcome: "failed",
            error: expect.stringContaining("Check the printed size"),
          }),
        ),
      );
    },
  );

  // Editing a destination or draft is not an answer to an agent's concern.
  it("preserves concerns across edits and records explicit resolution before atomic confirmation", async () => {
    const { run, codes } = await seedRun(1);
    const draft = createGroup("concern-history", codes);
    draft.review!.unresolvedReason = "Label size needs checking";
    await proposePhotoGroups(ctx.db, buildCrudServices, {
      runId: run.shortcode,
      groups: [draft],
    });
    await updatePhotoGroupProductDraft(ctx.db, buildCrudServices, {
      runId: run.shortcode,
      groupKey: draft.groupKey,
      name: "Synthetic size 10 shoe",
    });
    expect(
      (await readRow(run.id, draft.groupKey))?.review?.unresolvedReason,
    ).toBe("Label size needs checking");
    await resolvePhotoGroupConcern(
      ctx.db,
      {
        runId: run.shortcode,
        groupKey: draft.groupKey,
        reply: "Checked the printed label",
      },
      ctx.actor,
    );
    const resolved = await readRow(run.id, draft.groupKey);
    expect(resolved?.review?.resolvedConcerns).toEqual([
      expect.objectContaining({
        reason: "Label size needs checking",
        reply: "Checked the printed label",
        by: ctx.actor.userId,
      }),
    ]);
    const applied = await approvePhotoGroupProposals(
      ctx.db,
      buildCrudServices,
      { runId: run.shortcode },
      ctx.actor,
    );
    expect(applied.results[0]?.outcome).toBe("committed");
    const saved = await readRow(run.id, draft.groupKey);
    expect(saved?.review?.confirmation).toEqual(
      expect.objectContaining({ by: ctx.actor.userId }),
    );
    const replay = await approvePhotoGroupProposals(
      ctx.db,
      buildCrudServices,
      {
        runId: run.shortcode,
        groupKeys: [draft.groupKey],
        expectedRevisions: [
          {
            groupKey: draft.groupKey,
            updatedAt: resolved!.updatedAt.toISOString(),
          },
        ],
      },
      ctx.actor,
    );
    expect(replay.results[0]?.outcome).toBe("replayed");
    expect(
      (await readRow(run.id, draft.groupKey))?.review?.confirmation,
    ).toEqual(saved?.review?.confirmation);
  });

  // Missing review is allowed for skip-only work, but never authorizes Product writes.
  it("refuses direct writes without review and completes skip-only groups", async () => {
    const { run, codes } = await seedRun(1);
    const draft = createGroup("direct-intent", codes);
    await expect(
      commitPhotoGroup(
        ctx.db,
        buildCrudServices,
        { ...draft, review: undefined, runId: run.shortcode },
        ctx.actor,
      ),
    ).rejects.toThrow("review intent");
    const skipped = await commitPhotoGroup(
      ctx.db,
      buildCrudServices,
      {
        ...draft,
        review: undefined,
        runId: run.shortcode,
        images: [],
        skip: codes.map((id) => ({ id, reason: "Synthetic unrelated photo" })),
      },
      ctx.actor,
    );
    expect(skipped.runStatus).toBe("completed");
    expect(skipped.productId).toBeUndefined();
  });

  // Legacy prose-only ambiguity and failed field edits must not commit stock
  // or attach evidence to a guessed variant. Retrying a reviewed edit is once-only.
  it("requires explicit identity resolution and atomically applies selected Product changes", async () => {
    const { run, codes } = await seedRun(1);
    const original = await createProductIdentityFixture(
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
        productChanges: {
          notes: "Label: medium",
          tags: ["synthetic", "reviewed"],
        },
      },
    };
    await proposePhotoGroups(ctx.db, buildCrudServices, {
      runId: run.shortcode,
      groups: [draft],
    });
    await expect(
      commitPhotoGroup(
        ctx.db,
        buildCrudServices,
        { ...draft, runId: run.shortcode },
        ctx.actor,
      ),
    ).rejects.toThrow("Choose the size");
    const blocked = await approvePhotoGroupProposals(
      ctx.db,
      buildCrudServices,
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
    await resolvePhotoGroupConcern(
      ctx.db,
      { runId: run.shortcode, groupKey: draft.groupKey },
      ctx.actor,
    );
    const applied = await approvePhotoGroupProposals(
      ctx.db,
      buildCrudServices,
      { runId: run.shortcode },
      ctx.actor,
    );
    expect(applied.results[0]?.outcome).toBe("committed");
    const [saved] = await getDb(ctx.db)
      .select({ name: product.name, notes: product.notes, tags: product.tags })
      .from(product)
      .where(eq(product.id, original.entityId));
    expect(saved).toEqual({
      name: "Synthetic blue shirt",
      notes: "Label: medium",
      tags: ["synthetic", "reviewed"],
    });
    const states = await getDb(ctx.db)
      .select({
        status: suggestionTable.status,
        active: suggestionTable.active,
      })
      .from(suggestionTable)
      .where(eq(suggestionTable.recordId, original.entityId));
    expect(states).toContainEqual({ status: "applied", active: false });
    const replay = await approvePhotoGroupProposals(
      ctx.db,
      buildCrudServices,
      { runId: run.shortcode, groupKeys: [draft.groupKey] },
      ctx.actor,
    );
    expect(replay.results[0]?.outcome).toBe("replayed");
  });

  it("creates an explicit Brand only at approval and reuses it for the next group", async () => {
    const { run, codes } = await seedRun(2);
    const groups = codes.map((code, index) => ({
      ...createGroup(`new-brand-${index}`, [code]),
      product: {
        kind: "create" as const,
        create: {
          name: `Synthetic branded item ${index}`,
          brandId: null,
          brandCreate: { name: "Synthetic Fresh Label" },
        },
      },
    }));
    const saved = await proposePhotoGroups(
      ctx.db,
      buildCrudServices,
      { runId: run.shortcode, groups },
      "member",
    );
    expect(saved.proposals[0]?.product).toMatchObject({
      create: { brandCreate: { name: "Synthetic Fresh Label" } },
    });
    expect(
      await getDb(ctx.db)
        .select({ id: vendor.id })
        .from(vendor)
        .where(eq(vendor.name, "Synthetic Fresh Label")),
    ).toHaveLength(0);
    const applied = await approvePhotoGroupProposals(
      ctx.db,
      buildCrudServices,
      { runId: run.shortcode },
      ctx.actor,
    );
    expect(applied.results.map((result) => result.outcome)).toEqual([
      "committed",
      "committed",
    ]);
    const brands = await getDb(ctx.db)
      .select({ id: vendor.id })
      .from(vendor)
      .where(eq(vendor.name, "Synthetic Fresh Label"));
    expect(brands).toHaveLength(1);
    const products = await getDb(ctx.db)
      .select({ brandId: product.brandId })
      .from(product)
      .where(ilike(product.name, "Synthetic branded item %"));
    expect(products).toHaveLength(2);
    expect(products.every((item) => item.brandId === brands[0]?.id)).toBe(true);
  });

  it.each([false, true])(
    "retains shared rejection and explicit reselection for ambiguous=%s",
    async (ambiguous) => {
      const { run, codes } = await seedRun(1);
      const original = await createProductIdentityFixture(
        ctx.db,
        makeProductInput({ name: "Synthetic correction item" }),
        ctx.actor,
      );
      const createdBrand = await createRepoEntity(ctx, "vendor", {
        name: "Synthetic Reviewed Label",
      });
      const brand = createdBrand.output;
      if (ambiguous)
        await createRepoEntity(ctx, "vendor", {
          name: "Synthetic-Reviewed-Label",
        });
      await getDb(ctx.db)
        .insert(aiAnalysis)
        .values({
          entityKind: "image",
          entityId: (
            await getDb(ctx.db)
              .select({ id: image.id })
              .from(image)
              .where(eq(image.shortcode, codes[0]!))
          )[0]!.id,
          feature: "photo-local-analysis",
          model: "synthetic-local",
          promptVersion: "1",
          inputFingerprint: "synthetic-photo-brand",
          result: {
            recognizedText: [
              {
                text: `${brand.name}\nBrand: Synthetic Unknown Label`,
                confidence: 0.95,
              },
            ],
          },
        });
      const draft = {
        ...createGroup("shared-correction", codes),
        images: codes.map((id) => ({
          id: parseShortcodeFor("image", id),
          purpose: "label" as const,
        })),
        product: {
          kind: "existing" as const,
          existingId: parseShortcodeFor("product", original.id),
        },
        review: {
          observedName: "Synthetic correction item",
          unresolvedReason: null,
          stockIntent: "evidence" as const,
        },
      };
      let saved = await proposePhotoGroups(
        ctx.db,
        buildCrudServices,
        { runId: run.shortcode, groups: [draft] },
        "external_agent",
      );
      if (ambiguous)
        saved = await proposePhotoGroups(
          ctx.db,
          buildCrudServices,
          {
            runId: run.shortcode,
            groups: [
              {
                ...draft,
                review: {
                  ...draft.review,
                  productChanges: {
                    brandId: parseShortcodeFor("vendor", brand.id),
                  },
                },
              },
            ],
          },
          "member",
        );
      const suggestion = saved.proposals[0]?.review?.fieldSuggestions?.[0];
      expect(suggestion?.field).toBe("brandId");
      const [pending] = await getDb(ctx.db)
        .select({
          active: suggestionTable.active,
          status: suggestionTable.status,
        })
        .from(suggestionTable)
        .where(eq(suggestionTable.id, suggestion!.id));
      expect(pending).toEqual({ active: false, status: "pending" });
      await proposePhotoGroups(
        ctx.db,
        buildCrudServices,
        {
          runId: run.shortcode,
          groups: [
            {
              ...draft,
              review: {
                ...draft.review,
                productChanges: {
                  brandId: parseShortcodeFor("vendor", brand.id),
                },
                rejectedBrandNames: ["Synthetic Unknown Label"],
              },
            },
          ],
        },
        "member",
        undefined,
        ctx.actor,
      );
      expect(await readSuggestionDecisions(ctx.db, suggestion!.id)).toEqual([]);
      await proposePhotoGroups(
        ctx.db,
        buildCrudServices,
        {
          runId: run.shortcode,
          groups: [
            {
              ...draft,
              review: {
                ...draft.review,
                productChanges: ambiguous
                  ? { brandId: parseShortcodeFor("vendor", brand.id) }
                  : {},
                rejectedBrandNames: [brand.name],
              },
            },
          ],
        },
        "member",
        undefined,
        ctx.actor,
      );
      const [rejected] = await readSuggestionDecisions(ctx.db, suggestion!.id);
      expect(rejected?.verdict).toBe("wrong");
      await expect(
        proposePhotoGroups(
          ctx.db,
          buildCrudServices,
          { runId: run.shortcode, groups: [draft] },
          "external_agent",
          run.dispatchEventId!,
        ),
      ).rejects.toThrow("conflicts with a member-reviewed group");
      const refreshed = await listPhotoGroupProposals(ctx.db, run.shortcode);
      expect(refreshed.proposals[0]?.review?.productChanges).toBeUndefined();
      expect(refreshed.proposals[0]?.review?.rejectedBrandNames).toEqual(
        expect.arrayContaining([brand.name, "Synthetic Unknown Label"]),
      );
      const [unchanged] = await getDb(ctx.db)
        .select({ brandId: product.brandId })
        .from(product)
        .where(eq(product.id, original.entityId));
      expect(unchanged?.brandId).toBeNull();
      const reselected = await proposePhotoGroups(
        ctx.db,
        buildCrudServices,
        {
          runId: run.shortcode,
          groups: [
            {
              ...draft,
              review: {
                ...draft.review,
                productChanges: {
                  brandId: parseShortcodeFor("vendor", brand.id),
                },
                rejectedBrandNames: [brand.name, "Synthetic Unknown Label"],
              },
            },
          ],
        },
        "member",
        undefined,
        ctx.actor,
      );
      const newSuggestion =
        reselected.proposals[0]?.review?.fieldSuggestions?.find(
          (candidate) => candidate.field === "brandId",
        );
      expect(newSuggestion?.id).not.toBe(suggestion?.id);
      const approved = await approvePhotoGroupProposals(
        ctx.db,
        buildCrudServices,
        { runId: run.shortcode },
        ctx.actor,
      );
      expect(approved.results[0]?.outcome).toBe("committed");
      expect(approved.proposals[0]?.review?.fieldSuggestions).toContainEqual(
        newSuggestion,
      );
      const [oldReview] = await getDb(ctx.db)
        .select({ status: suggestionTable.status })
        .from(suggestionTable)
        .where(eq(suggestionTable.id, suggestion!.id));
      expect(oldReview?.status).toBe("rejected");
    },
  );

  it.each([
    { text: "BUCK MASON\nMADE IN USA", role: "label" as const, prefill: true },
    { text: "Purchased at Buck Mason", role: "label" as const, prefill: false },
    { text: "BM", role: "label" as const, prefill: false },
    { text: "Brand: Buck Mason", role: "item" as const, prefill: true },
  ])(
    "only prefills marketed Brand label evidence ($text)",
    async ({ text, role, prefill }) => {
      const { run, codes } = await seedRun(1);
      const brand = await createRepoEntity(ctx, "vendor", {
        name: "Buck Mason",
        aliases: ["BM"],
      });
      const [photo] = await getDb(ctx.db)
        .select({ id: image.id })
        .from(image)
        .where(eq(image.shortcode, codes[0]!));
      await getDb(ctx.db)
        .insert(aiAnalysis)
        .values({
          entityKind: "image",
          entityId: photo!.id,
          feature: "photo-local-analysis",
          model: "synthetic-local",
          promptVersion: "1",
          inputFingerprint: "synthetic-marketed-label",
          result: { recognizedText: [{ text, confidence: 0.95 }] },
        });
      const saved = await proposePhotoGroups(
        ctx.db,
        buildCrudServices,
        {
          runId: run.shortcode,
          groups: [
            {
              ...createGroup("marketed-label", codes),
              images: [
                { id: parseShortcodeFor("image", codes[0]!), purpose: role },
              ],
            },
          ],
        },
        "external_agent",
      );
      const group = saved.proposals[0]!;
      expect(
        group.brandEvidence?.flatMap((evidence) =>
          evidence.matches.map((match) => match.id),
        ),
      ).toContain(brand.output.id);
      expect(group.product.kind).toBe("create");
      if (group.product.kind !== "create")
        throw new Error("fixture expected a new Product draft");
      expect(group.product.create.brandId).toBe(
        prefill ? brand.output.id : null,
      );
    },
  );

  it.each(["unbranded", "alias", "new"])(
    "resolves approved Brand names through the shared owner and retains field receipts (%s)",
    async (kind) => {
      const { run, codes } = await seedRun(1);
      const original = await createProductIdentityFixture(
        ctx.db,
        makeProductInput({ name: "Synthetic resolver item" }),
        ctx.actor,
      );
      const known = await createRepoEntity(ctx, "vendor", {
        name: "Synthetic Canonical Label",
        aliases: ["Synthetic Alias Label"],
      });
      const name =
        kind === "unbranded"
          ? "unbranded"
          : kind === "alias"
            ? "Synthetic Alias Label"
            : "Synthetic Created Label";
      const draft: PhotoGroupProposalGroup = {
        ...createGroup("brand-resolution", codes),
        product: {
          kind: "existing",
          existingId: parseShortcodeFor("product", original.id),
        },
        review: {
          observedName: "Synthetic resolver item",
          unresolvedReason: null,
          stockIntent: "evidence",
          productChanges: { brandId: null, brandCreate: { name } },
        },
      };
      await expect(
        proposePhotoGroups(
          ctx.db,
          buildCrudServices,
          {
            runId: run.shortcode,
            groups: [
              {
                ...draft,
                review: {
                  ...draft.review!,
                  productChanges: {
                    brandId: parseShortcodeFor("vendor", known.output.id),
                    brandCreate: { name },
                  },
                },
              },
            ],
          },
          "member",
        ),
      ).rejects.toThrow("Choose an existing Brand or create one, not both");
      await proposePhotoGroups(
        ctx.db,
        buildCrudServices,
        { runId: run.shortcode, groups: [draft] },
        "member",
      );
      const approved = await approvePhotoGroupProposals(
        ctx.db,
        buildCrudServices,
        { runId: run.shortcode },
        ctx.actor,
      );
      expect(approved.results[0]?.outcome).toBe("committed");
      const refs = approved.proposals[0]?.review?.fieldSuggestions;
      expect(refs?.map((ref) => ref.field)).toEqual(["brandId"]);
      const [saved] = await getDb(ctx.db)
        .select({
          brandId: product.brandId,
          name: vendor.name,
          systemKey: vendor.systemKey,
        })
        .from(product)
        .innerJoin(vendor, eq(vendor.id, product.brandId))
        .where(eq(product.id, original.entityId));
      expect(saved?.name).toBe(
        kind === "unbranded"
          ? "Generic / Unbranded"
          : kind === "alias"
            ? known.output.name
            : name,
      );
      expect(saved?.systemKey).toBe(
        kind === "unbranded" ? "generic-unbranded" : null,
      );
      expect(
        await getDb(ctx.db)
          .select({ id: vendor.id })
          .from(vendor)
          .where(eq(vendor.name, name)),
      ).toHaveLength(kind === "new" ? 1 : 0);
      const [receipt] = await getDb(ctx.db)
        .select({ status: suggestionTable.status })
        .from(suggestionTable)
        .where(eq(suggestionTable.id, refs![0]!.id));
      expect(receipt?.status).toBe("applied");
      const [photoReceipt] = await getDb(ctx.db)
        .select({ receipt: photoRunImage.commitReceipt })
        .from(photoRunImage)
        .where(eq(photoRunImage.runId, run.id));
      expect(photoReceipt?.receipt).toMatchObject({ fieldSuggestions: refs });
      const replay = await approvePhotoGroupProposals(
        ctx.db,
        buildCrudServices,
        { runId: run.shortcode, groupKeys: [draft.groupKey] },
        ctx.actor,
      );
      expect(replay.results[0]?.outcome).toBe("replayed");
      expect(replay.proposals[0]?.review?.fieldSuggestions).toEqual(refs);
    },
  );

  it.each([{ createBrand: true, changePhoto: true }])(
    "refuses stale review inputs after a sibling draft save (create Brand: $createBrand, change photo: $changePhoto)",
    async ({ createBrand, changePhoto }) => {
      const { run, codes } = await seedRun(1);
      const original = await createProductIdentityFixture(
        ctx.db,
        makeProductInput({ name: "Synthetic stale review item" }),
        ctx.actor,
      );
      const proposed = await createRepoEntity(ctx, "vendor", {
        name: "Synthetic proposed label",
      });
      const correction = await createRepoEntity(ctx, "vendor", {
        name: "Synthetic member label",
      });
      const closet = await createLocationFixture(
        ctx.db,
        makeLocationInput({
          name: "Synthetic stale review closet",
          parentId: TEST_HOME_SHORTCODE,
        }),
        ctx.actor,
      );
      const draft: PhotoGroupProposalGroup = {
        ...createGroup("stale-brand", codes),
        product: {
          kind: "existing",
          existingId: parseShortcodeFor("product", original.id),
        },
        review: {
          observedName: "Synthetic stale review item",
          unresolvedReason: null,
          stockIntent: "receive",
          productChanges: createBrand
            ? {
                brandId: null,
                brandCreate: { name: "Synthetic not yet created label" },
              }
            : { brandId: parseShortcodeFor("vendor", proposed.output.id) },
        },
        inventory: {
          locationId: parseShortcodeFor("location", closet.id),
          quantity: 1,
        },
      };
      const first = await proposePhotoGroups(
        ctx.db,
        buildCrudServices,
        { runId: run.shortcode, groups: [draft] },
        "member",
      );
      const originalReview = first.proposals[0]?.review;
      if (changePhoto) {
        const [photo] = await getDb(ctx.db)
          .select({ id: image.id })
          .from(image)
          .where(eq(image.shortcode, codes[0]!));
        await getDb(ctx.db)
          .insert(aiAnalysis)
          .values({
            entityKind: "image",
            entityId: photo!.id,
            feature: "photo-local-analysis",
            model: "synthetic-local",
            promptVersion: "1",
            inputFingerprint: "synthetic-revised-label",
            result: {
              recognizedText: [
                { text: "Synthetic revised label evidence", confidence: 0.95 },
              ],
            },
          });
      } else {
        await executeEntityAs(kernelCtx(ctx), "update", {
          entity: "product",
          id: original.id,
          data: { brandId: correction.output.id },
        });
      }
      const saved = await proposePhotoGroups(
        ctx.db,
        buildCrudServices,
        {
          runId: run.shortcode,
          groups: [
            {
              ...draft,
              review: {
                ...draft.review!,
                productChanges: {
                  ...draft.review?.productChanges,
                  notes: "Sibling photo draft notes",
                },
              },
            },
          ],
        },
        "member",
      );
      expect(
        saved.proposals[0]?.review?.fieldSuggestions?.filter(
          (suggestion) => suggestion.field === "brandId",
        ),
      ).toEqual(
        originalReview?.fieldSuggestions?.filter(
          (suggestion) => suggestion.field === "brandId",
        ),
      );
      expect(saved.proposals[0]?.review?.brandCreateInputFingerprint).toBe(
        originalReview?.brandCreateInputFingerprint,
      );
      const applied = await approvePhotoGroupProposals(
        ctx.db,
        buildCrudServices,
        { runId: run.shortcode },
        ctx.actor,
      );
      expect(applied.results[0]).toMatchObject({
        outcome: "failed",
        error: expect.stringContaining("inputs changed"),
      });
      const [current] = await getDb(ctx.db)
        .select({ brandId: product.brandId, notes: product.notes })
        .from(product)
        .where(eq(product.id, original.entityId));
      expect(current).toEqual({
        brandId: changePhoto ? null : correction.entityId,
        notes: null,
      });
      expect(
        await getDb(ctx.db)
          .select({ id: inventoryEntry.id })
          .from(inventoryEntry)
          .where(eq(inventoryEntry.productId, original.entityId)),
      ).toHaveLength(0);
      const [photo] = await getDb(ctx.db)
        .select({ state: photoRunImage.state })
        .from(photoRunImage)
        .where(eq(photoRunImage.runId, run.id));
      expect(photo?.state).toBe("pending");
      expect(
        await getDb(ctx.db)
          .select({ id: vendor.id })
          .from(vendor)
          .where(eq(vendor.name, "Synthetic not yet created label")),
      ).toHaveLength(0);
    },
  );

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
    const original = await createProductIdentityFixture(
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
    await proposePhotoGroups(ctx.db, buildCrudServices, {
      runId: run.shortcode,
      groups: [draft],
    });
    const failed = await approvePhotoGroupProposals(
      ctx.db,
      buildCrudServices,
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
    await proposePhotoGroups(ctx.db, buildCrudServices, {
      runId: run.shortcode,
      groups: [
        { ...draft, inventory: { ...draft.inventory!, ownerPartyId: null } },
      ],
    });
    expect(
      (
        await approvePhotoGroupProposals(
          ctx.db,
          buildCrudServices,
          { runId: run.shortcode },
          ctx.actor,
        )
      ).results[0]?.outcome,
    ).toBe("committed");
  });

  // A settlement write failure must roll back Product, photos, stock and confirmation together.
  it("rolls back settlement failure and applies exactly once on retry", async () => {
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
    await proposePhotoGroups(ctx.db, buildCrudServices, {
      runId: run.shortcode,
      groups: [draft],
    });
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
        buildCrudServices,
        { runId: run.shortcode },
        ctx.actor,
      );
      expect(failed.results[0]).toMatchObject({
        outcome: "failed",
        error: expect.stringContaining("PhotoGroupProposal"),
      });
      expect((await readRow(run.id, "settlement"))?.state).toBe("proposed");
      expect(
        (await readRow(run.id, "settlement"))?.review?.confirmation,
      ).toBeNull();
      expect(
        await database
          .select({ state: photoRunImage.state })
          .from(photoRunImage)
          .where(eq(photoRunImage.runId, run.id)),
      ).toEqual([{ state: "pending" }]);
      expect(
        await database
          .select()
          .from(product)
          .where(
            eq(
              product.name,
              draft.product.kind === "create" ? draft.product.create.name : "",
            ),
          ),
      ).toHaveLength(0);
      const retry = await approvePhotoGroupProposals(
        ctx.db,
        buildCrudServices,
        { runId: run.shortcode },
        ctx.actor,
      );
      expect(retry.results[0]?.outcome).toBe("committed");
      const replay = await approvePhotoGroupProposals(
        ctx.db,
        buildCrudServices,
        { runId: run.shortcode, groupKeys: ["settlement"] },
        ctx.actor,
      );
      expect(replay.results[0]?.outcome).toBe("replayed");
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
        proposePhotoGroups(ctx.db, buildCrudServices, {
          runId: run.shortcode,
          groups: [group],
        }),
      ).rejects.toThrow(error);
      await expect(
        commitPhotoGroup(
          ctx.db,
          buildCrudServices,
          { ...group, runId: run.shortcode },
          ctx.actor,
        ),
      ).rejects.toThrow(error);
    },
  );

  it("saves an incomplete receive draft but refuses to apply it", async () => {
    const { run, codes } = await seedRun(1);
    const draft = createGroup(
      "incomplete",
      codes,
      "Synthetic incomplete receive",
      "receive",
    );
    const saved = await proposePhotoGroups(ctx.db, buildCrudServices, {
      runId: run.shortcode,
      groups: [draft],
    });
    expect(saved.proposals[0]?.review?.stockIntent).toBe("receive");
    const applied = await approvePhotoGroupProposals(
      ctx.db,
      buildCrudServices,
      { runId: run.shortcode },
      ctx.actor,
    );
    expect(applied.results[0]).toMatchObject({
      outcome: "failed",
      error: expect.stringMatching(/receive decision requires Inventory/i),
    });
    await expect(
      commitPhotoGroup(
        ctx.db,
        buildCrudServices,
        { ...draft, runId: run.shortcode },
        ctx.actor,
      ),
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
    await proposePhotoGroups(ctx.db, buildCrudServices, {
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
    const same = await chooseExistingProductForPhotoGroup(
      ctx.db,
      buildCrudServices,
      {
        runId: run.shortcode,
        groupKey: "variant",
        productId: first.id,
      },
    );
    expect(same.proposals[0]?.review?.productChanges).toEqual({
      notes: "Reviewed first variant",
    });
    expect(same.proposals[0]?.inventory?.existingEntryId).toBe(stock.id);
    const changed = await chooseExistingProductForPhotoGroup(
      ctx.db,
      buildCrudServices,
      {
        runId: run.shortcode,
        groupKey: "variant",
        productId: second.id,
      },
    );
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
          buildCrudServices,
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

  it("rejects a stale selected batch before committing any group", async () => {
    const { run, codes } = await seedRun(2);
    await proposePhotoGroups(ctx.db, buildCrudServices, {
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
      approvePhotoGroupProposals(ctx.db, buildCrudServices, request, ctx.actor),
    ).rejects.toThrow("Photo group review changed");
    expect(
      (await listPhotoGroupProposals(ctx.db, run.shortcode)).proposals.map(
        (proposal) => proposal.state,
      ),
    ).toEqual(["proposed", "proposed"]);
  });

  it("keeps photo roles and evidence when a reviewer selects an existing product", async () => {
    const { run, codes } = await seedRun(2);
    const existing = await createProductIdentityFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic Canvas Shirt" }),
      ctx.actor,
    );
    await proposePhotoGroups(ctx.db, buildCrudServices, {
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

    const chosen = await chooseExistingProductForPhotoGroup(
      ctx.db,
      buildCrudServices,
      {
        runId: run.shortcode,
        groupKey: "shirt",
        productId: existing.id,
      },
    );
    const group = chosen.proposals.find((item) => item.groupKey === "shirt");
    expect(group?.product.kind).toBe("existing");
    expect(group?.images).toEqual([{ id: codes[0], purpose: "item" }]);
    expect(group?.skip).toEqual([{ id: codes[1], reason: "Duplicate angle" }]);
    expect(group?.evidence).toBe("One shirt with a duplicate photo");
    expect(group?.review).toMatchObject({
      observedName: "Synthetic observed shirt",
      unresolvedReason: "Choose the exact size",
      stockIntent: "counted",
    });

    await resolvePhotoGroupConcern(
      ctx.db,
      { runId: run.shortcode, groupKey: "shirt", reply: "Checked the size" },
      ctx.actor,
    );
    const approved = await approvePhotoGroupProposals(
      ctx.db,
      buildCrudServices,
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
          buildCrudServices,
          {
            runId: run.shortcode,
            groupKey: "direct",
            images: [
              { id: parseShortcodeFor("image", codes[0]!), purpose: "item" },
            ],
            product: { kind: "create", create: { name: "Direct Commit Item" } },
            review: {
              observedName: "Direct Commit Item",
              unresolvedReason: null,
              stockIntent: "evidence",
            },
          },
          ctx.actor,
        );
      }
      await expect(
        proposePhotoGroups(ctx.db, buildCrudServices, {
          runId: run.shortcode,
          groups: groups(codes, foreign.shortcode),
        }),
      ).rejects.toThrow(error);
      expect(await readRow(run.id, "a")).toBeUndefined();
    });

    it("refuses an image already held by another live proposed group", async () => {
      const { run, codes } = await seedRun(2);
      await proposePhotoGroups(ctx.db, buildCrudServices, {
        runId: run.shortcode,
        groups: [createGroup("a", [codes[0]!])],
      });
      await expect(
        proposePhotoGroups(ctx.db, buildCrudServices, {
          runId: run.shortcode,
          groups: [createGroup("b", [codes[0]!, codes[1]!])],
        }),
      ).rejects.toThrow(/appears in both group a and group b/);
    });

    it("replaces a proposed group by groupKey but leaves a committed one untouched", async () => {
      const { run, codes } = await seedRun(3);
      await proposePhotoGroups(ctx.db, buildCrudServices, {
        runId: run.shortcode,
        groups: [
          createGroup("a", [codes[0]!], "Synthetic Jacket"),
          createGroup("b", [codes[1]!], "Synthetic Scarf"),
        ],
      });
      await approvePhotoGroupProposals(
        ctx.db,
        buildCrudServices,
        { runId: run.shortcode, groupKeys: ["a"] },
        ctx.actor,
      );
      const committedBefore = await readRow(run.id, "a");

      const result = await proposePhotoGroups(ctx.db, buildCrudServices, {
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
    await proposePhotoGroups(ctx.db, buildCrudServices, {
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
      buildCrudServices,
      { runId: run.shortcode },
      ctx.actor,
    );
    const second = await approvePhotoGroupProposals(
      ctx.db,
      buildCrudServices,
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
    const existing = await createProductIdentityFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic Linen Shirt" }),
      ctx.actor,
    );
    await proposePhotoGroups(ctx.db, buildCrudServices, {
      runId: run.shortcode,
      groups: [createGroup("shirt", codes, "synthetic linen shirt")],
    });

    const conflicted = await approvePhotoGroupProposals(
      ctx.db,
      buildCrudServices,
      { runId: run.shortcode },
      ctx.actor,
    );
    expect(conflicted.results).toEqual([
      { groupKey: "shirt", outcome: "conflict" },
    ]);
    const [view] = conflicted.proposals;
    expect(view?.state).toBe("proposed");
    expect(view?.conflict?.map((entry) => entry.id)).toEqual([existing.id]);

    await proposePhotoGroups(ctx.db, buildCrudServices, {
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
      buildCrudServices,
      { runId: run.shortcode },
      ctx.actor,
    );
    expect(approved.results).toEqual([
      { groupKey: "shirt", outcome: "committed" },
    ]);
    expect(approved.proposals[0]?.committedProduct?.id).toBe(existing.id);
  });

  it("discards a group by skipping its images, creating no Product, and lets the run complete", async () => {
    const { run, codes } = await seedRun(2);
    await proposePhotoGroups(ctx.db, buildCrudServices, {
      runId: run.shortcode,
      groups: [
        createGroup("keep", [codes[0]!], "Synthetic Keeper"),
        createGroup("junk", [codes[1]!], "Synthetic Blur"),
      ],
    });
    await approvePhotoGroupProposals(
      ctx.db,
      buildCrudServices,
      { runId: run.shortcode, groupKeys: ["keep"] },
      ctx.actor,
    );

    const result = await discardPhotoGroupProposal(
      ctx.db,
      buildCrudServices,
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
    const loser = await createProductIdentityFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic Tote Duplicate" }),
      ctx.actor,
    );
    const keeper = await createProductIdentityFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic Tote" }),
      ctx.actor,
    );
    await proposePhotoGroups(ctx.db, buildCrudServices, {
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
    await proposePhotoGroups(ctx.db, buildCrudServices, {
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

  // Regression: deleting a run photo hard-deletes its PhotoRunImage but not
  // the id in the proposal's JSON, and every reader threw "left its run" —
  // breaking the review page, approve-all, and discard.
  it("tolerates a proposal photo deleted after proposing: lists, approves and discards without it", async () => {
    const { run, codes } = await seedRun(4);
    await proposePhotoGroups(ctx.db, buildCrudServices, {
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
      buildCrudServices,
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
      buildCrudServices,
      { runId: run.shortcode, groupKey: "gone" },
      ctx.actor,
    );
    const done = await discardPhotoGroupProposal(
      ctx.db,
      buildCrudServices,
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
    const initial = await proposePhotoGroups(ctx.db, buildCrudServices, {
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
          buildCrudServices,
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
        await proposePhotoGroups(holder, buildCrudServices, {
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
      buildCrudServices,
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
});
