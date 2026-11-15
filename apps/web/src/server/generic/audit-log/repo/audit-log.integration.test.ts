import { randomUUID } from "node:crypto";

import type { AuditEntityKind } from "@cubby/schemas/audit";
import type { AuditChannel } from "@cubby/schemas/context";
import { testShortcode } from "@cubby/schemas/testing";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { insertFieldsFixture as insertWithShortcode } from "~/server/ai/fields/fields.fixtures";
import { insertAndReturn, withTransaction } from "~/server/db/helpers";
import { auditLog, product } from "~/server/db/schema";
import { ensureRun } from "~/server/domains/run/repo/ensure-run";
import { findOrCreateVendor } from "~/server/domains/vendor/repo/vendor";
import { listAuditLog } from "~/server/generic/audit-log/operations/audit-log.server";
import { getAuditLog } from "~/server/generic/audit-log/repo/audit-log-read";
import {
  createInventoryFixture as createInventoryEntry,
  createLocationFixture as createLocation,
  createProductFixture as createProduct,
  makeLocationInput,
  makeProductInput,
} from "~/server/testing/repo.fixtures";

/**
 * `getAuditLog` filters by `channel` and a `createdAtFrom`/
 * `createdAtTo` window on top of the existing entityKind/entityId/cursor
 * filters. Rows are inserted directly against the `auditLog` table (rather
 * than through `logAuditEntry`) so each test can pin an exact `createdAt` —
 * `logAuditEntry` always stamps `defaultNow()`.
 */
describe("getAuditLog — channel + time window", () => {
  const ctx = withTestDb();

  it("routes unknown and mismatched public audit subjects to an empty result", async () => {
    const record = await createProduct(
      ctx.db,
      makeProductInput({ name: "Audit subject fixture" }),
      ctx.actor,
    );
    const listed = await listAuditLog(ctx.db, {
      entityKind: "product",
      entityId: record.id,
      limit: 50,
    });
    expect(listed.entries.length).toBeGreaterThan(0);
    expect(
      await listAuditLog(ctx.db, {
        entityKind: "ingredient",
        entityId: record.id,
        limit: 50,
      }),
    ).toEqual({ entries: [] });
    expect(
      await listAuditLog(ctx.db, {
        entityId: testShortcode("product", "missing-audit-subject"),
        limit: 50,
      }),
    ).toEqual({ entries: [] });
  });

  // Audit rows reference a real identity (ADR 0006), so each names a product.
  const makeEntry = async (overrides: {
    createdAt: Date;
    channel?: AuditChannel;
  }) => {
    const subject = await insertWithShortcode(ctx.db, "product", {
      name: `Audit subject ${randomUUID()}`,
      brandId: await findOrCreateVendor(ctx.db, "Test Mfr"),
    });
    return insertAndReturn(ctx.db, auditLog, {
      entityKind: "product",
      entityId: subject.id,
      action: "update",
      userId: ctx.actor.userId,
      channel: overrides.channel ?? "web",
      createdAt: overrides.createdAt,
    });
  };

  const day1 = new Date("2026-07-01T00:00:00.000Z");
  const day2 = new Date("2026-07-15T00:00:00.000Z");
  const day3 = new Date("2026-07-30T00:00:00.000Z");

  it("includes rows on both window boundaries and excludes rows outside it", async () => {
    await makeEntry({ createdAt: day1 });
    await makeEntry({ createdAt: day2 });
    await makeEntry({ createdAt: day3 });

    const { entries } = await getAuditLog(ctx.db, {
      limit: 50,
      createdAtFrom: day1.toISOString(),
      createdAtTo: day2.toISOString(),
    });

    expect(entries).toHaveLength(2);
    const returnedTimes = entries.map((e) => e.createdAt.toISOString()).sort();
    expect(returnedTimes).toEqual([day1.toISOString(), day2.toISOString()]);
  });

  it("omits rows whose subject is not an audit entity", async () => {
    const at = new Date("2026-07-22T00:00:00.000Z");
    await makeEntry({ createdAt: at });
    const runId = await ensureRun(ctx.db, ctx.actor, { purpose: "ai_suggest" });
    await insertAndReturn(ctx.db, auditLog, {
      // SAFETY: migration 0007 wrote Run dispatch history under this kind.
      entityKind: "run" as AuditEntityKind,
      entityId: runId,
      action: "update",
      userId: ctx.actor.userId,
      channel: "system",
      createdAt: at,
    });

    const { entries } = await getAuditLog(ctx.db, {
      limit: 50,
      createdAtFrom: at.toISOString(),
      createdAtTo: at.toISOString(),
    });

    expect(entries.map((entry) => entry.entityKind)).toEqual(["product"]);
  });

  it("paginates identical timestamps without repeating or skipping entries", async () => {
    const timestamp = new Date("2026-07-20T12:00:00.000Z");
    const channel = "system";
    await Promise.all(
      Array.from({ length: 7 }, () =>
        makeEntry({ createdAt: timestamp, channel }),
      ),
    );

    const entryKeys: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await getAuditLog(ctx.db, {
        limit: 2,
        channel,
        createdAtFrom: timestamp.toISOString(),
        createdAtTo: timestamp.toISOString(),
        cursor,
      });
      entryKeys.push(...page.entries.map((entry) => entry.entryKey));
      cursor = page.nextCursor;
    } while (cursor);

    expect(entryKeys).toHaveLength(7);
    expect(new Set(entryKeys).size).toBe(7);
  });
});

/**
 * The home feed renders one line per entry, so an entry that resolves to a
 * bare type + shortcode ("Inventory Item INV-KZYZ") carries no information.
 * `entityName` is resolved at read time — from a display column for most
 * entities, and from a product+location join for inventory, whose identity is
 * relational. These pin each outcome that resolution can produce.
 */
describe("getAuditLog — entityName", () => {
  const ctx = withTestDb();

  const auditRowFor = (entityKind: AuditEntityKind, entityId: string) =>
    insertAndReturn(ctx.db, auditLog, {
      entityKind,
      entityId,
      action: "update",
      userId: ctx.actor.userId,
    });

  it("still names a row that was soft-deleted after the entry was written", async () => {
    const row = await insertWithShortcode(ctx.db, "product", {
      name: "Retired Blade",
      brandId: await findOrCreateVendor(ctx.db, "ACME"),
    });
    await auditRowFor("product", row.id);
    await withTransaction(ctx.db, (tx) =>
      tx
        .update(product)
        .set({ deletedAt: new Date() })
        .where(eq(product.id, row.id)),
    );

    const { entries } = await getAuditLog(ctx.db, {
      limit: 50,
      entityKind: "product",
    });
    expect(entries[0]?.entityName).toBe("Retired Blade");
  });

  it("names an inventory entry compositely, by its product and location", async () => {
    const loc = await createLocation(
      ctx.db,
      makeLocationInput({ name: "Garage" }),
      ctx.actor,
    );
    const prod = await createProduct(
      ctx.db,
      makeProductInput({ name: "Cast Iron Skillet" }),
      ctx.actor,
    );
    const entry = await createInventoryEntry(
      ctx.db,
      {
        productId: prod.id,
        locationId: loc.id,
        amount: { value: 1, unit: "ea" },
      },
      ctx.actor,
    );
    await auditRowFor("inventory", entry.entityId);

    const { entries } = await getAuditLog(ctx.db, {
      limit: 50,
      entityKind: "inventory",
    });
    expect(entries[0]?.entityName).toBe("Cast Iron Skillet · Garage");
  });

  it("names each relationship code a diff points at", async () => {
    const shelf = await createLocation(
      ctx.db,
      makeLocationInput({ name: "Shelf" }),
      ctx.actor,
    );
    const garage = await createLocation(
      ctx.db,
      makeLocationInput({ name: "Garage" }),
      ctx.actor,
    );
    const prod = await createProduct(
      ctx.db,
      makeProductInput({ name: "Synthetic Trowel" }),
      ctx.actor,
    );
    const entry = await createInventoryEntry(
      ctx.db,
      {
        productId: prod.id,
        locationId: garage.id,
        amount: { value: 1, unit: "ea" },
      },
      ctx.actor,
    );
    await insertAndReturn(ctx.db, auditLog, {
      entityKind: "inventory",
      entityId: entry.entityId,
      action: "update",
      userId: ctx.actor.userId,
      changes: { locationId: { from: shelf.entityId, to: garage.entityId } },
    });

    const { entries } = await getAuditLog(ctx.db, {
      limit: 1,
      entityKind: "inventory",
    });
    expect(entries[0]?.changes?.locationId).toEqual({
      from: shelf.id,
      to: garage.id,
    });
    expect(entries[0]?.references).toEqual({
      [shelf.id]: { name: "Shelf", displayImage: null },
      [garage.id]: { name: "Garage", displayImage: null },
    });
  });
});

// A creation receipt and its pending alert must commit or roll back together.
describe("background result alerts", () => {
  const ctx = withTestDb();

  it("admits unattended creations once, excludes interactive writes, and preserves rollback", async () => {
    const { createRepoEntity } = await import("tooling/factories/repo");
    const { getDb, withTransactionDatabase } =
      await import("~/server/db/helpers");
    const { deviceAlertDelivery, device, run } =
      await import("~/server/db/schema");
    const { logAuditEntry } =
      await import("~/server/generic/audit-log/repo/audit-log");
    const { resolveOrThrow } =
      await import("~/server/generic/shortcode/repo/shortcode-resolver");
    const { session } = await import("~/server/db/auth.schema");
    const sessionId = randomUUID();
    await getDb(ctx.db)
      .insert(session)
      .values({
        id: sessionId,
        token: randomUUID(),
        userId: ctx.actor.userId,
        expiresAt: new Date(Date.now() + 86400_000),
        updatedAt: new Date(),
      });
    const owner = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Alert member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const install = await insertWithShortcode(ctx.db, "device", {
      name: "Alert phone",
      installationId: randomUUID(),
      platform: "ios",
      ledgerPartyId: owner.id,
    });
    await getDb(ctx.db)
      .update(device)
      .set({
        backgroundAlerts: true,
        pushRegistration: {
          token: "a".repeat(64),
          userId: ctx.actor.userId,
          sessionId,
          generation: randomUUID(),
          environment: "development",
          appIdentity: "production",
        },
      })
      .where(eq(device.id, install.id));
    const discoveryRunId = await ensureRun(ctx.db, ctx.actor, {
      purpose: "mail_discovery",
      trigger: "manual",
      execution: false,
      input: {
        mailboxId: "synthetic-alert-mailbox",
        scopedQueries: [],
        executionPolicy: "import",
      },
    });
    const runId = await ensureRun(ctx.db, ctx.actor, {
      purpose: "mail_import",
      trigger: "discovery",
      parentRunId: discoveryRunId,
      execution: false,
    });
    await getDb(ctx.db)
      .update(run)
      .set({ trigger: "discovery" })
      .where(eq(run.id, runId));
    const unattended = {
      ...ctx,
      actor: { ...ctx.actor, runId, channel: "mcp" as const },
    };
    const task = await createRepoEntity(unattended, "task", {
      name: "Background household task",
      trade: "other",
    });
    const taskId = await resolveOrThrow(ctx.db, "task", task.output.id);
    await createRepoEntity(ctx, "task", {
      name: "Interactive household task",
      trade: "other",
    });
    await logAuditEntry(ctx.db, unattended.actor, {
      entityKind: "task",
      entityId: taskId,
      action: "create",
    });
    const pending = () =>
      getDb(ctx.db)
        .select()
        .from(deviceAlertDelivery)
        .where(eq(deviceAlertDelivery.deviceId, install.id));
    expect(await pending()).toHaveLength(1);
    const first = (await pending())[0]!;
    expect(first.availableAt.getTime() - first.createdAt.getTime()).toBe(
      120_000,
    );
    await expect(
      withTransactionDatabase(ctx.db, async (tx) => {
        await createRepoEntity({ ...unattended, db: tx }, "task", {
          name: "Rolled back task",
          trade: "other",
        });
        throw new Error("synthetic rollback");
      }),
    ).rejects.toThrow("synthetic rollback");
    expect(await pending()).toHaveLength(1);
    await getDb(ctx.db)
      .update(run)
      .set({ trigger: "foreground" })
      .where(eq(run.id, runId));
    await createRepoEntity(unattended, "task", {
      name: "Foreground import task",
      trade: "other",
    });
    expect(await pending()).toHaveLength(1);
    await getDb(ctx.db)
      .update(run)
      .set({ trigger: "manual" })
      .where(eq(run.id, runId));
    await createRepoEntity(unattended, "task", {
      name: "Interactive agent task",
      trade: "other",
    });
    expect(await pending()).toHaveLength(1);
    await getDb(ctx.db)
      .update(run)
      .set({ trigger: "discovery" })
      .where(eq(run.id, runId));
    for (const parent of [
      { purpose: "ai_suggest", trigger: "manual" },
      { purpose: "mail_discovery", trigger: "foreground" },
      { purpose: "mail_discovery", trigger: "backfill" },
    ] as const) {
      await getDb(ctx.db)
        .update(run)
        .set(parent)
        .where(eq(run.id, discoveryRunId));
      await createRepoEntity(unattended, "task", {
        name: "Interactive ancestry task",
        trade: "other",
      });
      expect(await pending()).toHaveLength(1);
    }
    await getDb(ctx.db)
      .update(run)
      .set({ purpose: "mail_discovery", trigger: "manual" })
      .where(eq(run.id, discoveryRunId));

    const { dispatchBackgroundAlerts } =
      await import("~/server/generic/push/repo/delivery");
    const key = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign"],
    );
    const der = new Uint8Array(
      await crypto.subtle.exportKey("pkcs8", key.privateKey),
    );
    const credentials = {
      keyId: "SYNTHPUSH1",
      teamId: "SYNTHPUSH1",
      privateKey: `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...der))}\n-----END PRIVATE KEY-----`,
    };
    const sent: string[] = [];
    const transport: import("~/server/generic/push/repo/apns").ApnsTransport =
      async (request) => {
        sent.push(request.headers["apns-collapse-id"]!);
        expect(JSON.parse(request.body).aps.alert.body).toContain(
          "Background household task",
        );
        return sent.length === 1
          ? { status: 503, reason: "ServiceUnavailable" }
          : { status: 200, reason: null };
      };
    await dispatchBackgroundAlerts(ctx.db, { transport, credentials });
    expect(sent).toHaveLength(0);
    await getDb(ctx.db)
      .update(deviceAlertDelivery)
      .set({ availableAt: new Date(0) })
      .where(eq(deviceAlertDelivery.deviceId, install.id));
    await Promise.all([
      dispatchBackgroundAlerts(ctx.db, { transport, credentials }),
      dispatchBackgroundAlerts(ctx.db, { transport, credentials }),
    ]);
    expect(sent).toHaveLength(1);
    expect((await pending())[0]!.acceptedAt).toBeNull();
    await getDb(ctx.db)
      .update(deviceAlertDelivery)
      .set({ availableAt: new Date(0) })
      .where(eq(deviceAlertDelivery.deviceId, install.id));
    await dispatchBackgroundAlerts(ctx.db, { transport, credentials });
    expect(sent).toHaveLength(2);
    expect(sent[1]).toBe(sent[0]);
    expect((await pending())[0]!.acceptedAt).not.toBeNull();

    const { registerDevicePush, endDevicePush } =
      await import("~/server/domains/device/repo/device-push");
    const { sendDeviceAlert } =
      await import("~/server/generic/push/repo/delivery");
    const installActor = { ...ctx.actor, deviceId: install.id };
    await getDb(ctx.db)
      .update(run)
      .set({ trigger: "discovery" })
      .where(eq(run.id, runId));
    await createRepoEntity(unattended, "task", {
      name: "Next background task",
      trade: "other",
    });
    await registerDevicePush(ctx.db, installActor, sessionId, {
      token: "b".repeat(64),
      environment: "development",
      appIdentity: "production",
      enabled: true,
    });
    expect((await pending()).filter((row) => !row.acceptedAt)).toHaveLength(1);
    await sendDeviceAlert(
      ctx.db,
      install.id,
      { aps: { alert: "Synthetic race" } },
      randomUUID(),
      {
        credentials,
        transport: async () => {
          await registerDevicePush(ctx.db, installActor, sessionId, {
            token: "c".repeat(64),
            environment: "development",
            appIdentity: "production",
            enabled: true,
          });
          return { status: 410, reason: "Unregistered" };
        },
      },
    );
    const [rotated] = await getDb(ctx.db)
      .select()
      .from(device)
      .where(eq(device.id, install.id));
    expect(
      (
        await import("@cubby/schemas/device-fields")
      ).devicePushRegistration.parse(rotated!.pushRegistration).token,
    ).toBe("c".repeat(64));
    expect(rotated!.backgroundAlerts).toBe(true);
    const { readDeviceById } =
      await import("~/server/domains/device/repo/device");
    expect(
      JSON.stringify(await readDeviceById(ctx.db, install.id)),
    ).not.toContain("c".repeat(64));
    await endDevicePush(ctx.db, installActor);
    expect((await pending()).filter((row) => !row.acceptedAt)).toHaveLength(0);

    await registerDevicePush(ctx.db, installActor, sessionId, {
      token: "c".repeat(64),
      environment: "development",
      appIdentity: "production",
      enabled: true,
    });
    const { moneyToMinor } = await import("@cubby/shared");
    const { logAuditEntries } =
      await import("~/server/generic/audit-log/repo/audit-log");
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Grouped shop",
    });
    const purchase = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
      date: "2024-01-15",
      statedTotal: moneyToMinor(42),
    });
    const expense = await insertWithShortcode(ctx.db, "expense", {
      name: "Grouped item",
      lineKind: "principal",
      costType: "materials",
      trade: "other",
      date: "2024-01-15",
      purchaseId: purchase.id,
      cost: moneyToMinor(42),
    });
    await logAuditEntries(ctx.db, unattended.actor, [
      { entityKind: "purchase", entityId: purchase.id, action: "create" },
      { entityKind: "expense", entityId: expense.id, action: "create" },
    ]);
    await getDb(ctx.db)
      .update(deviceAlertDelivery)
      .set({ availableAt: new Date(0) })
      .where(eq(deviceAlertDelivery.deviceId, install.id));
    let groupedSends = 0;
    await dispatchBackgroundAlerts(ctx.db, {
      credentials,
      transport: async (request) => {
        const payload = JSON.parse(request.body);
        expect(payload.entity).toBe("purchase");
        expect(payload.entityId).toBe(purchase.shortcode);
        expect(payload.aps.alert.title).toBe("Added Purchase");
        expect(payload.aps.alert.body).toContain("42");
        groupedSends++;
        return { status: 200, reason: null };
      },
    });
    expect(groupedSends).toBe(1);
    const extra = await insertWithShortcode(ctx.db, "expense", {
      name: "Later item",
      lineKind: "principal",
      costType: "materials",
      trade: "other",
      date: "2024-01-15",
      purchaseId: purchase.id,
      cost: moneyToMinor(5),
    });
    await logAuditEntries(ctx.db, unattended.actor, [
      { entityKind: "expense", entityId: extra.id, action: "create" },
    ]);
    await getDb(ctx.db)
      .update(deviceAlertDelivery)
      .set({ availableAt: new Date(0) })
      .where(eq(deviceAlertDelivery.deviceId, install.id));
    await dispatchBackgroundAlerts(ctx.db, {
      credentials,
      transport: async (request) => {
        const payload = JSON.parse(request.body);
        expect(payload.entityId).toBe(purchase.shortcode);
        expect(payload.aps.alert.title).toBe("Added to Purchase");
        groupedSends++;
        return { status: 200, reason: null };
      },
    });
    expect(groupedSends).toBe(2);

    for (const purpose of ["maintenance", "connection_discovery"] as const) {
      const backgroundRunId = await ensureRun(ctx.db, ctx.actor, {
        purpose,
        trigger: "manual",
        execution: false,
      });
      const before = (await pending()).length;
      await createRepoEntity(
        { ...ctx, actor: { ...ctx.actor, runId: backgroundRunId } },
        "task",
        { name: "Manually launched background result", trade: "other" },
      );
      expect(await pending()).toHaveLength(before + 1);
    }
  });
});
