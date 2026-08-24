import { unsafeImageShortcode } from "@cubby/schemas/identifiers";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { listBackgroundBatches } from "~/server/repo/background-jobs";
import { createUploadedImageRecord } from "~/server/repo/image";
import {
  createProductFixture,
  makeLocationInput,
  makeProductInput,
} from "~/server/repo/repo.fixtures";
import { resolveLiveShortcode } from "~/server/repo/shortcode-resolver";
import { createTestCaller } from "../trpc";
import { locationRouter } from "./location";
import { problemsRouter } from "./problems";

const kindsForLocation = async (
  db: Parameters<typeof listBackgroundBatches>[0],
  locationId: string,
) =>
  (await listBackgroundBatches(db, 50))
    .filter(
      (b) =>
        (b.metadata as { entity?: { entityId?: string } } | null)?.entity
          ?.entityId === locationId,
    )
    .map((b) => b.kind);

describe("location.create AI-description side-effect", () => {
  const ctx = withTestDb();

  // Regression: creating a location WITH photos used to skip the vision job
  // (only location.update set locationImagesChanged), so it was born with a
  // NULL aiDescription — a permanent "missing AI description" the Problems page
  // flagged. The create handler now passes the flag when photos are attached.
  it("enqueues a description refresh when created with photos", async () => {
    const caller = createTestCaller(locationRouter, ctx.db);
    const image = await createUploadedImageRecord(ctx.db, {
      key: "loc-create-ai.jpg",
      url: "https://example.com/loc-create-ai.jpg",
      filename: "loc-create-ai.jpg",
      contentType: "image/jpeg",
      size: 123,
    });

    const created = await caller.create(
      makeLocationInput({
        name: "Created with photo",
        pendingImageIds: [unsafeImageShortcode(image.shortcode)],
      }),
    );
    const entityId = await resolveLiveShortcode(ctx.db, created.id, "location");

    const kinds = await kindsForLocation(ctx.db, entityId!);
    expect(kinds).toContain("location-ai.description.refresh");
    expect(kinds).toContain("location-ai.inventory.refresh");
  });

  it("does NOT enqueue a description refresh when created without photos", async () => {
    const caller = createTestCaller(locationRouter, ctx.db);
    const created = await caller.create(
      makeLocationInput({ name: "Created no photo", pendingImageIds: [] }),
    );
    const entityId = await resolveLiveShortcode(ctx.db, created.id, "location");

    const kinds = await kindsForLocation(ctx.db, entityId!);
    expect(kinds).not.toContain("location-ai.description.refresh");
    expect(kinds).not.toContain("location-ai.inventory.refresh");
  });

  /**
   * The photo-capture path attaches, then sends a SECOND order-only update to
   * make the new photo the cover (see `useLocationPhotoCapture`). That second
   * call must not re-enqueue vision analysis, or every retake bills twice.
   * `locationImagesChanged` is computed from `pendingImageIds`/`removeImageIds`
   * and deliberately excludes `imageOrder` — this is what pins that.
   */
  it("does NOT re-enqueue analysis for an imageOrder-only update", async () => {
    const caller = createTestCaller(locationRouter, ctx.db);
    const first = await createUploadedImageRecord(ctx.db, {
      key: "loc-order-a.jpg",
      url: "https://example.com/loc-order-a.jpg",
      filename: "loc-order-a.jpg",
      contentType: "image/jpeg",
      size: 123,
    });
    const second = await createUploadedImageRecord(ctx.db, {
      key: "loc-order-b.jpg",
      url: "https://example.com/loc-order-b.jpg",
      filename: "loc-order-b.jpg",
      contentType: "image/jpeg",
      size: 123,
    });
    const created = await caller.create(
      makeLocationInput({
        name: "Reordered only",
        pendingImageIds: [
          unsafeImageShortcode(first.shortcode),
          unsafeImageShortcode(second.shortcode),
        ],
      }),
    );
    const entityId = await resolveLiveShortcode(ctx.db, created.id, "location");
    const visionKinds = async () =>
      (await kindsForLocation(ctx.db, entityId!)).filter((kind) =>
        kind.startsWith("location-ai."),
      );
    const before = await visionKinds();
    expect(before.length).toBeGreaterThan(0);

    await caller.update({
      id: created.id,
      data: {
        imageOrder: [
          unsafeImageShortcode(second.shortcode),
          unsafeImageShortcode(first.shortcode),
        ],
      },
    });

    // Counting only `location-ai.*`: a reorder still refreshes the location's
    // own embedding, which is free — it is the paid vision pass that must not
    // repeat.
    expect(await visionKinds()).toHaveLength(before.length);
  });
});

describe("location.bulkUpdateParent", () => {
  const ctx = withTestDb();

  it("rejects moving a location under its own descendant", async () => {
    const caller = createTestCaller(locationRouter, ctx.db);
    const root = await caller.create(makeLocationInput({ name: "Cycle root" }));
    const child = await caller.create(
      makeLocationInput({ name: "Cycle child", parentId: root.id }),
    );
    const grandchild = await caller.create(
      makeLocationInput({ name: "Cycle grandchild", parentId: child.id }),
    );

    await expect(
      caller.bulkUpdateParent({ ids: [root.id], parentId: grandchild.id }),
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: "Cannot set parent: would create a circular reference",
    });
  });

  /**
   * The sweep is the first caller assembling a mixed batch out of separate
   * scans, and its failure path retries the whole batch — safe only because a
   * location already under `parentId` is a no-op rather than an error. The
   * repo only audits rows whose parent actually changed, so a re-run adds no
   * history either.
   */
  it("tolerates a location already under the target, without auditing it", async () => {
    const caller = createTestCaller(locationRouter, ctx.db);
    const shelf = await caller.create(
      makeLocationInput({ name: "Batch shelf" }),
    );
    const room = await caller.create(makeLocationInput({ name: "Batch room" }));
    const alreadyHere = await caller.create(
      makeLocationInput({ name: "Batch bin here", parentId: shelf.id }),
    );
    const elsewhere = await caller.create(
      makeLocationInput({ name: "Batch bin elsewhere", parentId: room.id }),
    );

    const result = await caller.bulkUpdateParent({
      ids: [alreadyHere.id, elsewhere.id],
      parentId: shelf.id,
    });
    expect(result).toEqual({ updated: 2 });

    const settled = await caller.getByShortcode({ shortcode: elsewhere.id });
    expect(settled?.parent?.id).toBe(shelf.id);

    // Idempotent: the same batch again still resolves rather than throwing.
    await expect(
      caller.bulkUpdateParent({
        ids: [alreadyHere.id, elsewhere.id],
        parentId: shelf.id,
      }),
    ).resolves.toEqual({ updated: 2 });
  });
});

/**
 * A location that IS a Product carries `type = NULL`, and every read path has
 * to survive that.
 *
 * This broke in production after the enum narrowing: five mappers still called
 * `parseWithContext(locationType, row.type, …)`, which takes its value as
 * `unknown` — so a `string | null` flowing into a non-nullable enum was not a
 * type error, just a 500 on the location detail page. A typecheck and 2,231
 * tests all passed. The only thing that catches it is exercising the real
 * endpoints against a real null.
 */
describe("reads tolerate a product-linked location's null type", () => {
  const ctx = withTestDb();

  const seedLinkedLocation = async (name: string) => {
    const product = await createProductFixture(
      ctx.db,
      makeProductInput({ name: `Null Type Tote ${name}` }),
      ctx.actor,
    );
    const caller = createTestCaller(locationRouter, ctx.db);
    const created = await caller.create(
      makeLocationInput({ name, productId: product.id }),
    );
    return { caller, created, product };
  };

  it("returns the location from every roster and detail read", async () => {
    const { caller, created } = await seedLinkedLocation("null-type bin");

    const detail = await caller.getByShortcode({ shortcode: created.id });
    expect(detail?.type).toBeNull();
    expect(detail?.product?.name).toBe("Null Type Tote null-type bin");

    const list = await caller.list({
      filters: {},
      sort: [{ orderBy: "name", direction: "asc" }],
      pagination: { pageIndex: 0, pageSize: 50 },
    });
    expect(list.items.some((l) => l.id === created.id)).toBe(true);

    const options = await caller.options({
      filters: {},
      sort: [{ orderBy: "name", direction: "asc" }],
      pagination: { pageIndex: 0, pageSize: 50 },
    });
    expect(options.items.some((l) => l.id === created.id)).toBe(true);

    const byCodes = await caller.getByShortcodes({ shortcodes: [created.id] });
    expect(byCodes[0]?.type).toBeNull();
  });

  it("returns it as a parent, where the ancestor chain re-parses the type", async () => {
    const { caller, created } = await seedLinkedLocation("null-type parent");
    const child = await caller.create(
      makeLocationInput({ name: "null-type child", parentId: created.id }),
    );

    const detail = await caller.getByShortcode({ shortcode: child.id });
    expect(detail?.parent?.type ?? null).toBeNull();

    const tree = await caller.makeTree();
    expect(JSON.stringify(tree)).toContain("null-type parent");
  });
});

/**
 * The Problems payload types its location rows as a bare `z.string()`, not the
 * enum — which is why the sweep that fixed the enum-typed reads missed them
 * entirely, and the page still 500'd with
 * `staleLocations.N.type: expected string, received null`.
 *
 * Covered here rather than in a unit test because the failure is `strictOutput`
 * validating the assembled payload, which only happens over a real caller.
 */
describe("problems tolerates a product-linked location's null type", () => {
  const ctx = withTestDb();

  it("assembles the fast and coverage payloads", async () => {
    const product = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Problems Null Type Tote" }),
      ctx.actor,
    );
    const locations = createTestCaller(locationRouter, ctx.db);
    // Empty and never-recounted, so it lands in both `emptyLocations` and
    // `staleLocations` — the two sections that broke.
    await locations.create(
      makeLocationInput({
        name: "problems null-type bin",
        productId: product.id,
      }),
    );

    const problems = createTestCaller(problemsRouter, ctx.db);
    const views = await problems.getViews();
    expect(
      views.emptyLocations.some((l) => l.name === "problems null-type bin"),
    ).toBe(true);
    await expect(problems.getFast()).resolves.toBeDefined();
    await expect(problems.getCoverage()).resolves.toBeDefined();
  });
});

/**
 * "Which locations ARE this product", as a query.
 *
 * The component that asked this over the wire is gone — its rows are embedded
 * in the product payload now — but the filter it exercised is still how any
 * caller answers the question, and it is worth pinning on its own.
 *
 * Kept also as the record of why: that component sent `sort: []`, which is a
 * 400 (`sort` is `.min(1)`), so it rendered "No locations are an instance of
 * this product" on a product with fourteen. The failure looked precisely like
 * an answer, and nothing caught it because the section was driven by a live
 * query no test covered.
 */
describe("the product -> locations query", () => {
  const ctx = withTestDb();

  it("returns every location that IS the product", async () => {
    const product = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Serving As Locations Tote" }),
      ctx.actor,
    );
    const caller = createTestCaller(locationRouter, ctx.db);
    for (const name of ["serving bin a", "serving bin b", "serving bin c"]) {
      await caller.create(makeLocationInput({ name, productId: product.id }));
    }
    // A productless location must not leak into the result.
    await caller.create(
      makeLocationInput({ name: "serving decoy", type: "box" }),
    );

    const result = await caller.list({
      filters: { productId: product.id },
      pagination: { pageIndex: 0, pageSize: 100 },
      sort: [{ orderBy: "name", direction: "asc" }],
    });

    expect(result.items).toHaveLength(3);
    expect(result.items.map((l) => l.name).sort()).toEqual([
      "serving bin a",
      "serving bin b",
      "serving bin c",
    ]);
  });

  it("matches nothing for a product no location is", async () => {
    const product = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Unused Tote" }),
      ctx.actor,
    );
    const caller = createTestCaller(locationRouter, ctx.db);
    await caller.create(
      makeLocationInput({ name: "unused decoy", type: "box" }),
    );

    const result = await caller.list({
      filters: { productId: product.id },
      pagination: { pageIndex: 0, pageSize: 100 },
      sort: [{ orderBy: "name", direction: "asc" }],
    });

    // Empty, not "everything" — a requested-but-unmatched id must never widen
    // to an unfiltered query.
    expect(result.items).toHaveLength(0);
  });
});
