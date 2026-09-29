import type { LedgerPartyShortcode } from "@cubby/schemas/identifiers";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import type { ImageSightingRecordItem } from "@cubby/schemas/image-sighting";
import { parseShortcode } from "@cubby/shared";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { auditLog, imageSighting } from "~/server/db/schema";
import { getAuditLog } from "~/server/repo/audit-log";
import { getDb } from "~/server/repo/database-helpers";
import { createDevice } from "~/server/repo/device";
import { resolveEntityIdentity } from "~/server/repo/entity-identity";
import { getImageById, listImageSightings } from "~/server/repo/image";
import { recordImageSightings } from "~/server/repo/image-sighting";
import {
  createLedgerParty,
  mergeLedgerParties,
} from "~/server/repo/ledger-party";
import { setMemberLoginParty } from "~/server/repo/member-login";
import { createImageFixture } from "~/server/repo/repo.fixtures";
import { resolveShortcode } from "~/server/repo/shortcode-resolver";
import { deleteThroughKernel } from "~/server/testing/entity-kernel";

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

  const report = (
    image: { shortcode: ImageSightingRecordItem["imageId"] },
    ledgerPartyId: LedgerPartyShortcode | undefined,
    deviceId: ImageSightingRecordItem["deviceId"],
    assetKey: string,
    overrides: Partial<ImageSightingRecordItem> = {},
  ): ImageSightingRecordItem => ({
    imageId: image.shortcode,
    ledgerPartyId,
    deviceId,
    assetKey,
    sourceType: "userLibrary",
    mediaSubtypes: [],
    hasAdjustments: false,
    matchKind: "import",
    observedAt: new Date("2026-06-01T10:00:00Z"),
    ...overrides,
  });

  const sightingRows = (imageId: string) =>
    getDb(ctx.db)
      .select()
      .from(imageSighting)
      .where(eq(imageSighting.imageId, imageId));

  it("is idempotent on the asset key: a replayed page creates no row and reports the same sightings", async () => {
    const image = await createImageFixture(ctx.db, "bulk-retry");
    const member = await makeMember("Synthetic member");
    const reporter = await makeDevice("Synthetic device", member);
    const page = [
      report(image, member, reporter, "SYNTHETIC-A"),
      report(image, member, reporter, "SYNTHETIC-B"),
    ];

    const first = await recordImageSightings(ctx.db, page, ctx.actor);
    expect(first).toMatchObject({ processed: 2, created: 2 });
    const idsAfterFirst = (await sightingRows(image.id)).map((row) => row.id);

    const second = await recordImageSightings(ctx.db, page, ctx.actor);
    expect(second.processed).toBe(2);
    expect(second.created).toBe(0);
    expect(second.sightings).toEqual(
      first.sightings.map((sighting) => ({ ...sighting, created: false })),
    );
    expect((await sightingRows(image.id)).map((row) => row.id).sort()).toEqual(
      idsAfterFirst.sort(),
    );
  });

  it("replaces the observation columns of a repeat report instead of adding a row", async () => {
    const image = await createImageFixture(ctx.db, "ana-sunset");
    const ana = await makeMember("Ana");
    const anaPhone = await makeDevice("Ana's Phone", ana);

    await recordImageSightings(
      ctx.db,
      [
        report(image, ana, anaPhone, "ASSET-SUNSET-1", {
          placeName: "Beach House",
        }),
      ],
      ctx.actor,
    );
    await recordImageSightings(
      ctx.db,
      [
        report(image, ana, anaPhone, "ASSET-SUNSET-1", {
          hasAdjustments: true,
          observedAt: new Date("2026-06-02T10:00:00Z"),
          placeName: "Different Beach House",
        }),
      ],
      ctx.actor,
    );

    const rows = await sightingRows(image.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      placeName: "Different Beach House",
      hasAdjustments: true,
    });
    const listed = (await listImageSightings(ctx.db, [image.id])).get(image.id);
    expect(listed).toHaveLength(1);
    expect(listed?.[0]).toMatchObject({
      ownerName: "Ana",
      deviceName: "Ana's Phone",
      placeName: "Different Beach House",
    });
  });

  it("rolls back a failed page and replays the same page without duplicates", async () => {
    const image = await createImageFixture(ctx.db, "bulk-rollback");
    const member = await makeMember("Synthetic member");
    const reporter = await makeDevice("Synthetic device", member);
    const page = [
      report(image, member, reporter, "SYNTHETIC-A"),
      report(image, member, reporter, "SYNTHETIC-B"),
    ];
    await expect(
      recordImageSightings(
        ctx.db,
        [
          page[0]!,
          { ...page[1]!, deviceId: parseShortcodeFor("device", "DEV-9999") },
        ],
        ctx.actor,
      ),
    ).rejects.toThrow("DEV-9999");
    expect(await sightingRows(image.id)).toHaveLength(0);
    expect((await recordImageSightings(ctx.db, page, ctx.actor)).created).toBe(
      2,
    );
    expect(await sightingRows(image.id)).toHaveLength(2);
  });

  it("writes the audit history onto the Image, never onto a sighting identity", async () => {
    const image = await createImageFixture(ctx.db, "audit-on-image");
    const member = await makeMember("Synthetic member");
    const reporter = await makeDevice("Synthetic device", member);

    await recordImageSightings(
      ctx.db,
      [report(image, member, reporter, "SYNTHETIC-AUDIT")],
      ctx.actor,
    );

    const [sighting] = await sightingRows(image.id);
    const rows = await getDb(ctx.db)
      .select()
      .from(auditLog)
      .where(eq(auditLog.entityId, image.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ entityKind: "image", action: "update" });
    expect(rows[0]?.changes).toEqual({ sightings: { [sighting!.id]: {} } });

    // The activity feed reads the nested shape as a plain field diff.
    const feed = await getAuditLog(ctx.db, {
      entityKind: "image",
      entityId: image.id,
      limit: 10,
    });
    expect(feed.entries).toHaveLength(1);
    expect(feed.entries[0]).toMatchObject({
      entityKind: "image",
      entityId: image.shortcode,
      changes: { sighting: { to: "reported" } },
    });
  });

  it("no longer resolves an IMS- code: the prefix is unknown and no identity row exists", async () => {
    expect(parseShortcode("IMS-4K7M")).toBeNull();
    expect(await resolveShortcode(ctx.db, "IMS-4K7M")).toBeNull();
    expect(await resolveEntityIdentity(ctx.db, "IMS-4K7M")).toEqual({
      state: "missing",
    });
  });

  it("one party reporting from two devices with the same synced assetKey upserts to a single row, and derives that party as the capturer", async () => {
    const image = await createImageFixture(ctx.db, "ana-two-devices");
    const ana = await makeMember("Ana");
    const anaPhone = await makeDevice("Ana's Phone", ana);
    const anaMac = await makeDevice("Ana's Mac", ana);

    await recordImageSightings(
      ctx.db,
      [report(image, ana, anaPhone, "ASSET-SYNCED-1")],
      ctx.actor,
    );
    await recordImageSightings(
      ctx.db,
      [
        report(image, ana, anaMac, "ASSET-SYNCED-1", {
          observedAt: new Date("2026-06-01T11:00:00Z"),
        }),
      ],
      ctx.actor,
    );

    const listed = (await listImageSightings(ctx.db, [image.id])).get(image.id);
    expect(listed).toHaveLength(1);
    expect(listed?.[0]?.deviceName).toBe("Ana's Mac");

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
    await recordImageSightings(
      ctx.db,
      [
        report(scoredImage, ana, anaPhone, "ASSET-SHARED-1"),
        report(scoredImage, ben, bensPhone, "ASSET-SHARED-1", {
          observedAt: new Date("2026-06-01T09:00:00Z"),
          location: { lat: 47.6, lng: -122.3 },
          camera: { make: "Apple", model: "iPhone 15 Pro" },
        }),
      ],
      ctx.actor,
    );

    const scored = await getImageById(ctx.db, scoredImage.id);
    expect(scored.captureAttribution).toBe("derived");
    expect(scored.capturedByPartyId).toBe(ben);

    // A second image where both parties' sightings carry identical evidence
    // (a guest's AirDropped photo both members save) ties, and is ambiguous.
    const tiedImage = await createImageFixture(ctx.db, "guest-airdrop");
    await recordImageSightings(
      ctx.db,
      [
        report(tiedImage, ana, anaPhone, "ASSET-GUEST-1", {
          observedAt: new Date("2026-06-03T10:00:00Z"),
        }),
        report(tiedImage, ben, bensPhone, "ASSET-GUEST-1", {
          observedAt: new Date("2026-06-03T10:05:00Z"),
        }),
      ],
      ctx.actor,
    );

    const tied = await getImageById(ctx.db, tiedImage.id);
    expect(tied.captureAttribution).toBe("ambiguous");
    expect(tied.capturedByPartyId).toBeNull();
  });

  it("re-derives when a reporting device is deleted, retracting the attribution its sightings produced", async () => {
    const image = await createImageFixture(ctx.db, "solo-sighting");
    const ana = await makeMember("Ana");
    const anaPhone = await makeDevice("Ana's Phone", ana);

    await recordImageSightings(
      ctx.db,
      [report(image, ana, anaPhone, "ASSET-SOLO-1")],
      ctx.actor,
    );
    const derived = await getImageById(ctx.db, image.id);
    expect(derived.captureAttribution).toBe("derived");
    expect(derived.capturedByPartyId).toBe(ana);

    await deleteThroughKernel(ctx.db, ctx.actor, "device", [anaPhone]);

    expect(await sightingRows(image.id)).toHaveLength(0);
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

    await recordImageSightings(
      ctx.db,
      [report(image, merged, device, "ASSET-MERGE-1")],
      ctx.actor,
    );
    expect(
      (await listImageSightings(ctx.db, [image.id])).get(image.id)?.[0]
        ?.ledgerPartyId,
    ).toBe(merged);

    await mergeLedgerParties(
      ctx.db,
      { keepId: keep, mergeIds: [merged] },
      ctx.actor,
    );

    expect(
      (await listImageSightings(ctx.db, [image.id])).get(image.id)?.[0]
        ?.ledgerPartyId,
    ).toBe(keep);
  });

  it("refuses to resolve an owner from an acting login with no linked member", async () => {
    const image = await createImageFixture(ctx.db, "unlinked-login");
    const someone = await makeMember("Someone Else");
    const device = await makeDevice("Unlinked Device", someone);

    await expect(
      // ledgerPartyId omitted: resolved from the acting login, which is not
      // linked to any member in this test's fixtures.
      recordImageSightings(
        ctx.db,
        [report(image, undefined, device, "ASSET-UNLINKED-1")],
        ctx.actor,
      ),
    ).rejects.toThrow(/Settings → Member logins/);
  });

  it("resolves an omitted owner from the acting login when it IS linked", async () => {
    const image = await createImageFixture(ctx.db, "linked-login");
    const self = await makeMember("Acting Member");
    await setMemberLoginParty(ctx.db, ctx.actor.userId, self, ctx.actor);
    const device = await makeDevice("Linked Device", self);

    await recordImageSightings(
      ctx.db,
      [report(image, undefined, device, "ASSET-LINKED-1")],
      ctx.actor,
    );
    expect(
      (await listImageSightings(ctx.db, [image.id])).get(image.id)?.[0]
        ?.ledgerPartyId,
    ).toBe(self);
  });
});
