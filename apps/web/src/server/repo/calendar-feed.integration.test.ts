import { testUserId } from "@cubby/schemas/testing";
import { TEST_USER_ID, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import {
  findUserByCalendarFeedToken,
  rotateCalendarFeedToken,
} from "./calendar-feed";

const USER = testUserId(TEST_USER_ID);

describe("calendar feed tokens", () => {
  const ctx = withTestDb();

  it("mints distinct valid tokens and resolves the latest owner", async () => {
    const token = await rotateCalendarFeedToken(ctx.db, USER);
    expect(token).toHaveLength(43); // 32 bytes, base64url, unpadded
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    await expect(findUserByCalendarFeedToken(ctx.db, token)).resolves.toBe(
      USER,
    );

    const tokens = new Set<string>([token]);
    for (let i = 0; i < 4; i++) {
      tokens.add(await rotateCalendarFeedToken(ctx.db, USER));
    }
    expect(tokens.size).toBe(5);
  });

  it("invalidates the previous token on rotate", async () => {
    const first = await rotateCalendarFeedToken(ctx.db, USER);
    const second = await rotateCalendarFeedToken(ctx.db, USER);

    expect(second).not.toBe(first);
    // The old URL must stop working the moment the new one is minted —
    // that is the entire point of the Regenerate button.
    await expect(
      findUserByCalendarFeedToken(ctx.db, first),
    ).resolves.toBeNull();
    await expect(findUserByCalendarFeedToken(ctx.db, second)).resolves.toBe(
      USER,
    );
    await expect(
      findUserByCalendarFeedToken(ctx.db, "not-a-real-token"),
    ).resolves.toBeNull();
    // An empty token must never match a user whose column is still NULL.
    await expect(findUserByCalendarFeedToken(ctx.db, "")).resolves.toBeNull();
  });
});
