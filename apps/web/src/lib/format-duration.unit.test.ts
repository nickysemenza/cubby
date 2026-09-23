import { describe, expect, it } from "vitest";

import { formatDuration } from "./format-duration";

describe("formatDuration", () => {
  it("shows milliseconds, seconds, and minutes at the boundaries", () => {
    expect(formatDuration(999)).toBe("999ms");
    expect(formatDuration(1000)).toBe("1.0s");
    expect(formatDuration(12750)).toBe("12.8s");
    expect(formatDuration(60500)).toBe("1m 1s");
  });
});
