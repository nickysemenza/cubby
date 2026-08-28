import { testUserId } from "@cubby/schemas/testing";
import { describe, expect, it, vi } from "vitest";

import { Database } from "~/server/db";
import { getCalendarRange } from "~/server/repo/calendar";
import { findUserByCalendarFeedToken } from "~/server/repo/calendar-feed";

import { createCalendarFeedHandler } from "./feed";

describe("published calendar feed read policy", () => {
  it("authorizes against the strong handle and reads content from the stale handle", async () => {
    const authorizationDb = new Database(() => {
      throw new Error("The test must not open the authorization database");
    });
    const contentDb = new Database(() => {
      throw new Error("The test must not open the content database");
    });
    const findUserByToken = vi.fn<typeof findUserByCalendarFeedToken>(
      async () => testUserId("calendar-feed"),
    );
    const getRange = vi.fn<typeof getCalendarRange>(async () => ({
      items: [],
      days: {},
    }));
    const handler = createCalendarFeedHandler({
      authorizationDb,
      contentDb,
      findUserByToken,
      getRange,
      now: () => new Date("2026-08-28T12:00:00.000Z"),
    });

    const response = await handler({
      request: new Request(
        "https://cubby.example/api/calendar/strong-token/all.ics",
      ),
    });

    expect(response.status).toBe(200);
    expect(findUserByToken).toHaveBeenCalledWith(
      authorizationDb,
      "strong-token",
    );
    expect(getRange).toHaveBeenCalledWith(
      contentDb,
      expect.objectContaining({ kinds: expect.any(Array) }),
    );
    expect(findUserByToken.mock.calls[0]?.[0]).toBe(authorizationDb);
    expect(findUserByToken.mock.calls[0]?.[0]).not.toBe(contentDb);
    expect(getRange.mock.calls[0]?.[0]).toBe(contentDb);
    expect(getRange.mock.calls[0]?.[0]).not.toBe(authorizationDb);
  });
});
