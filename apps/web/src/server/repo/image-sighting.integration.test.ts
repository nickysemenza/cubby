import { entityRefKey } from "@cubby/schemas/entity";
import type { LedgerPartyShortcode } from "@cubby/schemas/identifiers";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { image as imageTable } from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import { createDevice } from "~/server/repo/device";
import { getImageById } from "~/server/repo/image";
import {
  createImageSighting,
  deleteImageSightings,
  getImageSightingByID,
  listImageSightings,
  updateImageSighting,
  upsertImageSightingPage,
} from "~/server/repo/image-sighting";
import {
  createLedgerParty,
  mergeLedgerParties,
} from "~/server/repo/ledger-party";
import { setMemberLoginParty } from "~/server/repo/member-login";
import { createImageFixture } from "~/server/repo/repo.fixtures";
import { getR2PublicUrl } from "~/server/utils/r2-public-url";

import {
  resolveEntityDisplayImages,
  withUniversalEntityMedia,
} from "./entity-display-image";

describe("image-sighting", () => {
  const ctx = withTestDb();

  const makeMember = async (name: string) => {
    const party = await createLedgerParty(
      ctx.db,
      { name, kind: "member", notes: null },
      ctx.actor,
    );
    return party.output.id;
  };

  const makeDevice = async (
    name: string,
    ledgerPartyId: LedgerPartyShortcode,
  ) => {
    const device = await createDevice(
      ctx.db,
      {
        installationId: crypto.randomUUID(),
        name,
        platform: "ios",
        appVersion: null,
        osVersion: null,
        automaticWork: true,
        remotePaused: false,
        ledgerPartyId,
      },
      ctx.actor,
    );
    return device.output.id;
  };

  it("shows the related image in list, detail, and compact entity previews", async () => {
    const image = await createImageFixture(ctx.db, "sighting-preview");
    const member = await makeMember("Preview member");
    const reporter = await makeDevice("Preview device", member);
    const sighting = await createImageSighting(
      ctx.db,
      {
        imageId: image.shortcode,
        ledgerPartyId: member,
        deviceId: reporter,
        assetKey: "SYNTHETIC-PREVIEW-ASSET",
        sourceType: "userLibrary",
        mediaSubtypes: [],
        hasAdjustments: false,
        matchKind: "import",
        observedAt: new Date("2026-06-01T10:00:00Z"),
      },
      ctx.actor,
    );

    const expectedURL = getR2PublicUrl(image.key);
    const list = await withUniversalEntityMedia(
      ctx.db,
      "imageSighting",
      [{ id: sighting.output.id }],
      false,
    );
    const detail = await withUniversalEntityMedia(
      ctx.db,
      "imageSighting",
      [{ id: sighting.output.id }],
      true,
    );
    expect(list[0]?.displayImages[0]).toMatchObject({
      id: image.shortcode,
      url: expectedURL,
    });
    expect(detail[0]?.displayImages).toEqual(list[0]?.displayImages);
    const compact = await resolveEntityDisplayImages(ctx.db, [
      { entityType: "imageSighting", entityId: sighting.entityId },
    ]);
    expect(
      compact.get(entityRefKey("imageSighting", sighting.entityId))?.url,
    ).toBe(expectedURL);

    await getDb(ctx.db)
      .update(imageTable)
      .set({ deletedAt: new Date() })
      .where(eq(imageTable.id, image.id));
    const hidden = await withUniversalEntityMedia(
      ctx.db,
      "imageSighting",
      [{ id: sighting.output.id }],
      false,
    );
    expect(hidden[0]?.displayImages).toEqual([]);
  });

  it("upserts on a repeat report for the same (imageId, ledgerPartyId, assetKey): no error, observation columns replace, shortcode is kept", async () => {
    const image = await createImageFixture(ctx.db, "ana-sunset");
    const ana = await makeMember("Ana");
    const anaPhone = await makeDevice("Ana's Phone", ana);

    const first = await createImageSighting(
      ctx.db,
      {
        imageId: image.shortcode,
        ledgerPartyId: ana,
        deviceId: anaPhone,
        assetKey: "ASSET-SUNSET-1",
        sourceType: "userLibrary",
        mediaSubtypes: [],
        hasAdjustments: false,
        matchKind: "import",
        observedAt: new Date("2026-06-01T10:00:00Z"),
        placeName: "Beach House",
      },
      ctx.actor,
    );

    const second = await createImageSighting(
      ctx.db,
      {
        imageId: image.shortcode,
        ledgerPartyId: ana,
        deviceId: anaPhone,
        assetKey: "ASSET-SUNSET-1",
        sourceType: "userLibrary",
        mediaSubtypes: [],
        hasAdjustments: true,
        matchKind: "import",
        observedAt: new Date("2026-06-02T10:00:00Z"),
        placeName: "Different Beach House",
      },
      ctx.actor,
    );

    expect(second.output.id).toBe(first.output.id);
    expect(second.output.placeName).toBe("Different Beach House");
    expect(second.output.hasAdjustments).toBe(true);

    const { count } = await listImageSightings(
      ctx.db,
      { imageId: [image.shortcode] },
      [],
      { pageIndex: 0, pageSize: 50 },
    );
    expect(count).toBe(1);
  });

  it("rolls back a failed bulk page and replays the same page without duplicates", async () => {
    const image = await createImageFixture(ctx.db, "bulk-retry");
    const member = await makeMember("Synthetic member");
    const reporter = await makeDevice("Synthetic device", member);
    const item = (assetKey: string) => ({
      imageId: image.shortcode,
      ledgerPartyId: member,
      deviceId: reporter,
      assetKey,
      sourceType: "userLibrary" as const,
      mediaSubtypes: [],
      hasAdjustments: false,
      matchKind: "import" as const,
      observedAt: new Date("2026-06-01T10:00:00Z"),
    });
    const page = [item("SYNTHETIC-A"), item("SYNTHETIC-B")];
    await expect(
      upsertImageSightingPage(
        ctx.db,
        [
          page[0]!,
          { ...page[1]!, deviceId: parseShortcodeFor("device", "DEV-9999") },
        ],
        ctx.actor,
      ),
    ).rejects.toThrow("DEV-9999");
    const afterFailure = await listImageSightings(
      ctx.db,
      { imageId: [image.shortcode] },
      [],
      { pageIndex: 0, pageSize: 50 },
    );
    expect(afterFailure.count).toBe(0);
    expect(await upsertImageSightingPage(ctx.db, page, ctx.actor)).toEqual({
      processed: 2,
      created: 2,
    });
    expect(await upsertImageSightingPage(ctx.db, page, ctx.actor)).toEqual({
      processed: 2,
      created: 0,
    });
    const afterRetry = await listImageSightings(
      ctx.db,
      { imageId: [image.shortcode] },
      [],
      { pageIndex: 0, pageSize: 50 },
    );
    expect(afterRetry.count).toBe(2);
  });

  it("one party reporting from two devices with the same synced assetKey upserts to a single row, and derives that party as the capturer", async () => {
    const image = await createImageFixture(ctx.db, "ana-two-devices");
    const ana = await makeMember("Ana");
    const anaPhone = await makeDevice("Ana's Phone", ana);
    const anaMac = await makeDevice("Ana's Mac", ana);

    await createImageSighting(
      ctx.db,
      {
        imageId: image.shortcode,
        ledgerPartyId: ana,
        deviceId: anaPhone,
        assetKey: "ASSET-SYNCED-1",
        sourceType: "userLibrary",
        mediaSubtypes: [],
        hasAdjustments: false,
        matchKind: "import",
        observedAt: new Date("2026-06-01T10:00:00Z"),
      },
      ctx.actor,
    );
    await createImageSighting(
      ctx.db,
      {
        imageId: image.shortcode,
        ledgerPartyId: ana,
        deviceId: anaMac,
        assetKey: "ASSET-SYNCED-1",
        sourceType: "userLibrary",
        mediaSubtypes: [],
        hasAdjustments: false,
        matchKind: "import",
        observedAt: new Date("2026-06-01T11:00:00Z"),
      },
      ctx.actor,
    );

    const { count, data } = await listImageSightings(
      ctx.db,
      { imageId: [image.shortcode] },
      [],
      { pageIndex: 0, pageSize: 50 },
    );
    expect(count).toBe(1);
    expect(data[0]!.deviceId).toBe(anaMac);

    const updatedImage = await getImageById(ctx.db, image.id);
    expect(updatedImage.captureAttribution).toBe("derived");
    expect(updatedImage.capturedByPartyId).toBe(ana);
  });

  it("scores multiple parties' sightings: a unique maximum derives, a tie is ambiguous", async () => {
    const scoredImage = await createImageFixture(ctx.db, "ben-vs-ana");
    const ana = await makeMember("Ana");
    const ben = await makeMember("Ben");
    const anaPhone = await makeDevice("Ana's Phone", ana);
    const bensPhone = await makeDevice("Ben's Phone", ben);

    // Ana's sighting carries no location/camera; Ben's carries both, so
    // Ben's score (5) beats Ana's (0) — a unique maximum.
    await createImageSighting(
      ctx.db,
      {
        imageId: scoredImage.shortcode,
        ledgerPartyId: ana,
        deviceId: anaPhone,
        assetKey: "ASSET-SHARED-1",
        sourceType: "userLibrary",
        mediaSubtypes: [],
        hasAdjustments: false,
        matchKind: "import",
        observedAt: new Date("2026-06-01T10:00:00Z"),
      },
      ctx.actor,
    );
    await createImageSighting(
      ctx.db,
      {
        imageId: scoredImage.shortcode,
        ledgerPartyId: ben,
        deviceId: bensPhone,
        assetKey: "ASSET-SHARED-1",
        sourceType: "userLibrary",
        mediaSubtypes: [],
        hasAdjustments: false,
        matchKind: "import",
        observedAt: new Date("2026-06-01T09:00:00Z"),
        location: { lat: 47.6, lng: -122.3 },
        camera: { make: "Apple", model: "iPhone 15 Pro" },
      },
      ctx.actor,
    );

    const scored = await getImageById(ctx.db, scoredImage.id);
    expect(scored.captureAttribution).toBe("derived");
    expect(scored.capturedByPartyId).toBe(ben);

    // A second image where both parties' sightings carry identical evidence
    // (a guest's AirDropped photo both members save) ties, and is ambiguous.
    const tiedImage = await createImageFixture(ctx.db, "guest-airdrop");
    await createImageSighting(
      ctx.db,
      {
        imageId: tiedImage.shortcode,
        ledgerPartyId: ana,
        deviceId: anaPhone,
        assetKey: "ASSET-GUEST-1",
        sourceType: "userLibrary",
        mediaSubtypes: [],
        hasAdjustments: false,
        matchKind: "import",
        observedAt: new Date("2026-06-03T10:00:00Z"),
      },
      ctx.actor,
    );
    await createImageSighting(
      ctx.db,
      {
        imageId: tiedImage.shortcode,
        ledgerPartyId: ben,
        deviceId: bensPhone,
        assetKey: "ASSET-GUEST-1",
        sourceType: "userLibrary",
        mediaSubtypes: [],
        hasAdjustments: false,
        matchKind: "import",
        observedAt: new Date("2026-06-03T10:05:00Z"),
      },
      ctx.actor,
    );

    const tied = await getImageById(ctx.db, tiedImage.id);
    expect(tied.captureAttribution).toBe("ambiguous");
    expect(tied.capturedByPartyId).toBeNull();
  });

  it("re-derives when a sighting is deleted, retracting the attribution it produced", async () => {
    const image = await createImageFixture(ctx.db, "solo-sighting");
    const ana = await makeMember("Ana");
    const anaPhone = await makeDevice("Ana's Phone", ana);

    const sighting = await createImageSighting(
      ctx.db,
      {
        imageId: image.shortcode,
        ledgerPartyId: ana,
        deviceId: anaPhone,
        assetKey: "ASSET-SOLO-1",
        sourceType: "userLibrary",
        mediaSubtypes: [],
        hasAdjustments: false,
        matchKind: "import",
        observedAt: new Date("2026-06-01T10:00:00Z"),
      },
      ctx.actor,
    );

    const derived = await getImageById(ctx.db, image.id);
    expect(derived.captureAttribution).toBe("derived");
    expect(derived.capturedByPartyId).toBe(ana);

    await deleteImageSightings(ctx.db, [sighting.output.id], ctx.actor);

    const reverted = await getImageById(ctx.db, image.id);
    expect(reverted.captureAttribution).toBe("none");
    expect(reverted.capturedByPartyId).toBeNull();
    expect(reverted.source).toBe("own");
  });

  it("moves a merged member's reported sightings to the surviving party", async () => {
    const image = await createImageFixture(ctx.db, "merge-target");
    const keep = await makeMember("Kept Member");
    const merged = await makeMember("Merged-away Member");
    const device = await makeDevice("Shared Device", merged);

    const sighting = await createImageSighting(
      ctx.db,
      {
        imageId: image.shortcode,
        ledgerPartyId: merged,
        deviceId: device,
        assetKey: "ASSET-MERGE-1",
        sourceType: "userLibrary",
        mediaSubtypes: [],
        hasAdjustments: false,
        matchKind: "import",
        observedAt: new Date("2026-06-01T10:00:00Z"),
      },
      ctx.actor,
    );
    expect(
      (await getImageSightingByID(ctx.db, sighting.entityId)).ledgerPartyId,
    ).toBe(merged);

    await mergeLedgerParties(
      ctx.db,
      { keepId: keep, mergeIds: [merged] },
      ctx.actor,
    );

    expect(
      (await getImageSightingByID(ctx.db, sighting.entityId)).ledgerPartyId,
    ).toBe(keep);
  });

  it("refuses to resolve an owner from an acting login with no linked member", async () => {
    const image = await createImageFixture(ctx.db, "unlinked-login");
    const someone = await makeMember("Someone Else");
    const device = await makeDevice("Unlinked Device", someone);

    await expect(
      createImageSighting(
        ctx.db,
        {
          imageId: image.shortcode,
          // ledgerPartyId omitted: resolved from the acting login, which is
          // not linked to any member in this test's fixtures.
          deviceId: device,
          assetKey: "ASSET-UNLINKED-1",
          sourceType: "userLibrary",
          mediaSubtypes: [],
          hasAdjustments: false,
          matchKind: "import",
          observedAt: new Date("2026-06-01T10:00:00Z"),
        },
        ctx.actor,
      ),
    ).rejects.toThrow(/Settings → Member logins/);
  });

  it("resolves an omitted owner from the acting login when it IS linked", async () => {
    const image = await createImageFixture(ctx.db, "linked-login");
    const self = await makeMember("Acting Member");
    await setMemberLoginParty(ctx.db, ctx.actor.userId, self, ctx.actor);
    const device = await makeDevice("Linked Device", self);

    const sighting = await createImageSighting(
      ctx.db,
      {
        imageId: image.shortcode,
        deviceId: device,
        assetKey: "ASSET-LINKED-1",
        sourceType: "userLibrary",
        mediaSubtypes: [],
        hasAdjustments: false,
        matchKind: "import",
        observedAt: new Date("2026-06-01T10:00:00Z"),
      },
      ctx.actor,
    );
    expect(sighting.output.ledgerPartyId).toBe(self);
  });

  it("updates through the generic kernel path (placeName/capturedAt) and re-derives", async () => {
    const image = await createImageFixture(ctx.db, "update-path");
    const ana = await makeMember("Ana");
    const anaPhone = await makeDevice("Ana's Phone", ana);

    const created = await createImageSighting(
      ctx.db,
      {
        imageId: image.shortcode,
        ledgerPartyId: ana,
        deviceId: anaPhone,
        assetKey: "ASSET-UPDATE-1",
        sourceType: "userLibrary",
        mediaSubtypes: [],
        hasAdjustments: false,
        matchKind: "import",
        observedAt: new Date("2026-06-01T10:00:00Z"),
      },
      ctx.actor,
    );

    const updated = await updateImageSighting(
      ctx.db,
      created.output.id,
      { placeName: "Lake House" },
      ctx.actor,
    );
    expect(updated.output.placeName).toBe("Lake House");
  });
});
