import type { CalendarItem } from "@cubby/schemas/calendar";
import { calendarMealItem, calendarTaskItem } from "@cubby/schemas/calendar";
import {
  unsafeMealShortcode,
  unsafeTaskShortcode,
} from "@cubby/schemas/identifiers";
import { describe, expect, it } from "vitest";
import { mock } from "~/lib/test/mock-schema";
import { kindsForFeed, renderIcs } from "./ics";

/** Mirrors mock-schema's own override type so a factory can take a subset. */
type DeepPartial<T> = T extends (infer U)[]
  ? DeepPartial<U>[]
  : T extends Date
    ? T
    : T extends object
      ? { [K in keyof T]?: DeepPartial<T[K]> }
      : T;

const NOW = new Date("2026-08-14T12:34:56.000Z");

type MealItem = Extract<CalendarItem, { kind: "meal" }>;
type TaskItem = Extract<CalendarItem, { kind: "task" }>;

const meal = (overrides: DeepPartial<MealItem> = {}): MealItem =>
  mock(calendarMealItem, {
    seed: 1,
    overrides: {
      id: unsafeMealShortcode("MEL-4K7M"),
      title: "Taco night",
      startDate: "2026-08-15",
      endDateExclusive: "2026-08-16",
      recipeNames: ["Carnitas"],
      cost: 12.5,
      calories: 820,
      nutritionPending: false,
      ...overrides,
    },
  });

const task = (overrides: DeepPartial<TaskItem> = {}): TaskItem =>
  mock(calendarTaskItem, {
    seed: 1,
    overrides: {
      id: unsafeTaskShortcode("TSK-9H64"),
      title: "Seal the deck",
      startDate: "2026-08-20",
      endDateExclusive: "2026-08-21",
      status: "not_started",
      trade: "building",
      projectName: null,
      ...overrides,
    },
  });

const ORIGIN = "https://cubby.example.com";

const render = (items: CalendarItem[]) =>
  renderIcs(items, { feed: "all", now: NOW, origin: ORIGIN });

/** Content lines, unfolded — the parser's view rather than the wire's. */
const unfold = (ics: string) => ics.replace(/\r\n /g, "").split("\r\n");

describe("renderIcs wire format", () => {
  it("delimits every line with CRLF and ends with one", () => {
    const ics = render([meal()]);
    expect(ics.endsWith("\r\n")).toBe(true);
    // No bare LF anywhere: a lone \n is the classic thing that makes a feed
    // parse on Google Calendar and fail silently on Calendar.app.
    expect(/[^\r]\n/.test(ics)).toBe(false);
  });

  it("opens and closes the VCALENDAR envelope", () => {
    const lines = unfold(render([]));
    expect(lines[0]).toBe("BEGIN:VCALENDAR");
    expect(lines).toContain("VERSION:2.0");
    expect(lines).toContain("END:VCALENDAR");
  });

  it("folds lines longer than 75 octets with a leading space", () => {
    const ics = render([meal({ title: "x".repeat(200) })]);
    for (const line of ics.split("\r\n")) {
      expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    }
    // Folding is presentation only — unfolding restores the original value.
    expect(unfold(ics)).toContain(`SUMMARY:${"x".repeat(200)}`);
  });

  it("never splits a multi-byte character across a fold", () => {
    const ics = render([meal({ title: "é".repeat(80) })]);
    // A split mid-sequence would make this throw or produce U+FFFD.
    const roundTripped = new TextDecoder("utf-8", { fatal: true }).decode(
      new TextEncoder().encode(ics),
    );
    expect(roundTripped).toContain("é");
    expect(unfold(ics)).toContain(`SUMMARY:${"é".repeat(80)}`);
  });

  it("escapes backslash, semicolon, comma and newline in TEXT values", () => {
    const ics = render([
      meal({ title: String.raw`a,b;c\d`, recipeNames: ["one", "two"] }),
    ]);
    const lines = unfold(ics);
    expect(lines).toContain(String.raw`SUMMARY:a\,b\;c\\d`);
    // Recipe names are joined by a real newline, which must become a literal \n.
    expect(lines).toContain(
      String.raw`DESCRIPTION:one\ntwo\n820 kcal · $12.50`,
    );
  });
});

describe("renderIcs events", () => {
  it("emits an all-day VEVENT with the exclusive DTEND drizzle already gives us", () => {
    const lines = unfold(render([meal()]));
    expect(lines).toContain("DTSTART;VALUE=DATE:20260815");
    expect(lines).toContain("DTEND;VALUE=DATE:20260816");
    expect(lines).toContain("DTSTAMP:20260814T123456Z");
  });

  it("spans a multi-day task across its whole due range", () => {
    const lines = unfold(
      render([
        task({ startDate: "2026-08-20", endDateExclusive: "2026-08-24" }),
      ]),
    );
    expect(lines).toContain("DTSTART;VALUE=DATE:20260820");
    expect(lines).toContain("DTEND;VALUE=DATE:20260824");
  });

  it("scopes the UID to the serving host", () => {
    expect(unfold(render([meal()]))).toContain(
      "UID:MEL-4K7M@cubby.example.com",
    );
  });

  it("derives a stable UID from the shortcode so edits update in place", () => {
    const first = unfold(render([meal({ title: "Taco night" })]));
    const second = unfold(render([meal({ title: "Burrito night" })]));
    const uid = (lines: string[]) => lines.find((l) => l.startsWith("UID:"));
    expect(uid(first)).toBe(uid(second));
  });

  it("emits tasks as VEVENT, not VTODO", () => {
    // Calendar.app does not surface VTODOs from a subscribed feed — a VTODO
    // version of this renders as an empty calendar.
    const ics = render([task()]);
    expect(ics).toContain("BEGIN:VEVENT");
    expect(ics).not.toContain("VTODO");
  });

  it("omits completed tasks", () => {
    expect(render([task({ status: "done" })])).not.toContain("BEGIN:VEVENT");
    expect(render([task({ status: "in_progress" })])).toContain("BEGIN:VEVENT");
  });

  it("prefixes a task summary with its project", () => {
    const lines = unfold(render([task({ projectName: "Back deck" })]));
    expect(lines).toContain("SUMMARY:Back deck: Seal the deck");
  });

  it("links each event back to its detail page by shortcode", () => {
    const lines = unfold(render([meal(), task()]));
    expect(lines).toContain(`URL:${ORIGIN}/meals/MEL-4K7M`);
    expect(lines).toContain(`URL:${ORIGIN}/tasks/TSK-9H64`);
  });
});

describe("kindsForFeed", () => {
  it("narrows each feed to the kinds it publishes", () => {
    expect(kindsForFeed("meals")).toEqual(["meal"]);
    expect(kindsForFeed("tasks")).toEqual(["task"]);
    expect(kindsForFeed("all")).toEqual(["meal", "task"]);
  });
});
