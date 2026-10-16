import { describe, expect, it } from "vitest";

import { readDatabaseTiming } from "./read-performance-metrics";

describe("read evidence database timing", () => {
  it("reads the request collector's active-wall metrics rather than summed query durations", () => {
    expect(
      readDatabaseTiming(
        new Headers({
          "server-timing":
            'handler;dur=90, db-acquire;dur=12;desc="n=2 max=9 conc=2", db-query;dur=40;desc="n=7 max=30 conc=3", db-queue;dur=4',
        }),
      ),
    ).toEqual({
      sqlCount: 7,
      acquisitionMs: 12,
      queryActiveWallMs: 40,
      clientQueueActiveWallMs: 4,
    });
  });

  it("distinguishes an observed zero from absent, malformed, duplicate or streamed metrics", () => {
    const unavailable = {
      sqlCount: null,
      acquisitionMs: null,
      queryActiveWallMs: null,
      clientQueueActiveWallMs: null,
    };
    expect(readDatabaseTiming(new Headers())).toEqual(unavailable);
    const header = 'db-query;dur=0;desc="n=0 max=0 conc=0"';
    expect(
      readDatabaseTiming(new Headers({ "server-timing": header })).sqlCount,
    ).toBe(0);
    for (const value of [
      header + ", " + header,
      'db-query;dur=NaN;desc="n=7"',
      'db-query;dur=1;desc="n=-1"',
    ]) {
      expect(
        readDatabaseTiming(new Headers({ "server-timing": value })).sqlCount,
      ).toBeNull();
    }
    expect(
      readDatabaseTiming(
        new Headers({
          "server-timing": header,
          "content-type": "application/x-ndjson",
        }),
      ),
    ).toEqual(unavailable);
    expect(
      readDatabaseTiming(
        new Headers({
          "server-timing": header,
          "content-type": "text/event-stream; charset=utf-8",
        }),
      ),
    ).toEqual(unavailable);
  });
});
