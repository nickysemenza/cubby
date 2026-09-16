import { describe, expect, it } from "vitest";

import { FLAGS } from "./flags";

describe("developer flags", () => {
  it("keeps TanStack devtools off by default in production", () => {
    expect(FLAGS.devtools).toBe(false);
  });
});
