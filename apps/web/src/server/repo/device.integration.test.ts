import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import {
  createDevice,
  deleteDevices,
  getDeviceByID,
  updateDevice,
} from "~/server/repo/device";
import {
  createLedgerParty,
  deleteLedgerParties,
  mergeLedgerParties,
} from "~/server/repo/ledger-party";
import { setMemberLoginParty } from "~/server/repo/member-login";
import { deleteProducts } from "~/server/repo/product/crud";
import { mergeProducts } from "~/server/repo/product/merge";
import {
  createProductFixture,
  makeProductInput,
} from "~/server/repo/repo.fixtures";

describe("device", () => {
  const ctx = withTestDb();

  it("resolves an omitted owner from the acting login, but honors an explicit null", async () => {
    const party = await createLedgerParty(
      ctx.db,
      { name: "Resident Member", kind: "member", notes: null },
      ctx.actor,
    );
    await setMemberLoginParty(
      ctx.db,
      ctx.actor.userId,
      party.output.id,
      ctx.actor,
    );

    const withOwnerOmitted = await createDevice(
      ctx.db,
      {
        installationId: crypto.randomUUID(),
        name: "Resident's Mac",
        platform: "macos",
        appVersion: null,
        osVersion: null,
        automaticWork: true,
        remotePaused: false,
      },
      ctx.actor,
    );
    expect(withOwnerOmitted.output.ledgerPartyId).toBe(party.output.id);

    const withOwnerNull = await createDevice(
      ctx.db,
      {
        installationId: crypto.randomUUID(),
        name: "Shared Household iPad",
        platform: "ios",
        appVersion: null,
        osVersion: null,
        automaticWork: true,
        remotePaused: false,
        ledgerPartyId: null,
      },
      ctx.actor,
    );
    expect(withOwnerNull.output.ledgerPartyId).toBeNull();
  });

  it("updates and soft-deletes through the generic kernel path", async () => {
    const created = await createDevice(
      ctx.db,
      {
        installationId: crypto.randomUUID(),
        name: "Kitchen iPad",
        platform: "ios",
        appVersion: "1.0",
        osVersion: "18.0",
        automaticWork: true,
        remotePaused: false,
        ledgerPartyId: null,
      },
      ctx.actor,
    );
    const updated = await updateDevice(
      ctx.db,
      created.output.id,
      { remotePaused: true, appVersion: "1.1" },
      ctx.actor,
    );
    expect(updated.output.remotePaused).toBe(true);
    expect(updated.output.appVersion).toBe("1.1");

    await deleteDevices(ctx.db, [created.output.id], ctx.actor);
    expect(
      await getDeviceByID(ctx.db, created.entityId).catch(() => null),
    ).toBeNull();
  });

  it("clears its owner when the member is deleted, and follows a merged member", async () => {
    const kept = await createLedgerParty(
      ctx.db,
      { name: "Kept Member", kind: "member", notes: null },
      ctx.actor,
    );
    const merged = await createLedgerParty(
      ctx.db,
      { name: "Merged-away Member", kind: "member", notes: null },
      ctx.actor,
    );
    const owned = await createDevice(
      ctx.db,
      {
        installationId: crypto.randomUUID(),
        name: "Owned Device",
        platform: "macos",
        appVersion: null,
        osVersion: null,
        automaticWork: true,
        remotePaused: false,
        ledgerPartyId: merged.output.id,
      },
      ctx.actor,
    );

    await mergeLedgerParties(
      ctx.db,
      { keepId: kept.output.id, mergeIds: [merged.output.id] },
      ctx.actor,
    );
    expect((await getDeviceByID(ctx.db, owned.entityId)).ledgerPartyId).toBe(
      kept.output.id,
    );

    await deleteLedgerParties(ctx.db, [kept.output.id], ctx.actor);
    expect(
      (await getDeviceByID(ctx.db, owned.entityId)).ledgerPartyId,
    ).toBeNull();
  });

  it("clears its hardware when the Product is deleted, and follows a merged product", async () => {
    const kept = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Kept Phone" }),
      ctx.actor,
    );
    const merged = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Merged-away Phone" }),
      ctx.actor,
    );
    const withHardware = await createDevice(
      ctx.db,
      {
        installationId: crypto.randomUUID(),
        name: "Hardware-linked Device",
        platform: "ios",
        appVersion: null,
        osVersion: null,
        automaticWork: true,
        remotePaused: false,
        productId: merged.id,
      },
      ctx.actor,
    );

    await mergeProducts(
      ctx.db,
      { keepId: kept.id, mergeIds: [merged.id] },
      ctx.actor,
    );
    expect((await getDeviceByID(ctx.db, withHardware.entityId)).productId).toBe(
      kept.id,
    );

    await deleteProducts(ctx.db, [kept.entityId], ctx.actor);
    expect(
      (await getDeviceByID(ctx.db, withHardware.entityId)).productId,
    ).toBeNull();
  });
});
