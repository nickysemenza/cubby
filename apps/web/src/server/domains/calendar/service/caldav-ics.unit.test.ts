import { testShortcode } from "@cubby/schemas/testing";
import { describe, expect, it } from "vitest";

import { parseCalDavEvent, renderCalDavResource } from "./caldav-ics";

const event = (lines: string[]) =>
  [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "BEGIN:VEVENT",
    ...lines,
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n");

describe("parseCalDavEvent", () => {
  it("parses explicit task classification and refuses invalid values", () => {
    const fields = [
      "UID:classified",
      "SUMMARY:Paint",
      "DTSTART;VALUE=DATE:20260920",
    ];
    expect(
      parseCalDavEvent(event([...fields, "X-CUBBY-TRADE:finishes"]), "tasks")
        .trade,
    ).toBe("finishes");
    expect(() =>
      parseCalDavEvent(event([...fields, "X-CUBBY-TRADE:invented"]), "tasks"),
    ).toThrow("X-CUBBY-TRADE");
    expect(parseCalDavEvent(event(fields), "tasks").trade).toBeUndefined();
  });

  it("coerces a timed meal to the nearest household meal slot", () => {
    const parsed = parseCalDavEvent(
      event([
        "UID:client-1",
        "SUMMARY:Late lunch",
        "DTSTART:20260815T191500Z",
        "DTEND:20260815T194500Z",
      ]),
      "meals",
    );
    // 12:15 PDT is nearer lunch than snack.
    expect(parsed).toMatchObject({
      startDate: "2026-08-15",
      endDateExclusive: "2026-08-16",
      mealType: "lunch",
    });
  });

  it("keeps one-day all-day meals unslotted", () => {
    expect(
      parseCalDavEvent(
        event([
          "UID:client-2",
          "SUMMARY:Picnic",
          "DTSTART;VALUE=DATE:20260815",
          "DTEND;VALUE=DATE:20260816",
        ]),
        "meals",
      ),
    ).toMatchObject({ mealType: null, startDate: "2026-08-15" });
  });

  it("rejects cross-midnight and recurring meal events", () => {
    expect(() =>
      parseCalDavEvent(
        event([
          "UID:client-3",
          "SUMMARY:Dinner",
          "DTSTART:20260816T063000Z",
          "DTEND:20260816T073000Z",
        ]),
        "meals",
      ),
    ).toThrow("cross midnight");
    expect(() =>
      parseCalDavEvent(
        event([
          "UID:client-3",
          "SUMMARY:Dinner",
          "DTSTART;VALUE=DATE:20260815",
          "DTEND;VALUE=DATE:20260816",
          "RRULE:FREQ=DAILY",
        ]),
        "meals",
      ),
    ).toThrow("RRULE");
  });

  it("turns a timed task into its inclusive local date range", () => {
    expect(
      parseCalDavEvent(
        event([
          "UID:client-4",
          "SUMMARY:Paint",
          "DTSTART:20260815T070000Z",
          "DTEND:20260816T070000Z",
        ]),
        "tasks",
      ),
    ).toMatchObject({
      startDate: "2026-08-15",
      endDateExclusive: "2026-08-16",
      mealType: null,
    });
  });

  it.each([
    ["breakfast", "20260815T160000Z"],
    ["brunch", "20260815T180000Z"],
    ["lunch", "20260815T190000Z"],
    ["snack", "20260815T220000Z"],
    ["dinner", "20260816T020000Z"],
    ["dessert", "20260816T030000Z"],
  ] as const)("coerces %s slot input", (slot, start) => {
    const end = start.replace(
      /(\d{2})Z$/,
      (_, seconds: string) =>
        `${String(Number(seconds.slice(0, 2)) + 30).padStart(2, "0")}${seconds.slice(2)}Z`,
    );
    expect(
      parseCalDavEvent(
        event(["UID:slot", "SUMMARY:Meal", `DTSTART:${start}`, `DTEND:${end}`]),
        "meals",
      ).mealType,
    ).toBe(slot);
  });

  it("chooses the earlier slot on an exact midpoint", () => {
    expect(
      parseCalDavEvent(
        event([
          "UID:tie",
          "SUMMARY:Meal",
          "DTSTART:20260815T183000Z",
          "DTEND:20260815T190000Z",
        ]),
        "meals",
      ).mealType,
    ).toBe("brunch");
  });

  it("accepts IANA timezones without VTIMEZONE and maps DST dates", () => {
    const parsed = parseCalDavEvent(
      event([
        "UID:iana",
        "SUMMARY:Breakfast",
        "DTSTART;TZID=America/Los_Angeles:20261101T090000",
        "DTEND;TZID=America/Los_Angeles:20261101T093000",
      ]),
      "meals",
    );
    expect(parsed).toMatchObject({
      startDate: "2026-11-01",
      mealType: "breakfast",
    });
  });

  it("allows only request-scoped embedded custom timezones", () => {
    const calendar = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VTIMEZONE",
      "TZID:Custom/Clock",
      "BEGIN:STANDARD",
      "DTSTART:19700101T000000",
      "TZOFFSETFROM:+0000",
      "TZOFFSETTO:+0000",
      "END:STANDARD",
      "END:VTIMEZONE",
      "BEGIN:VEVENT",
      "UID:custom",
      "SUMMARY:Meal",
      "DTSTART;TZID=Custom/Clock:20260815T120000",
      "DTEND;TZID=Custom/Clock:20260815T123000",
      "END:VEVENT",
      "END:VCALENDAR",
      "",
    ].join("\r\n");
    // The embedded definition is UTC, so noon there is 5am household-local.
    expect(parseCalDavEvent(calendar, "meals").mealType).toBe("breakfast");
    expect(() =>
      parseCalDavEvent(
        event([
          "UID:bad-zone",
          "SUMMARY:Meal",
          "DTSTART;TZID=Nope/Zone:20260815T120000",
          "DTEND;TZID=Nope/Zone:20260815T123000",
        ]),
        "meals",
      ),
    ).toThrow("unresolvable timezone");
  });

  it.each([
    ["missing UID", ["SUMMARY:x", "DTSTART;VALUE=DATE:20260815"]],
    [
      "duplicate UID",
      ["UID:one", "UID:two", "SUMMARY:x", "DTSTART;VALUE=DATE:20260815"],
    ],
    ["missing SUMMARY", ["UID:one", "DTSTART;VALUE=DATE:20260815"]],
    ["missing DTSTART", ["UID:one", "SUMMARY:x"]],
    ["invalid date", ["UID:one", "SUMMARY:x", "DTSTART;VALUE=DATE:20260230"]],
  ])("rejects %s", (_name, lines) => {
    expect(() => parseCalDavEvent(event(lines), "tasks")).toThrow(
      "Invalid CalDAV event",
    );
  });

  it("enforces duration, mutually-exclusive ends, and recurrence bounds", () => {
    expect(() =>
      parseCalDavEvent(
        event([
          "UID:both",
          "SUMMARY:x",
          "DTSTART:20260815T190000Z",
          "DTEND:20260815T193000Z",
          "DURATION:PT30M",
        ]),
        "meals",
      ),
    ).toThrow("cannot both");
    expect(() =>
      parseCalDavEvent(
        event([
          "UID:zero",
          "SUMMARY:x",
          "DTSTART:20260815T190000Z",
          "DURATION:PT0S",
        ]),
        "meals",
      ),
    ).toThrow("positive");
    for (const property of [
      "RDATE:20260816",
      "EXDATE:20260816",
      "RECURRENCE-ID:20260816T190000Z",
    ]) {
      expect(() =>
        parseCalDavEvent(
          event([
            "UID:recurrence",
            "SUMMARY:x",
            "DTSTART;VALUE=DATE:20260815",
            property,
          ]),
          "tasks",
        ),
      ).toThrow("unsupported");
    }
  });

  it("defaults a missing all-day end to one date, but rejects exact-midnight next-day meals", () => {
    expect(
      parseCalDavEvent(
        event(["UID:default-end", "SUMMARY:x", "DTSTART;VALUE=DATE:20260815"]),
        "meals",
      ),
    ).toMatchObject({ endDateExclusive: "2026-08-16" });
    expect(() =>
      parseCalDavEvent(
        event([
          "UID:midnight",
          "SUMMARY:x",
          "DTSTART:20260816T063000Z",
          "DTEND:20260816T070000Z",
        ]),
        "meals",
      ),
    ).toThrow("cross midnight");
  });
});

describe("renderCalDavResource", () => {
  it("returns deterministic, strong ETags and canonical dinner slot bytes", async () => {
    const input = {
      entity: "meal" as const,
      id: testShortcode("meal", "MEL-4K7M"),
      name: "Taco night",
      date: "2026-08-15",
      mealType: "dinner" as const,
      updatedAt: "2026-08-14T12:34:56.000Z",
    };
    const identity = {
      entity: "meal" as const,
      shortcode: "MEL-4K7M",
      filename: "MEL-4K7M.ics",
      uid: "MEL-4K7M@cubby.nickysemenza.com",
    };
    const first = await renderCalDavResource(
      input,
      identity,
      "https://cubby.example.com",
    );
    const second = await renderCalDavResource(
      input,
      identity,
      "https://cubby.example.com",
    );
    expect(first.etag).toBe(second.etag);
    expect(first.etag).toMatch(/^"[a-f0-9]{64}"$/);
    expect(first.body).toContain("DTSTART:20260816T020000Z");
    expect(first.body).toContain("SUMMARY:Taco night");
  });

  it("indexes all-day task bounds at household midnight rather than UTC midnight", async () => {
    const resource = await renderCalDavResource(
      {
        entity: "task",
        id: testShortcode("task", "TSK-9H64"),
        name: "Paint",
        dueDate: "2026-08-15",
        dueEndDate: "2026-08-15",
        status: "not_started",
        updatedAt: "2026-08-14T00:00:00.000Z",
      },
      {
        entity: "task",
        shortcode: "TSK-9H64",
        filename: "TSK-9H64.ics",
        uid: "TSK-9H64@cubby.nickysemenza.com",
      },
      "https://cubby.example.com",
    );
    expect(resource.start).toBe("2026-08-15T07:00:00.000Z");
    expect(resource.end).toBe("2026-08-16T07:00:00.000Z");
  });

  it("accepts mixed IANA and UTC endpoints by comparing resolved instants", () => {
    expect(
      parseCalDavEvent(
        event([
          "UID:mixed-zone",
          "SUMMARY:Breakfast",
          "DTSTART;TZID=America/Los_Angeles:20260815T090000",
          "DTEND:20260815T163000Z",
        ]),
        "meals",
      ),
    ).toMatchObject({ startDate: "2026-08-15", mealType: "breakfast" });
  });

  it("keeps a task ending at midnight plus seconds on the touched end date", () => {
    expect(
      parseCalDavEvent(
        event([
          "UID:seconds",
          "SUMMARY:Paint",
          "DTSTART:20260815T070000Z",
          "DTEND:20260816T070030Z",
        ]),
        "tasks",
      ),
    ).toMatchObject({
      startDate: "2026-08-15",
      endDateExclusive: "2026-08-17",
    });
  });

  it("round-trips Unicode resource identities through canonical folded ICS", async () => {
    const resource = await renderCalDavResource(
      {
        entity: "meal",
        id: testShortcode("meal", "MEL-4K7M"),
        name: "🍜 très, très long dîner ".repeat(8),
        date: "2026-08-15",
        mealType: null,
        updatedAt: "2026-08-14T00:00:00.000Z",
      },
      {
        entity: "meal",
        shortcode: "MEL-4K7M",
        filename: "🍜.ics",
        uid: "é@cubby.example",
      },
      "https://cubby.example.com",
    );
    expect(resource.body).toContain("UID:é@cubby.example");
    expect(resource.body).toContain("\r\n ");
    expect(parseCalDavEvent(resource.body, "meals").summary).toBe(
      "🍜 très, très long dîner ".repeat(8).trim(),
    );
  });

  it("uses the generated slot title for an unnamed meal and a single task date when dueEnd is null", async () => {
    const meal = await renderCalDavResource(
      {
        entity: "meal",
        id: testShortcode("meal", "MEL-4K7M"),
        name: null,
        date: "2026-08-15",
        mealType: "dinner",
        updatedAt: "2026-08-14T00:00:00.000Z",
      },
      {
        entity: "meal",
        shortcode: "MEL-4K7M",
        filename: "meal.ics",
        uid: "meal@cubby",
      },
      "https://cubby.example.com",
    );
    expect(meal.body).toContain("SUMMARY:Dinner");
    const task = await renderCalDavResource(
      {
        entity: "task",
        id: testShortcode("task", "TSK-9H64"),
        name: "Paint",
        dueDate: "2026-08-15",
        dueEndDate: null,
        status: "not_started",
        updatedAt: "2026-08-14T00:00:00.000Z",
      },
      {
        entity: "task",
        shortcode: "TSK-9H64",
        filename: "task.ics",
        uid: "task@cubby",
      },
      "https://cubby.example.com",
    );
    expect(task.body).toContain("DTEND;VALUE=DATE:20260816");
  });
});
