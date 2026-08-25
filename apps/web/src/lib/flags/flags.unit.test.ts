import { describe, expect, it } from "vitest";
import { FLAGS, isDevBuildOnlyFlag } from "./flags";

describe("developer flags", () => {
  it("keeps TanStack devtools runtime-toggleable in production", () => {
    expect(FLAGS.devtools).toMatchObject({
      storageKey: "devtoolsVisible",
      default: false,
      group: "Developer",
    });
    expect(isDevBuildOnlyFlag("devtools")).toBe(false);
  });
});
