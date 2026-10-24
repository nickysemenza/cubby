import { connectedAppsOut } from "@cubby/schemas/oauth";
import { testUserId } from "@cubby/schemas/testing";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb } from "~/server/db/helpers";
import {
  oauthClient,
  oauthConsent,
  oauthRefreshToken,
  user,
} from "~/server/db/schema";

import { listConnectedApps } from "./oauth-consent";

describe("connected app activity", () => {
  const ctx = withTestDb();

  it("returns schema-valid dates and nulls with user-scoped activity ordering", async () => {
    const db = getDb(ctx.db);
    const otherUser = testUserId("other-oauth-user");
    const grantedAt = new Date("2026-01-01T12:00:00.000Z");
    const lastActiveAt = new Date("2026-02-03T14:15:16.123Z");
    await db.insert(user).values({
      id: otherUser,
      name: "Other member",
      email: "other-oauth@example.com",
    });
    await db.insert(oauthClient).values(
      ["active-client", "unused-client"].map((clientId) => ({
        id: clientId,
        clientId,
        name: clientId,
        redirectUris: ["https://example.com/callback"],
      })),
    );
    await db.insert(oauthConsent).values(
      ["active-client", "unused-client"].map((clientId) => ({
        id: `${clientId}-consent`,
        clientId,
        userId: ctx.actor.userId,
        scopes: ["offline_access"],
        createdAt: grantedAt,
      })),
    );
    await db.insert(oauthRefreshToken).values([
      {
        id: "old-token",
        token: "synthetic-old-token",
        clientId: "active-client",
        userId: ctx.actor.userId,
        scopes: ["offline_access"],
        createdAt: grantedAt,
        revoked: grantedAt,
      },
      {
        id: "active-token",
        token: "synthetic-active-token",
        clientId: "active-client",
        userId: ctx.actor.userId,
        scopes: ["offline_access"],
        createdAt: lastActiveAt,
      },
      {
        id: "other-user-token",
        token: "synthetic-other-user-token",
        clientId: "unused-client",
        userId: otherUser,
        scopes: ["offline_access"],
        createdAt: new Date("2026-03-01T00:00:00.000Z"),
      },
    ]);

    // Raw timestamp aggregates need a driver decoder before operation validation.
    const apps = connectedAppsOut.parse(
      await listConnectedApps(ctx.db, ctx.actor.userId),
    );
    expect(apps.map((app) => app.clientId)).toEqual([
      "active-client",
      "unused-client",
    ]);
    expect(apps.map((app) => app.grantedAt)).toEqual([grantedAt, grantedAt]);
    expect(apps.map((app) => app.lastActiveAt)).toEqual([lastActiveAt, null]);
    expect(apps.map((app) => app.activeTokens)).toEqual([1, 0]);
  });
});
