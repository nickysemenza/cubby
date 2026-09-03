import { describe, expect, it, vi } from "vitest";

import type { CalendarFeedState } from "./contracts";
import { createCalendarFeedHandler } from "./feed";

const document = {
  body: "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n",
  etag: '"calendar-etag"',
  generatedAt: "2026-09-03T12:00:00.000Z",
  revision: 4,
  itemCount: 2,
};

function state(read: CalendarFeedState["read"]): CalendarFeedState {
  return {
    getToken: async () => "token",
    inspect: async () => {
      throw new Error("not used by feed handler");
    },
    rotate: async () => "token",
    read,
    markDirty: async () => undefined,
    refreshNow: async () => null,
  };
}

describe("published calendar feed", () => {
  it("serves a stored document without any database dependency", async () => {
    const read = vi.fn<CalendarFeedState["read"]>(async () => ({
      result: "served",
      ...document,
    }));
    const resolveState = vi.fn(async () => state(read));
    const handler = createCalendarFeedHandler(resolveState);

    const response = await handler({
      request: new Request(
        "https://cubby.example/api/calendar/strong-token/all.ics",
      ),
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(document.body);
    expect(response.headers.get("etag")).toBe(document.etag);
    expect(resolveState).toHaveBeenCalledWith("https://cubby.example");
    expect(read).toHaveBeenCalledWith("strong-token", "all", null);
  });

  it("returns 304 without a body for a matching ETag", async () => {
    const handler = createCalendarFeedHandler(async () =>
      state(async () => ({ result: "not_modified", ...document })),
    );
    const response = await handler({
      request: new Request(
        "https://cubby.example/api/calendar/token/meals.ics",
        { headers: { "If-None-Match": document.etag } },
      ),
    });
    expect(response.status).toBe(304);
    expect(await response.text()).toBe("");
    expect(response.headers.get("etag")).toBe(document.etag);
  });

  it("makes unknown tokens, feeds, and malformed tokens indistinguishable", async () => {
    const handler = createCalendarFeedHandler(async () =>
      state(async () => ({ result: "not_found" })),
    );
    for (const path of [
      "/api/calendar/nope/tasks.ics",
      "/api/calendar/nope/unknown.ics",
      "/api/calendar/%E0%A4%A/all.ics",
    ]) {
      const response = await handler({
        request: new Request(`https://cubby.example${path}`),
      });
      expect(response.status).toBe(404);
      expect(await response.text()).toBe("Not found");
    }
  });
});
