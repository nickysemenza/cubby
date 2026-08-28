import { describe, expect, it } from "vitest";

import {
  type ProductOwnershipTimeline,
  TOOL_TIMELINE_GRACE_DAYS,
  type ToolTimelineProjectWindow,
  toolTimelineConflict,
  UNKNOWN_OWNERSHIP,
} from "./tool-timeline";

const TODAY = "2026-08-03";

const window = (
  overrides: Partial<ToolTimelineProjectWindow>,
): ToolTimelineProjectWindow => ({
  effectiveStart: "2022-01-01",
  effectiveEnd: "2022-06-30",
  startSource: "explicit",
  endSource: "explicit",
  ...overrides,
});

const check = (
  ownership: {
    acquiredAt?: string | null;
    disposedAt?: string | null;
    intervals?: ProductOwnershipTimeline["intervals"];
    confidenceLostAt?: string | null;
  },
  win: ToolTimelineProjectWindow,
  isLive = false,
) => {
  const acquiredAt = ownership.acquiredAt ?? null;
  const intervals =
    ownership.intervals ??
    (acquiredAt === null
      ? []
      : [{ start: acquiredAt, end: ownership.disposedAt ?? TODAY }]);
  return toolTimelineConflict(
    {
      ...UNKNOWN_OWNERSHIP,
      acquiredAt,
      intervals,
      confidenceLostAt: ownership.confidenceLostAt ?? null,
    },
    win,
    {
      isLive,
      today: TODAY,
    },
  );
};

describe("toolTimelineConflict", () => {
  describe("unknown never blocks", () => {
    it("passes a tool with no acquisition and no disposal", () => {
      expect(check({}, window({}))).toBeNull();
    });

    it("passes when the project has no window on either side", () => {
      expect(
        check(
          { acquiredAt: "2030-01-01" },
          window({
            effectiveStart: null,
            effectiveEnd: null,
            startSource: "none",
            endSource: "none",
          }),
        ),
      ).toBeNull();
    });
  });

  describe("acquired after the project ended", () => {
    it("flags an acquisition past an explicit end with no grace", () => {
      const conflict = check(
        { acquiredAt: "2025-01-17" },
        window({ effectiveEnd: "2024-11-30", endSource: "explicit" }),
      );
      expect(conflict).toEqual({
        kind: "acquired_after_end",
        date: "2025-01-17",
        boundary: "2024-11-30",
      });
    });

    it("allows the same gap when the end is merely derived", () => {
      expect(
        check(
          { acquiredAt: "2022-07-20" },
          window({ effectiveEnd: "2022-06-30", endSource: "derived" }),
        ),
      ).toBeNull();
    });

    it("still flags a derived end once the grace is exhausted", () => {
      const conflict = check(
        { acquiredAt: "2022-08-01" },
        window({ effectiveEnd: "2022-06-30", endSource: "derived" }),
      );
      expect(conflict?.kind).toBe("acquired_after_end");
      expect(conflict?.boundary).toBe("2022-07-30");
      expect(TOOL_TIMELINE_GRACE_DAYS).toBe(30);
    });

    it("never flags a live project, whose end is not a statement", () => {
      expect(
        check(
          { acquiredAt: "2026-07-01" },
          window({ effectiveEnd: "2024-01-01", endSource: "explicit" }),
          true,
        ),
      ).toBeNull();
    });

    it("passes an acquisition exactly on the boundary", () => {
      expect(
        check(
          { acquiredAt: "2022-06-30" },
          window({ effectiveEnd: "2022-06-30" }),
        ),
      ).toBeNull();
    });
  });

  describe("disposed before the project started", () => {
    it("flags a disposal that predates an explicit start", () => {
      expect(
        check(
          { acquiredAt: "2018-01-01", disposedAt: "2021-05-01" },
          window({ effectiveStart: "2022-01-01", startSource: "explicit" }),
        ),
      ).toEqual({
        kind: "disposed_before_start",
        date: "2021-05-01",
        boundary: "2022-01-01",
      });
    });

    it("allows a disposal inside the grace on a derived start", () => {
      expect(
        check(
          { acquiredAt: "2018-01-01", disposedAt: "2021-12-15" },
          window({ effectiveStart: "2022-01-01", startSource: "derived" }),
        ),
      ).toBeNull();
    });

    it("passes a tool still owned, however old the project", () => {
      expect(
        check({ acquiredAt: "2018-01-01", disposedAt: null }, window({})),
      ).toBeNull();
    });

    it("checks a live project's start like any other", () => {
      expect(
        check(
          { acquiredAt: "2018-01-01", disposedAt: "2021-05-01" },
          window({ effectiveStart: "2022-01-01" }),
          true,
        ),
      ).toMatchObject({ kind: "disposed_before_start" });
    });

    it("flags a project inside a proven sell-and-rebuy gap", () => {
      const conflict = toolTimelineConflict(
        {
          acquiredAt: "2020-01-01",
          intervals: [
            { start: "2020-01-01", end: "2021-01-01" },
            { start: "2023-01-01", end: TODAY },
          ],
          confidenceLostAt: null,
        },
        window({
          effectiveStart: "2022-01-01",
          effectiveEnd: "2022-06-30",
        }),
        { isLive: false, today: TODAY },
      );

      expect(conflict).toEqual({
        kind: "disposed_before_start",
        date: "2021-01-01",
        boundary: "2022-01-01",
      });
    });
  });
});
