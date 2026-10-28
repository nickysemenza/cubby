import { buildKernelContext } from "tooling/scenarios/context";
import { TEST_HOME_ID, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { refreshSearchDocument } from "~/server/generic/search/repo/search-document";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";
import { systemPrincipal } from "~/server/http/authenticate";
import { entityInspectorHealthHandlers } from "~/server/operation-runtime/entity-runtime.server";
import {
  createLocationFixture,
  createInventoryFixture,
  createProductFixture,
  makeProductInput,
  makeLocationInput,
} from "~/server/testing/repo.fixtures";

import { findSearchHits } from "./search.service";

describe("search labels and location paths", () => {
  const ctx = withTestDb();

  // Current garden notes must not fall through a retired observation/move label.
  it("indexes a garden note with its declared kind label", async () => {
    const entry = await insertWithShortcode(ctx.db, "gardenEntry", {
      kind: "note",
      observedOn: "2026-10-06",
      locationId: TEST_HOME_ID,
      notes: "Synthetic garden journal",
    });
    await refreshSearchDocument(ctx.db, "gardenEntry", entry.id);
    const hits = await findSearchHits(ctx.db, {
      query: "Synthetic garden journal",
      entityKinds: ["gardenEntry"],
      limit: 10,
    });
    expect(hits.find((item) => item.id === entry.shortcode)?.title).toBe(
      "Note · 2026-10-06 · Home",
    );
    const health =
      await entityInspectorHealthHandlers.operations.inspectorHealth({
        data: null,
        request: {
          principal: systemPrincipal(
            buildKernelContext(ctx.db, ctx.actor.userId),
          ),
          headers: new Headers(),
          signal: new AbortController().signal,
        },
      });
    expect(health).toMatchObject({
      ok: true,
      data: { search: { gardenEntry: { documents: 1, embeddings: 0 } } },
    });
  });

  it("returns a preformatted root-first path for a typed location hit", async () => {
    const parent = await createLocationFixture(
      ctx.db,
      makeLocationInput({ name: "Synthetic instrument room" }),
      ctx.actor,
    );
    const child = await createLocationFixture(
      ctx.db,
      makeLocationInput({
        name: "Synthetic brass shelf",
        parentId: parent.id,
        aliases: ["Synthetic\\"],
      }),
      ctx.actor,
    );
    await refreshSearchDocument(ctx.db, "location", child.entityId);

    const hits = await findSearchHits(ctx.db, {
      query: "Synthetic brass shelf",
      entityKinds: ["location"],
      limit: 10,
    });
    const hit = hits.find((item) => item.id === child.id);
    expect(hit?.facts).toEqual([
      "Home › Synthetic instrument room › Synthetic brass shelf",
    ]);
    const aliasHits = await findSearchHits(ctx.db, {
      query: "Synthetic\\",
      entityKinds: ["location"],
      limit: 10,
    });
    expect(aliasHits.find((item) => item.id === child.id)).toMatchObject({
      matchKind: "exact",
      matchField: "alias",
      matchReason: "Exact alias match",
    });
  });
  it("hydrates Product and inventory facts from current stock rather than indexed subtitles", async () => {
    const prod = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic facts wrench" }),
      ctx.actor,
    );
    const shelf = await createLocationFixture(
      ctx.db,
      makeLocationInput({ name: "Synthetic facts drawer" }),
      ctx.actor,
    );
    const inventory = await createInventoryFixture(
      ctx.db,
      {
        productId: prod.entityId,
        locationId: shelf.entityId,
        amount: { value: 2.5, unit: "each" },
      },
      ctx.actor,
    );
    await refreshSearchDocument(ctx.db, "product", prod.entityId);
    await refreshSearchDocument(ctx.db, "inventory", inventory.entityId);
    const hits = await findSearchHits(ctx.db, {
      query: "Synthetic facts wrench",
      entityKinds: ["product", "inventory"],
      limit: 10,
    });
    expect(hits.find((hit) => hit.id === prod.id)?.facts).toEqual([
      "Home › Synthetic facts drawer",
      "2.5 on hand",
    ]);
    expect(hits.find((hit) => hit.id === inventory.id)?.facts).toEqual([
      "Home › Synthetic facts drawer",
    ]);
  });
});
