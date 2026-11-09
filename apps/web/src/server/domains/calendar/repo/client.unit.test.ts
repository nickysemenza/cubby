import { fromPartial } from "@total-typescript/shoehorn";
import { afterEach, describe, expect, it, vi } from "vitest";

import { setCfEnv } from "~/server/cf-env";

import { createCalDavHandler } from "../service/caldav-http";
import type { CalDavBackend } from "./caldav-types";
import { handleCalDavRequest } from "./client";

afterEach(() => {
  setCfEnv(undefined);
});

// Failures: valid OPTIONS/redirects can unnecessarily wake a DO; moving them
// can accidentally accept malformed paths, change DAV headers, or skip HTTPS.
describe("CalDAV entry protocol", () => {
  it("answers valid OPTIONS and discovery locally with the same protocol response", async () => {
    const backend = fromPartial<CalDavBackend>({});
    const remoteHandler = createCalDavHandler(backend);
    const forward = vi.fn(remoteHandler);
    const getByName = vi.fn(() => ({ fetch: forward }));
    setCfEnv(fromPartial<Env>({ CALENDAR_FEED: { getByName } }));
    for (const pathname of [
      "/api/caldav",
      "/api/caldav/",
      "/api/caldav/principals/me/",
      "/api/caldav/calendars/me/",
      "/api/caldav/calendars/me/tasks/",
      "/api/caldav/calendars/me/meals/event.ics",
      "/.well-known/caldav",
      "/.well-known/caldav/",
    ]) {
      const request = new Request(`https://calendar-test.example${pathname}`, {
        method: "OPTIONS",
      });
      const actual = await handleCalDavRequest(request);
      const expected = await remoteHandler(request);
      expect(actual.status).toBe(expected.status);
      expect([...actual.headers]).toEqual([...expected.headers]);
      expect(await actual.text()).toBe(await expected.text());
    }
    expect(getByName).not.toHaveBeenCalled();
    expect(forward).not.toHaveBeenCalled();
  });

  it("preserves rejection of insecure and malformed OPTIONS paths", async () => {
    const remoteHandler = createCalDavHandler(fromPartial<CalDavBackend>({}));
    const forward = vi.fn(remoteHandler);
    setCfEnv(
      fromPartial<Env>({
        CALENDAR_FEED: { getByName: () => ({ fetch: forward }) },
      }),
    );
    for (const url of [
      "http://calendar-test.example/api/caldav/",
      "https://calendar-test.example/api/caldav/unknown",
      "https://calendar-test.example/api/caldav/calendars/me/tasks/%ZZ",
      "https://calendar-test.example/api/caldav/calendars/me/tasks/encoded%2Fslash.ics",
    ]) {
      const request = new Request(url, { method: "OPTIONS" });
      const actual = await handleCalDavRequest(request);
      const expected = await remoteHandler(request);
      expect(actual.status).toBe(expected.status);
      expect([...actual.headers]).toEqual([...expected.headers]);
      expect(await actual.text()).toBe(await expected.text());
    }
  });
});
