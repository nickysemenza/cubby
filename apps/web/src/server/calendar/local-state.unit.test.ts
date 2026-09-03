import { describe, expect, it, vi } from "vitest";

import { Database } from "~/server/db";

import { InMemoryCalendarFeedState } from "./local-state";
import type { CalendarSnapshot } from "./snapshot";

const database = new Database(() => {
  throw new Error("Calendar state unit tests must not open a database");
});

const snapshot = (origin: string, revision: number): CalendarSnapshot => ({
  generatedAt: "2026-09-03T12:00:00.000Z",
  revision,
  counts: { meals: 1, tasks: 2, all: 3 },
  documents: {
    meals: {
      body: `meals:${origin}:${revision}`,
      etag: '"meals"',
      generatedAt: "2026-09-03T12:00:00.000Z",
      revision,
      itemCount: 1,
    },
    tasks: {
      body: `tasks:${origin}:${revision}`,
      etag: '"tasks"',
      generatedAt: "2026-09-03T12:00:00.000Z",
      revision,
      itemCount: 2,
    },
    all: {
      body: `all:${origin}:${revision}`,
      etag: '"all"',
      generatedAt: "2026-09-03T12:00:00.000Z",
      revision,
      itemCount: 3,
    },
  },
});

describe("in-memory calendar feed state", () => {
  it("rotates atomically, rejects the old token, and serves all variants", async () => {
    const builder = vi.fn(async (_db, options) =>
      snapshot(options.origin, options.revision),
    );
    const tokens = ["first", "second"];
    const state = new InMemoryCalendarFeedState(
      "https://one.example",
      database,
      () => new Date("2026-09-03T12:00:00.000Z"),
      () => tokens.shift() ?? "unexpected",
      builder,
    );

    expect(await state.getToken()).toBeNull();
    expect(await state.rotate()).toBe("first");
    expect(await state.read("first", "meals", null)).toMatchObject({
      result: "served",
      body: "meals:https://one.example:1",
    });
    expect(await state.read("first", "tasks", 'W/"tasks"')).toMatchObject({
      result: "not_modified",
    });
    expect(await state.read("first", "all", "*")).toMatchObject({
      result: "not_modified",
    });

    expect(await state.rotate()).toBe("second");
    expect(await state.read("first", "all", null)).toEqual({
      result: "not_found",
    });
    expect(await state.read("second", "all", null)).toMatchObject({
      result: "served",
      body: "all:https://one.example:2",
    });
  });

  it("keeps origins isolated", async () => {
    const builder = async (
      _db: Database,
      options: { origin: string; revision: number },
    ) => snapshot(options.origin, options.revision);
    const first = new InMemoryCalendarFeedState(
      "https://one.example",
      database,
      undefined,
      () => "one",
      builder,
    );
    const second = new InMemoryCalendarFeedState(
      "https://two.example",
      database,
      undefined,
      () => "two",
      builder,
    );
    await first.rotate();
    await second.rotate();
    expect(await first.read("two", "all", null)).toEqual({
      result: "not_found",
    });
    expect(await second.read("two", "all", null)).toMatchObject({
      body: "all:https://two.example:1",
    });
  });

  it("refreshes in place without rotating the token", async () => {
    const builder = vi.fn(async (_db, options) =>
      snapshot(options.origin, options.revision),
    );
    const state = new InMemoryCalendarFeedState(
      "https://one.example",
      database,
      undefined,
      () => "stable-token",
      builder,
    );
    await state.rotate();
    await expect(state.refreshNow("cron.daily")).resolves.toMatchObject({
      revision: 2,
    });
    expect(await state.getToken()).toBe("stable-token");
    expect(await state.read("stable-token", "all", null)).toMatchObject({
      body: "all:https://one.example:2",
    });
  });

  it("coalesces dirty signals and preserves the last good snapshot on failure", async () => {
    vi.useFakeTimers();
    const builder = vi
      .fn()
      .mockImplementationOnce(async (_db, options) =>
        snapshot(options.origin, options.revision),
      )
      .mockRejectedValueOnce(new Error("database unavailable"));
    const state = new InMemoryCalendarFeedState(
      "https://one.example",
      database,
      undefined,
      () => "token",
      builder,
    );
    await state.rotate();
    await state.markDirty("first");
    await state.markDirty("second");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(builder).toHaveBeenCalledTimes(2);
    expect(await state.read("token", "all", null)).toMatchObject({
      result: "served",
      body: "all:https://one.example:1",
    });
    vi.useRealTimers();
  });
});
