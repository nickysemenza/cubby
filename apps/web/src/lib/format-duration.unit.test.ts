import { describe, expect, it } from "vitest";

import { formatDuration, formatMinutesSeconds } from "./format-duration";

describe("formatDuration", () => {
  it("shows milliseconds, seconds, and minutes at the boundaries", () => {
    expect(formatDuration(999)).toBe("999ms");
    expect(formatDuration(1000)).toBe("1.0s");
    expect(formatDuration(12750)).toBe("12.8s");
    expect(formatDuration(60500)).toBe("1m 1s");
    expect(formatDuration(23_935_500)).toBe("6h 39m");
  });
});

describe("formatMinutesSeconds", () => {
  it("shows whole seconds under a minute and zero-padded seconds after", () => {
    expect(formatMinutesSeconds(-5)).toBe("0s");
    expect(formatMinutesSeconds(45_400)).toBe("45s");
    expect(formatMinutesSeconds(60_000)).toBe("1m 00s");
    expect(formatMinutesSeconds(187_000)).toBe("3m 07s");
  });
});
