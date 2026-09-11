import type { CalendarItem } from "@cubby/schemas/calendar";
import {
  calendarItemKind,
  calendarMealItem,
  calendarTaskItem,
} from "@cubby/schemas/calendar";
import { buildNutrition } from "@cubby/schemas/nutrition";
import { testShortcode } from "@cubby/schemas/testing";
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
      id: testShortcode("meal", "MEL-4K7M"),
      title: "Taco night",
      startDate: "2026-08-15",
      endDateExclusive: "2026-08-16",
      recipeNames: ["Carnitas"],
      mealTotals: {
        cost: {
          status: "complete",
          lower: 12.5,
          upper: null,
          coverage: { covered: 1, total: 1 },
        },
        nutrition: buildNutrition((key) =>
          key === "kcal"
            ? {
                status: "complete",
                lower: 820,
                upper: null,
                coverage: { covered: 1, total: 1 },
              }
            : { status: "unavailable", reason: "no_data" },
        ),
      },
      // Pinned, not generated: `mock` would otherwise pick a random slot/kind
      // per seed, and a non-cooked kind adds a DESCRIPTION line that every
      // other assertion here would have to account for.
      mealType: "dinner",
      mealKind: "cooked",
      ...overrides,
    },
  });

const task = (overrides: DeepPartial<TaskItem> = {}): TaskItem =>
  mock(calendarTaskItem, {
    seed: 1,
    overrides: {
      id: testShortcode("task", "TSK-9H64"),
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

  it.each(["x", "é", "界", "🍲", "\ud800"])(
    "preserves text and the octet limit when folding %s",
    (character) => {
      const title = `prefix-${character.repeat(100)}-suffix`;
      const ics = render([meal({ title })]);
      for (const line of ics.split("\r\n")) {
        expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
      }
      expect(unfold(ics)).toContain(`SUMMARY:${title}`);
    },
  );

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
  it("places a slotted meal at its slot's time, as a UTC DATE-TIME", () => {
    // Dinner is 7pm household-local; 2026-08-15 is PDT (UTC-7), so the instant
    // lands on the following UTC day. Half-hour block.
    const lines = unfold(render([meal()]));
    expect(lines).toContain("DTSTART:20260816T020000Z");
    expect(lines).toContain("DTEND:20260816T023000Z");
    expect(lines).toContain("DTSTAMP:20260814T123456Z");
  });

  it("resolves the same slot against standard time in winter", () => {
    // Same 7pm dinner, but PST (UTC-8) — the guard that the offset is looked up
    // per date rather than hardcoded to the summer one.
    const lines = unfold(
      render([
        meal({ startDate: "2026-01-15", endDateExclusive: "2026-01-16" }),
      ]),
    );
    expect(lines).toContain("DTSTART:20260116T030000Z");
    expect(lines).toContain("DTEND:20260116T033000Z");
  });

  it("leaves an unslotted meal an all-day event", () => {
    // No slot means no time of day was ever stated, so the feed must not invent
    // one — this stays the exclusive-DTEND all-day form.
    const lines = unfold(render([meal({ mealType: null })]));
    expect(lines).toContain("DTSTART;VALUE=DATE:20260815");
    expect(lines).toContain("DTEND;VALUE=DATE:20260816");
  });

  it("keeps tasks all-day: a task is due on a day, not at an hour", () => {
    const lines = unfold(render([task()]));
    expect(lines).toContain("DTSTART;VALUE=DATE:20260820");
    expect(lines).toContain("DTEND;VALUE=DATE:20260821");
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

  it("keeps the UID independent of the serving origin", () => {
    // A UID that followed the origin would make every event duplicate when a
    // subscription moves between localhost, a preview deploy, and production.
    const fromProd = unfold(
      renderIcs([meal()], { feed: "all", now: NOW, origin: ORIGIN }),
    );
    const fromLocal = unfold(
      renderIcs([meal()], {
        feed: "all",
        now: NOW,
        origin: "http://localhost:3000",
      }),
    );
    const uid = (lines: string[]) => lines.find((l) => l.startsWith("UID:"));
    expect(uid(fromProd)).toBe(uid(fromLocal));
    expect(uid(fromProd)).not.toContain("localhost");
    // The URL, by contrast, must follow the origin it was served from.
    expect(fromLocal).toContain("URL:http://localhost:3000/meals/MEL-4K7M");
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

  it("only ever names kinds the query layer can actually return", () => {
    // A feed asking for a kind outside the union would silently yield nothing:
    // `kinds` is passed straight through to getCalendarRange.
    const known = new Set<string>(calendarItemKind.options);
    for (const feed of ["meals", "tasks", "all"] as const) {
      for (const kind of kindsForFeed(feed)) {
        expect(known.has(kind)).toBe(true);
      }
    }
  });

  it("drops kinds the requested feed does not publish", () => {
    // Defence behind the query's `kinds` filter: even handed a task, a
    // meals-only feed must not emit it.
    const mealsOnly = renderIcs([task()], {
      feed: "meals",
      now: NOW,
      origin: ORIGIN,
    });
    expect(mealsOnly).not.toContain("BEGIN:VEVENT");
    expect(
      renderIcs([task()], { feed: "tasks", now: NOW, origin: ORIGIN }),
    ).toContain("BEGIN:VEVENT");
  });
});
